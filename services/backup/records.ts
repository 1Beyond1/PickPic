import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { useMediaStore } from '../../stores/useMediaStore';
import { acquireRecordOperation } from '../recordOperationLock';
import { flushMediaProgress } from '../mediaProgressStorage';
import { retainPendingDeletionInfo } from '../pendingDeletion';
import { fetchProtectedAlbumsSnapshot, loadProtectedAlbums, mergeProtectedAlbums } from '../protectedAlbums';
import { getAllReviewIgnores, mergeReviewIgnores } from '../reviewIgnores';
import { readMediaSizes, supportsIndexedMediaSizes } from '../mediaSizes';
import { BackupCancellation, BackupError, BackupKeyProgress, decryptBackup, encryptBackup } from './crypto';
import {
    BackupPayload,
    BackupPayloadV2,
    BackupReviewIgnore,
    buildContentFingerprint,
    getDecisions,
    mediaFingerprint,
    parseBackupPayload,
    planRestore,
    snapshotRecords,
} from './payload';

function check(cancelled?: BackupCancellation) { if (cancelled?.()) throw new BackupError('cancelled'); }

async function permission(kind: 'photo' | 'video') {
    const result = await MediaLibrary.getPermissionsAsync(false, [kind]);
    return result.granted ? result.accessPrivileges ?? 'all' : 'none';
}

async function enumerateAssets(
    kind: 'photo' | 'video',
    cancelled?: BackupCancellation,
    visit?: (asset: MediaLibrary.Asset) => void,
    collectIds = true,
) {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let after: string | undefined;
    do {
        check(cancelled);
        // Android getAssetInfoAsync also reads EXIF/location and can fail
        // without ACCESS_MEDIA_LOCATION. Backup only needs indexed metadata.
        const page = await MediaLibrary.getAssetsAsync({
            mediaType: kind,
            first: 500,
            resolveWithFullInfo: false,
            ...(after ? { after } : {}),
        });
        for (const asset of page.assets) { if (collectIds) ids.add(asset.id); visit?.(asset); }
        if (!page.hasNextPage) return ids;
        if (!page.endCursor || cursors.has(page.endCursor)) throw new BackupError('unavailable');
        cursors.add(page.endCursor);
        after = page.endCursor;
    } while (true);
}

async function readVisible(
    rows: readonly { id: string; kind: 'photo' | 'video' }[],
    cancelled?: BackupCancellation,
    options: { includeAllOfKinds?: ReadonlySet<'photo' | 'video'> } = {},
) {
    const visible = new Map<string, MediaLibrary.Asset>();
    const scopes: { kind: 'photo' | 'video'; scope: string; granted: Set<string> | null }[] = [];
    for (const kind of ['photo', 'video'] as const) {
        const requested = rows.filter(row => row.kind === kind);
        const includeAll = !!options.includeAllOfKinds?.has(kind);
        if (requested.length === 0 && !includeAll) continue;
        const scope = await permission(kind);
        if (scope === 'none') continue;
        const wanted = includeAll ? null : new Set(requested.map(row => row.id));
        // One paginated metadata pass, not thousands of native EXIF requests
        // or original-media downloads.
        const ids = await enumerateAssets(kind, cancelled, info => {
            if ((wanted && !wanted.has(info.id)) || info.mediaType !== kind) return;
            try {
                mediaFingerprint(info); // Reject incomplete metadata.
                visible.set(`${kind}:${info.id}`, {
                    id: info.id,
                    filename: info.filename,
                    uri: info.uri,
                    mediaType: info.mediaType,
                    width: info.width,
                    height: info.height,
                    creationTime: info.creationTime,
                    modificationTime: info.modificationTime,
                    duration: info.duration,
                    ...(info.albumId ? { albumId: info.albumId } : {}),
                });
            } catch { /* Incomplete or unreadable metadata is skipped. */ }
        }, scope === 'limited');
        scopes.push({ kind, scope, granted: scope === 'limited' ? ids : null });
    }
    // Validate both media scopes after the entire read, including a photo
    // revocation that happened while video metadata was being fetched.
    for (const { kind, scope, granted } of scopes) {
        check(cancelled);
        if (await permission(kind) !== scope) throw new BackupError('unavailable');
        if (granted) {
            const latest = await enumerateAssets(kind, cancelled);
            if (latest.size !== granted.size || [...latest].some(id => !granted.has(id))) throw new BackupError('unavailable');
        }
    }
    return visible;
}

