jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetInfoAsync: jest.fn(), getAssetsAsync: jest.fn(), deleteAssetsAsync: jest.fn() }));
jest.mock('../../stores/useMediaStore', () => ({ useMediaStore: { getState: jest.fn(), setState: jest.fn() } }));
jest.mock('../../services/mediaProgressStorage', () => ({ flushMediaProgress: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/backup/crypto', () => {
    const original = jest.requireActual('../../services/backup/crypto');
    return { ...original, encryptBackup: jest.fn().mockResolvedValue(new Uint8Array([1, 2])), decryptBackup: jest.fn() };
});
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn() }));
import { TextEncoder } from 'node:util';
import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { useMediaStore } from '../../stores/useMediaStore';
import { decryptBackup, encryptBackup } from '../../services/backup/crypto';
import { mediaFingerprint } from '../../services/backup/payload';
import { createEncryptedRecords, openEncryptedRecords, restoreEncryptedRecords } from '../../services/backup/records';
import { acquireRecordOperation } from '../../services/recordOperationLock';
Object.assign(globalThis, { TextEncoder });
const photo = { id: 'one', filename: 'private.jpg', uri: 'file:///private.jpg', mediaType: 'photo', width: 100, height: 100,
    creationTime: 100, modificationTime: 200, duration: 0 } as MediaLibrary.Asset;
const file = () => ({ version: 1 as const, platform: 'android' as const,
    records: [{ id: 'one', kind: 'photo' as const, decision: 'delete' as const, fingerprint: mediaFingerprint(photo) }] });
let state: any;
beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    state = { hasHydrated: true, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
        photoProcessedIds: [], videoProcessedIds: [], deleteQueue: [], collectionQueue: [], videoTrashBin: [],
        clearLoadedMedia: jest.fn(), refreshTotalCounts: jest.fn().mockResolvedValue(undefined), notifyMediaLibraryRefresh: jest.fn() };
    jest.mocked(useMediaStore.getState).mockImplementation(() => state);
    jest.mocked(useMediaStore.setState).mockImplementation((next: any) => { Object.assign(state, next); });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockResolvedValue({ ...photo, location: { latitude: 1, longitude: 2 } } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [{ ...photo, location: { latitude: 1, longitude: 2 }, exif: {} }], hasNextPage: false } as any);
    jest.mocked(decryptBackup).mockResolvedValue(file());
});
it('does not mutate records before authentication and schema validation succeed', async () => {
    jest.mocked(decryptBackup).mockRejectedValueOnce(new Error('authentication failed'));
    await expect(openEncryptedRecords(new Uint8Array(), 'secret')).rejects.toThrow();
    jest.mocked(decryptBackup).mockResolvedValueOnce({ version: 999 });
    await expect(openEncryptedRecords(new Uint8Array(), 'secret')).rejects.toThrow();
    expect(useMediaStore.setState).not.toHaveBeenCalled();
    expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
    expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
});
it('previews without mutation, then rechecks access on confirm without deleting media', async () => {
    const opened = await openEncryptedRecords(new Uint8Array(), 'secret');
    expect(opened.preview.pendingDeletion).toBe(1);
    expect(useMediaStore.setState).not.toHaveBeenCalled();
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: false } as any);
    const result = await restoreEncryptedRecords(opened.payload, true);
    expect(result.skipped).toBe(1); expect(state.photoProcessedIds).toEqual([]);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
