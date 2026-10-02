import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { useMediaStore } from '../../stores/useMediaStore';
import { acquireRecordOperation } from '../recordOperationLock';
import { flushMediaProgress } from '../mediaProgressStorage';
import { BackupCancellation, BackupError, BackupKeyProgress, decryptBackup, encryptBackup } from './crypto';
import { BackupPayload, getDecisions, mediaFingerprint, parseBackupPayload, planRestore, snapshotRecords } from './payload';

function check(cancelled?: BackupCancellation) { if (cancelled?.()) throw new BackupError('cancelled'); }
async function permission(kind: 'photo' | 'video') {
    const result = await MediaLibrary.getPermissionsAsync(false, [kind]);
    return result.granted ? result.accessPrivileges ?? 'all' : 'none';
}
async function enumerateAssets(kind: 'photo' | 'video', cancelled?: BackupCancellation,
    visit?: (asset: MediaLibrary.Asset) => void, collectIds = true) {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let after: string | undefined;
    do {
        check(cancelled);
        // Android getAssetInfoAsync also reads EXIF/location and can fail
        // without ACCESS_MEDIA_LOCATION. Backup only needs indexed metadata.
        const page = await MediaLibrary.getAssetsAsync({ mediaType: kind, first: 500, resolveWithFullInfo: false,
            ...(after ? { after } : {}) });
        for (const asset of page.assets) { if (collectIds) ids.add(asset.id); visit?.(asset); }
        if (!page.hasNextPage) return ids;
        if (!page.endCursor || cursors.has(page.endCursor)) throw new BackupError('unavailable');
        cursors.add(page.endCursor); after = page.endCursor;
    } while (true);
}

async function readVisible(rows: readonly { id: string; kind: 'photo' | 'video' }[], cancelled?: BackupCancellation) {
    const visible = new Map<string, MediaLibrary.Asset>();
    const scopes: { kind: 'photo' | 'video'; scope: string; granted: Set<string> | null }[] = [];
    for (const kind of ['photo', 'video'] as const) {
        const requested = rows.filter(row => row.kind === kind);
        if (requested.length === 0) continue;
        const scope = await permission(kind);
        if (scope === 'none') continue;
        const wanted = new Set(requested.map(row => row.id));
        // One paginated metadata pass, not thousands of native EXIF requests
        // or original-media downloads. Retain only the requested assets.
        const ids = await enumerateAssets(kind, cancelled, info => {
            if (!wanted.has(info.id) || info.mediaType !== kind) return;
            try {
                mediaFingerprint(info); // Reject incomplete metadata.
                visible.set(`${kind}:${info.id}`, {
                    id: info.id, filename: info.filename, uri: info.uri, mediaType: info.mediaType,
                    width: info.width, height: info.height, creationTime: info.creationTime,
                    modificationTime: info.modificationTime, duration: info.duration,
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

async function withTransfer<T>(task: () => Promise<T>): Promise<T> {
    const media = useMediaStore.getState();
    if (!media.hasHydrated || media.isConfirmingDeletion || media.isConfirmingVideoTrash) throw new BackupError('unavailable');
    const release = acquireRecordOperation('backup');
    if (!release) throw new BackupError('unavailable');
    try { await flushMediaProgress(); return await task(); }
    finally { release(); }
}

export async function createEncryptedRecords(password: string, cancelled?: BackupCancellation, onProgress?: BackupKeyProgress) {
    return withTransfer(async () => {
        if (Platform.OS !== 'android' && Platform.OS !== 'ios') throw new BackupError('unavailable');
        const rows = getDecisions(snapshotRecords(useMediaStore.getState()));
        const visible = await readVisible(rows, cancelled);
        const records = rows.flatMap(row => {
            const asset = visible.get(`${row.kind}:${row.id}`);
            return asset ? [{ ...row, fingerprint: mediaFingerprint(asset) }] : [];
        });
        check(cancelled);
        const payload: BackupPayload = { version: 1, platform: Platform.OS, records };
        return { bytes: await encryptBackup(payload, password, cancelled, onProgress), saved: records.length, skipped: rows.length - records.length };
    });
}

export async function openEncryptedRecords(bytes: Uint8Array, password: string, cancelled?: BackupCancellation, onProgress?: BackupKeyProgress) {
    return withTransfer(async () => {
        const payload = parseBackupPayload(await decryptBackup(bytes, password, cancelled, onProgress), Platform.OS);
        const visible = await readVisible(payload.records, cancelled);
        check(cancelled);
        return { payload, preview: planRestore(payload, useMediaStore.getState(), visible, false).preview };
    });
}

export async function restoreEncryptedRecords(payload: BackupPayload, includePending: boolean, cancelled?: BackupCancellation) {
    return withTransfer(async () => {
        parseBackupPayload(payload, Platform.OS);
        // Revalidate on confirm: previews can remain open while the gallery
        // or permissions change. Never trust URIs from a backup file.
        const visible = await readVisible(payload.records, cancelled);
        check(cancelled);
        const current = useMediaStore.getState();
        if (current.isConfirmingDeletion || current.isConfirmingVideoTrash) throw new BackupError('unavailable');
        const { merged, preview } = planRestore(payload, current, visible, includePending);
        useMediaStore.setState({ ...merged, photos: [], videos: [], currentIndex: 0, videoCurrentIndex: 0,
            hiddenPhotoQueuedAssetIds: null, hiddenVideoQueuedAssetIds: null });
        current.clearLoadedMedia(); // Invalidate asynchronous feed loads too.
        await flushMediaProgress();
        await current.refreshTotalCounts();
        current.notifyMediaLibraryRefresh();
        return preview;
    });
}