async function readSizesForVisible(
    visible: ReadonlyMap<string, MediaLibrary.Asset>,
    cancelled?: BackupCancellation,
): Promise<Map<string, number | null>> {
    const sizes = new Map<string, number | null>();
    if (!supportsIndexedMediaSizes()) return sizes;

    for (const kind of ['photo', 'video'] as const) {
        check(cancelled);
        const numericIds: string[] = [];
        for (const asset of visible.values()) {
            if (asset.mediaType === kind && /^[1-9][0-9]{0,18}$/.test(asset.id)) {
                numericIds.push(asset.id);
            }
        }
        if (numericIds.length === 0) continue;
        const result = await readMediaSizes(kind, numericIds, () => !cancelled?.());
        if (result.status === 'ready') {
            for (const [id, bytes] of result.sizes) {
                sizes.set(`${kind}:${id}`, bytes);
            }
        }
    }
    return sizes;
}

async function readLocalAlbumsSafe(): Promise<{ id: string; title: string }[] | undefined> {
    if (typeof MediaLibrary.getAlbumsAsync !== 'function') return undefined;
    try {
        const permissionState = await MediaLibrary.getPermissionsAsync(false, ['photo']);
        if (!permissionState.granted) return [];
        if (Platform.OS === 'ios' && permissionState.accessPrivileges !== 'all') return undefined;
        const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
        return albums.map(album => ({ id: album.id, title: album.title }));
    } catch {
        return undefined;
    }
}

async function withTransfer<T>(task: () => Promise<T>): Promise<T> {
    const media = useMediaStore.getState();
    if (!media.hasHydrated || media.isConfirmingDeletion || media.isConfirmingVideoTrash) throw new BackupError('unavailable');
    const release = acquireRecordOperation('backup');
    if (!release) throw new BackupError('unavailable');
    try { await flushMediaProgress(); return await task(); }
    finally { release(); }
}

function getKindsForPayload(payload: BackupPayload): Set<'photo' | 'video'> {
    const kinds = new Set<'photo' | 'video'>();
    for (const record of payload.records) kinds.add(record.kind);
    if (payload.version === 2 && payload.reviewIgnores.some(ignore => ignore.ignoreType === 'blur')) {
        kinds.add('photo');
    }
    return kinds;
}

export async function createEncryptedRecords(
    password: string,
    cancelled?: BackupCancellation,
    onProgress?: BackupKeyProgress,
) {
    return withTransfer(async () => {
        if (Platform.OS !== 'android' && Platform.OS !== 'ios') throw new BackupError('unavailable');
        const rows = getDecisions(snapshotRecords(useMediaStore.getState()));
        const [protectedAlbums, storedIgnores] = await Promise.all([
            loadProtectedAlbums(),
            getAllReviewIgnores(),
        ]);
        const storeSimilarIgnores = useMediaStore.getState().ignoredSimilarGroupKeys ?? [];
        const ignoreMap = new Map<string, (typeof storedIgnores)[number]>();
        for (const ignore of storedIgnores) {
            ignoreMap.set(`${ignore.ignoreType}:${ignore.targetKey}`, ignore);
        }
        const now = Date.now();
        for (const rawKey of storeSimilarIgnores) {
            const targetKey = typeof rawKey === 'string' ? rawKey.trim() : '';
            if (!targetKey || targetKey.length > 512) continue;
            const composite = `similar_group:${targetKey}`;
            if (!ignoreMap.has(composite)) {
                ignoreMap.set(composite, { ignoreType: 'similar_group', targetKey, createdAt: now });
            }
        }
        const mergedStoredIgnores = Array.from(ignoreMap.values());
        const blurIgnoreRows = mergedStoredIgnores
            .filter(ignore => ignore.ignoreType === 'blur')
            .map(ignore => ({ id: ignore.targetKey, kind: 'photo' as const }));
        const visible = await readVisible([...rows, ...blurIgnoreRows], cancelled);
        const sizes = await readSizesForVisible(visible, cancelled);

        const records = rows.flatMap(row => {
            const key = `${row.kind}:${row.id}`;
            const asset = visible.get(key);
            if (!asset) return [];
            return [{
                ...row,
                fingerprint: mediaFingerprint(asset),
                contentFingerprint: buildContentFingerprint(asset, sizes.get(key) ?? null),
            }];
        });

        const reviewIgnores: BackupReviewIgnore[] = mergedStoredIgnores.map(ignore => {
            if (ignore.ignoreType === 'blur') {
                const key = `photo:${ignore.targetKey}`;
                const asset = visible.get(key);
                if (asset) {
                    return {
                        ignoreType: ignore.ignoreType,
                        targetKey: ignore.targetKey,
                        createdAt: ignore.createdAt,
                        contentFingerprint: buildContentFingerprint(asset, sizes.get(key) ?? null),
                    };
                }
            }
            return {
                ignoreType: ignore.ignoreType,
                targetKey: ignore.targetKey,
                createdAt: ignore.createdAt,
            };
        });

        check(cancelled);
        const payload: BackupPayloadV2 = {
            version: 2,
            platform: Platform.OS,
            records,
            protectedAlbums,
            reviewIgnores,
        };
        return {
            bytes: await encryptBackup(payload, password, cancelled, onProgress),
            saved: records.length,
            skipped: rows.length - records.length,
            protectedAlbums: protectedAlbums.length,
            reviewIgnores: reviewIgnores.length,
        };
    });
}