it('restores the pending queue only on opt-in and strips location/EXIF fields', async () => {
    await restoreEncryptedRecords(file(), false);
    expect(state.photoProcessedIds).toEqual([]);
    await restoreEncryptedRecords(file(), true);
    expect(state.photoProcessedIds).toEqual(['one']);
    expect(state.deleteQueue).toEqual([photo]);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
it('refreshes totals invalidated by clearing the feeds before announcing restored records', async () => {
    state.totalPhotos = 1;
    state.clearLoadedMedia.mockImplementation(() => { state.totalPhotos = 0; });
    state.refreshTotalCounts.mockImplementation(async () => { state.totalPhotos = 1; });
    await restoreEncryptedRecords(file(), true);
    expect(state.photoProcessedIds).toEqual(['one']);
    expect(state.totalPhotos).toBe(1);
    expect(state.clearLoadedMedia.mock.invocationCallOrder[0]).toBeLessThan(state.refreshTotalCounts.mock.invocationCallOrder[0]);
    expect(state.refreshTotalCounts.mock.invocationCallOrder[0]).toBeLessThan(state.notifyMediaLibraryRefresh.mock.invocationCallOrder[0]);
});
it('rejects selection changes during a limited-permission read', async () => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce({ assets: [photo], hasNextPage: false } as any)
        .mockResolvedValueOnce({ assets: [], hasNextPage: false } as any);
    await expect(restoreEncryptedRecords(file(), true)).rejects.toThrow();
    expect(useMediaStore.setState).not.toHaveBeenCalled();
});
it('rejects a same-size replacement of the limited selection', async () => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce({ assets: [photo], hasNextPage: false } as any)
        .mockResolvedValueOnce({ assets: [{ ...photo, id: 'replacement' }], hasNextPage: false } as any);
    await expect(restoreEncryptedRecords(file(), true)).rejects.toMatchObject({ code: 'unavailable' });
    expect(useMediaStore.setState).not.toHaveBeenCalled();
});
it('rechecks photo access after the video pass rather than only immediately after photos', async () => {
    const video = { ...photo, id: 'video', filename: 'video.mp4', mediaType: 'video', duration: 10 } as MediaLibrary.Asset;
    const payload = { ...file(), records: [...file().records,
        { id: video.id, kind: 'video' as const, decision: 'keep' as const, fingerprint: mediaFingerprint(video) }] };
    let photoChecks = 0;
    jest.mocked(MediaLibrary.getPermissionsAsync).mockImplementation(async (_write, kind) => {
        const granted = kind?.[0] !== 'photo' || ++photoChecks === 1;
        return { granted, accessPrivileges: granted ? 'all' : 'none' } as any;
    });
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async options => ({
        assets: options?.mediaType === 'video' ? [video] : [photo], hasNextPage: false,
    } as any));
    await expect(restoreEncryptedRecords(payload, true)).rejects.toMatchObject({ code: 'unavailable' });
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'video' }));
    expect(useMediaStore.setState).not.toHaveBeenCalled();
});
it('rechecks edited metadata on confirmation and skips it without restoring a pending deletion', async () => {
    const opened = await openEncryptedRecords(new Uint8Array(), 'secret');
    expect(opened.preview.pendingDeletion).toBe(1);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [{ ...photo, modificationTime: 201 }], hasNextPage: false } as any);
    const result = await restoreEncryptedRecords(opened.payload, true);
    expect(result.skipped).toBe(1);
    expect(state.photoProcessedIds).toEqual([]);
    expect(state.deleteQueue).toEqual([]);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
it('exports only bounded decision metadata inside the encrypted payload', async () => {
    state.photoProcessedIds = ['one', 'hidden'];
    state.recentDecisions = [{ eventId: 'local-only-journal' }];
    const result = await createEncryptedRecords('secret');
    expect(result).toMatchObject({ saved: 1, skipped: 1 });
    const value = jest.mocked(encryptBackup).mock.calls[0][0];
    expect(value).toEqual({ version: 1, platform: 'android', records: [{ id: 'one', kind: 'photo', decision: 'keep', fingerprint: mediaFingerprint(photo) }] });
    expect(JSON.stringify(value)).not.toContain('private.jpg');
    expect(JSON.stringify(value)).not.toContain('local-only-journal');
});
it('does not import or fabricate undo history from a version-1 backup', async () => {
    state.recentDecisions = [{ eventId: 'stale-local-operation' }];
    await openEncryptedRecords(new Uint8Array(), 'secret');
    expect(state.recentDecisions).toEqual([{ eventId: 'stale-local-operation' }]);
    await restoreEncryptedRecords(file(), true);
    expect(state.recentDecisions).toEqual([]);
    expect(state.photoProcessedIds).toEqual(['one']); expect(state.deleteQueue).toEqual([photo]);
});
it('reads later metadata pages and rejects repeated cursors without committing', async () => {
    state.photoProcessedIds = ['one'];
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce({ assets: [], hasNextPage: true, endCursor: 'page-1' } as any)
        .mockResolvedValueOnce({ assets: [photo], hasNextPage: false } as any);
    expect(await createEncryptedRecords('secret')).toMatchObject({ saved: 1, skipped: 0 });
    expect(MediaLibrary.getAssetsAsync).toHaveBeenLastCalledWith(expect.objectContaining({ after: 'page-1' }));
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [photo], hasNextPage: true, endCursor: 'same' } as any);
    await expect(restoreEncryptedRecords(file(), true)).rejects.toMatchObject({ code: 'unavailable' });
    expect(useMediaStore.setState).not.toHaveBeenCalled();
});
it('does not require EXIF/location access to back up a normally visible Android photo', async () => {
    state.photoProcessedIds = ['one'];
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockRejectedValue(new Error('missing ACCESS_MEDIA_LOCATION permission'));
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [photo], hasNextPage: false } as any);
    expect(await createEncryptedRecords('secret')).toMatchObject({ saved: 1, skipped: 0 });
    expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({ resolveWithFullInfo: false }));
});
it('refuses a transfer during another task and releases the lock after failure', async () => {
    const release = acquireRecordOperation('scanner')!;
    try { await expect(restoreEncryptedRecords(file(), true)).rejects.toThrow(); }
    finally { release(); }
    await expect(restoreEncryptedRecords(file(), true, () => true)).rejects.toMatchObject({ code: 'cancelled' });
    const available = acquireRecordOperation('scanner');
    expect(available).not.toBeNull(); available?.();
});
