import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { useMediaStore } from '../../stores/useMediaStore';
import { acquireRecordOperation } from '../recordOperationLock';
import { flushMediaProgress } from '../mediaProgressStorage';
import { BackupCancellation, BackupError, decryptBackup, encryptBackup } from './crypto';
import { BackupPayload, getDecisions, mediaFingerprint, parseBackupPayload, planRestore, snapshotRecords } from './payload';

function check(cancelled?: BackupCancellation) { if (cancelled?.()) throw new BackupError('cancelled'); }
async function permission(kind: 'photo' | 'video') {
    const result = await MediaLibrary.getPermissionsAsync(false, [kind]);
    return result.granted ? result.accessPrivileges ?? 'all' : 'none';
}
async function limitedIds(kind: 'photo' | 'video', cancelled?: BackupCancellation) {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let after: string | undefined;
    do {
        check(cancelled);
        const page = await MediaLibrary.getAssetsAsync({ mediaType: kind, first: 500, ...(after ? { after } : {}) });
        for (const asset of page.assets) ids.add(asset.id);
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
        const granted = scope === 'limited' ? await limitedIds(kind, cancelled) : null;
        scopes.push({ kind, scope, granted });
        // Bounded native calls; a large library must not launch thousands of
        // simultaneous requests or download originals from a cloud provider.
        for (let i = 0; i < requested.length; i += 8) {
            check(cancelled);
            await Promise.all(requested.slice(i, i + 8).map(async row => {
                if (granted && !granted.has(row.id)) return;
                try {
                    const info = await MediaLibrary.getAssetInfoAsync(row.id, { shouldDownloadFromNetwork: false });
                    if (info.id !== row.id || info.mediaType !== kind) return;
                    mediaFingerprint(info); // Reject incomplete metadata.
                    // Do not carry location/EXIF fields from AssetInfo into
                    // persisted queues when rebuilding a decision.
                    visible.set(`${kind}:${row.id}`, {
                        id: info.id, filename: info.filename, uri: info.uri, mediaType: info.mediaType,
                        width: info.width, height: info.height, creationTime: info.creationTime,
                        modificationTime: info.modificationTime, duration: info.duration,
                        ...(info.albumId ? { albumId: info.albumId } : {}),
                    });
                } catch { /* Deleted, hidden or unreadable media is skipped. */ }
            }));
        }
    }
    // Validate both media scopes after the entire read, including a photo
    // revocation that happened while video metadata was being fetched.
    for (const { kind, scope, granted } of scopes) {
        check(cancelled);
        if (await permission(kind) !== scope) throw new BackupError('unavailable');
        if (granted) {
            const latest = await limitedIds(kind, cancelled);
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

export async function createEncryptedRecords(password: string, cancelled?: BackupCancellation) {
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
        return { bytes: await encryptBackup(payload, password, cancelled), saved: records.length, skipped: rows.length - records.length };
    });
}

export async function openEncryptedRecords(bytes: Uint8Array, password: string, cancelled?: BackupCancellation) {
    return withTransfer(async () => {
        const payload = parseBackupPayload(await decryptBackup(bytes, password, cancelled), Platform.OS);
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
        current.notifyMediaLibraryRefresh();
        return preview;
    });
}