export async function decryptAndParseBackup(
    bytes: Uint8Array,
    password: string,
    cancelled?: BackupCancellation,
    onProgress?: BackupKeyProgress,
): Promise<BackupPayload> {
    return parseBackupPayload(await decryptBackup(bytes, password, cancelled, onProgress), Platform.OS);
}

function getCurrentTargetPlatform(): 'android' | 'ios' | undefined {
    return Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : undefined;
}

async function resolveProtectedRestoreGuard(
    payload: BackupPayload,
    localAlbums: readonly { id: string; title: string }[] | undefined,
    existingProtected: readonly { albumId: string; title: string }[],
    targetPlatform: 'android' | 'ios' | undefined,
): Promise<{ protectedAssetIds: Set<string>; blockPendingDeletions: boolean }> {
    const candidateAlbumIds = new Set<string>(existingProtected.map(item => item.albumId));
    if (payload.version === 2) {
        const samePlatform = !targetPlatform || payload.platform === targetPlatform;
        const localById = new Map((localAlbums ?? []).map(album => [album.id, album]));
        const localByTitle = new Map<string, { id: string; title: string }[]>();
        for (const album of localAlbums ?? []) {
            const key = album.title.trim();
            const list = localByTitle.get(key);
            if (list) list.push(album);
            else localByTitle.set(key, [album]);
        }
        for (const album of payload.protectedAlbums) {
            if (localAlbums) {
                const direct = samePlatform ? localById.get(album.albumId) : undefined;
                if (direct) {
                    candidateAlbumIds.add(direct.id);
                } else {
                    const matches = localByTitle.get(album.title.trim()) ?? [];
                    if (matches.length === 1) candidateAlbumIds.add(matches[0].id);
                }
            } else if (samePlatform) {
                candidateAlbumIds.add(album.albumId);
            }
        }
    }

    const protectedAssetIds = new Set<string>(useMediaStore.getState().protectedAssetIds ?? []);
    if (candidateAlbumIds.size === 0) {
        return { protectedAssetIds, blockPendingDeletions: false };
    }

    const hasPendingDeletes = payload.records.some(record => record.decision === 'delete');
    if (!hasPendingDeletes) {
        return { protectedAssetIds, blockPendingDeletions: false };
    }

    try {
        const snapshot = await fetchProtectedAlbumsSnapshot(Array.from(candidateAlbumIds), ['photo', 'video']);
        return { protectedAssetIds: snapshot.assetIds, blockPendingDeletions: false };
    } catch {
        // Fail-closed: protected albums exist, but live verification failed, so
        // never enqueue restored pending deletions until protection can be verified.
        return { protectedAssetIds, blockPendingDeletions: true };
    }
}

