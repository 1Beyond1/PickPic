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
        clearLoadedMedia: jest.fn(), notifyMediaLibraryRefresh: jest.fn() };
    jest.mocked(useMediaStore.getState).mockImplementation(() => state);
    jest.mocked(useMediaStore.setState).mockImplementation((next: any) => { Object.assign(state, next); });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockResolvedValue({ ...photo, location: { latitude: 1, longitude: 2 } } as any);
    jest.mocked(decryptBackup).mockResolvedValue(file());
});
it('does not mutate records before authentication and schema validation succeed', async () => {
    jest.mocked(decryptBackup).mockRejectedValueOnce(new Error('authentication failed'));
    await expect(openEncryptedRecords(new Uint8Array(), 'secret')).rejects.toThrow();
    jest.mocked(decryptBackup).mockResolvedValueOnce({ version: 999 });
    await expect(openEncryptedRecords(new Uint8Array(), 'secret')).rejects.toThrow();
    expect(useMediaStore.setState).not.toHaveBeenCalled();
    expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
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
it('rejects selection changes during a limited-permission read', async () => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce({ assets: [photo], hasNextPage: false } as any)
        .mockResolvedValueOnce({ assets: [], hasNextPage: false } as any);
    await expect(restoreEncryptedRecords(file(), true)).rejects.toThrow();
    expect(useMediaStore.setState).not.toHaveBeenCalled();
});
it('exports only bounded decision metadata inside the encrypted payload', async () => {
    state.photoProcessedIds = ['one', 'hidden'];
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async id => { if (id === 'hidden') throw new Error('hidden'); return photo as any; });
    const result = await createEncryptedRecords('secret');
    expect(result).toMatchObject({ saved: 1, skipped: 1 });
    const value = jest.mocked(encryptBackup).mock.calls[0][0];
    expect(value).toEqual({ version: 1, platform: 'android', records: [{ id: 'one', kind: 'photo', decision: 'keep', fingerprint: mediaFingerprint(photo) }] });
    expect(JSON.stringify(value)).not.toContain('private.jpg');
});
it('refuses a transfer during another task and releases the lock after failure', async () => {
    const release = acquireRecordOperation('scanner')!;
    try { await expect(restoreEncryptedRecords(file(), true)).rejects.toThrow(); }
    finally { release(); }
    await expect(restoreEncryptedRecords(file(), true, () => true)).rejects.toMatchObject({ code: 'cancelled' });
    const available = acquireRecordOperation('scanner');
    expect(available).not.toBeNull(); available?.();
});
