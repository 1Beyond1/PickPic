jest.mock('expo-image', () => ({ Image: { clearDiskCache: jest.fn() } }));
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///isolated/cache/', deleteAsync: jest.fn() }));
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { clearLegacyMediaCache } from '../../services/privacy/mediaCache';
import { usePrivacyStore } from '../../stores/usePrivacyStore';

beforeEach(() => { usePrivacyStore.setState({ failures: {} }); });
it('removes the library-owned disk cache and retains unrelated record failures', async () => {
    usePrivacyStore.getState().block('records', 'read');
    jest.mocked(Image.clearDiskCache).mockResolvedValue(true);
    await clearLegacyMediaCache();
    expect(Image.clearDiskCache).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///isolated/cache/ImageManipulator/', { idempotent: true });
    expect(usePrivacyStore.getState().failures).toEqual({ records: 'read' });
});
it('keeps the gate closed for failed cleanup, with explicit successful retry', async () => {
    jest.mocked(Image.clearDiskCache).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(clearLegacyMediaCache()).rejects.toThrow('original data was preserved');
    expect(usePrivacyStore.getState().failures.cache).toBe('read');
    await clearLegacyMediaCache();
    expect(usePrivacyStore.getState().failures).toEqual({});
});