export async function openEncryptedRecords(
    bytes: Uint8Array,
    password: string,
    cancelled?: BackupCancellation,
    onProgress?: BackupKeyProgress,
) {
    return withTransfer(async () => {
        const payload = parseBackupPayload(await decryptBackup(bytes, password, cancelled, onProgress), Platform.OS);
        const targetPlatform = getCurrentTargetPlatform();
        const includeAllOfKinds = payload.version === 2 ? getKindsForPayload(payload) : undefined;
        const visible = await readVisible(payload.records, cancelled, { includeAllOfKinds });
        const localSizes = payload.version === 2 ? await readSizesForVisible(visible, cancelled) : undefined;
        const existingProtected = await loadProtectedAlbums();
        const [localAlbums, existingIgnores] = payload.version === 2
            ? await Promise.all([
                readLocalAlbumsSafe(),
                getAllReviewIgnores(),
            ])
            : [undefined, []];
        const { protectedAssetIds, blockPendingDeletions } = await resolveProtectedRestoreGuard(
            payload,
            localAlbums,
            existingProtected,
            targetPlatform,
        );
        check(cancelled);
        const existingIgnoreSet = new Set<string>([
            ...existingIgnores.map(item => `${item.ignoreType}:${item.targetKey}`),
            ...(useMediaStore.getState().ignoredSimilarGroupKeys ?? []).map(key => `similar_group:${key}`),
        ]);
        const { preview } = planRestore(payload, useMediaStore.getState(), visible, false, {
            localSizes,
            localAlbums,
            existingProtectedAlbumIds: new Set(existingProtected.map(item => item.albumId)),
            existingReviewIgnores: existingIgnoreSet,
            targetPlatform,
            protectedAssetIds,
            blockPendingDeletions,
        });
        return { payload, preview };
    });
}

export async function restoreEncryptedRecords(
    payload: BackupPayload,
    includePending: boolean,
    cancelled?: BackupCancellation,
) {
    return withTransfer(async () => {
        parseBackupPayload(payload, Platform.OS);
        const targetPlatform = getCurrentTargetPlatform();
        // Revalidate on confirm: previews can remain open while the gallery
        // or permissions change. Never trust URIs from a backup file.
        const includeAllOfKinds = payload.version === 2 ? getKindsForPayload(payload) : undefined;
        const visible = await readVisible(payload.records, cancelled, { includeAllOfKinds });
        const localSizes = payload.version === 2 ? await readSizesForVisible(visible, cancelled) : undefined;
        const existingProtected = await loadProtectedAlbums();
        const [localAlbums, existingIgnores] = payload.version === 2
            ? await Promise.all([
                readLocalAlbumsSafe(),
                getAllReviewIgnores(),
            ])
            : [undefined, []];
        const { protectedAssetIds, blockPendingDeletions } = await resolveProtectedRestoreGuard(
            payload,
            localAlbums,
            existingProtected,
            targetPlatform,
        );
        check(cancelled);
        const current = useMediaStore.getState();
        if (current.isConfirmingDeletion || current.isConfirmingVideoTrash) throw new BackupError('unavailable');

        const existingIgnoreSet = new Set<string>([
            ...existingIgnores.map(item => `${item.ignoreType}:${item.targetKey}`),
            ...(current.ignoredSimilarGroupKeys ?? []).map(key => `similar_group:${key}`),
        ]);
        const { merged, preview, protectedAlbumsToMerge, reviewIgnoresToMerge } = planRestore(
            payload,
            current,
            visible,
            includePending,
            {
                localSizes,
                localAlbums,
                existingProtectedAlbumIds: new Set(existingProtected.map(item => item.albumId)),
                existingReviewIgnores: existingIgnoreSet,
                targetPlatform,
                protectedAssetIds,
                blockPendingDeletions,
            },
        );
        const mergedPhotoQueuedIds = new Set([...merged.deleteQueue, ...merged.collectionQueue].map(asset => asset.id));
        const mergedVideoQueuedIds = new Set(merged.videoTrashBin.map(asset => asset.id));
        const visiblePhotoIds = new Set(
            [...visible.values()].filter(asset => asset.mediaType === 'photo').map(asset => asset.id),
        );
        const visibleVideoIds = new Set(
            [...visible.values()].filter(asset => asset.mediaType === 'video').map(asset => asset.id),
        );
        const hiddenPhotoQueuedAssetIds = current.permissionScope === 'full'
            ? null
            : current.hiddenPhotoQueuedAssetIds == null
                ? (current.permissionScope
                    ? [...mergedPhotoQueuedIds].filter(id => !visiblePhotoIds.has(id))
                    : null)
                : Array.from(new Set(
                    current.hiddenPhotoQueuedAssetIds.filter(
                        id => mergedPhotoQueuedIds.has(id) && !visiblePhotoIds.has(id),
                    ),
                ));
        const hiddenVideoQueuedAssetIds = current.hiddenVideoQueuedAssetIds == null
            ? null
            : Array.from(new Set(
                current.hiddenVideoQueuedAssetIds.filter(
                    id => mergedVideoQueuedIds.has(id) && !visibleVideoIds.has(id),
                ),
            ));

        const restoredSimilarIgnoreKeys = reviewIgnoresToMerge
            .filter(item => item.ignoreType === 'similar_group')
            .map(item => item.targetKey);
        const existingSimilarIgnoreKeys = current.ignoredSimilarGroupKeys ?? [];
        const mergedSimilarIgnoreKeys = restoredSimilarIgnoreKeys.length > 0
            ? Array.from(new Set([...existingSimilarIgnoreKeys, ...restoredSimilarIgnoreKeys])).slice(-2000)
            : existingSimilarIgnoreKeys;

        // Snapshot pre-restore in-memory state so any persistence failure rolls
        // back atomically instead of leaving unpersisted records in UI memory.
        const previousSnapshot = {
            photoProcessedIds: current.photoProcessedIds,
            videoProcessedIds: current.videoProcessedIds,
            deleteQueue: current.deleteQueue,
            collectionQueue: current.collectionQueue,
            videoTrashBin: current.videoTrashBin,
            pendingDeletionInfo: current.pendingDeletionInfo,
            recentDecisions: current.recentDecisions,
            organizingSessions: current.organizingSessions,
            photoSessionRecoveryStatus: current.photoSessionRecoveryStatus,
            photoSessionUnavailableCount: current.photoSessionUnavailableCount,
            videoSessionRecoveryStatus: current.videoSessionRecoveryStatus,
            videoSessionUnavailableCount: current.videoSessionUnavailableCount,
            ignoredSimilarGroupKeys: current.ignoredSimilarGroupKeys,
            lastDeletionResult: current.lastDeletionResult,
            photos: current.photos,
            videos: current.videos,
            currentIndex: current.currentIndex,
            videoCurrentIndex: current.videoCurrentIndex,
            hiddenPhotoQueuedAssetIds: current.hiddenPhotoQueuedAssetIds,
            hiddenVideoQueuedAssetIds: current.hiddenVideoQueuedAssetIds,
        };

        // Write v2 SQLCipher tables BEFORE mutating in-memory store state so a
        // SQLCipher failure never leaves in-memory state ahead of persistence.
        if (payload.version === 2) {
            if (protectedAlbumsToMerge.length > 0) {
                await mergeProtectedAlbums(protectedAlbumsToMerge);
            }
            if (reviewIgnoresToMerge.length > 0) {
                await mergeReviewIgnores(reviewIgnoresToMerge);
            }
        }

        // Backups do not contain an undo journal or organizing sessions.
        // Clear stale sessions/recovery state while preserving limited-access
        // hidden-queue protection, then await durable persistence before
        // publishing refresh signals (rolling back memory on write failure).
        useMediaStore.setState({
            ...merged,
            recentDecisions: [],
            organizingSessions: { photo: null, video: null },
            photoSessionRecoveryStatus: null,
            photoSessionUnavailableCount: 0,
            videoSessionRecoveryStatus: null,
            videoSessionUnavailableCount: 0,
            pendingDeletionInfo: retainPendingDeletionInfo({
                deleteQueue: merged.deleteQueue,
                videoTrashBin: merged.videoTrashBin,
                pendingDeletionInfo: current.pendingDeletionInfo ?? {},
            }),
            ...(restoredSimilarIgnoreKeys.length > 0 ? { ignoredSimilarGroupKeys: mergedSimilarIgnoreKeys } : {}),
            lastDeletionResult: null,
            photos: [],
            videos: [],
            currentIndex: 0,
            videoCurrentIndex: 0,
            hiddenPhotoQueuedAssetIds,
            hiddenVideoQueuedAssetIds,
        });

        try {
            await flushMediaProgress();
        } catch (error) {
            useMediaStore.setState(previousSnapshot);
            throw error;
        }

        if (payload.version === 2 && protectedAlbumsToMerge.length > 0) {
            await useMediaStore.getState().loadProtectedAlbums?.();
        }

        current.clearLoadedMedia(); // Invalidate asynchronous feed loads too.
        await current.refreshTotalCounts();
        current.notifyMediaLibraryRefresh();
        return preview;
    });
}
