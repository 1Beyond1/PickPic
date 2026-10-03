jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), getAssetInfoAsync: jest.fn() }));
import * as MediaLibrary from 'expo-media-library';
import { readRecentDecisionMedia } from '../services/recentDecisionMedia';
const photo = { id: 'one', uri: 'file:///fresh.jpg', mediaType: 'photo', filename: 'synthetic.jpg', creationTime: 1, width: 10, height: 10 } as any;
beforeEach(() => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [photo], hasNextPage: false } as any);
});
it('reads fresh indexed metadata without original EXIF requests or carrying GPS/EXIF', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [{ ...photo, location: { latitude: 1 }, exif: {}, localUri: 'file:///old.jpg' }], hasNextPage: false } as any);
    const read = await readRecentDecisionMedia('photo', ['one']);
    expect(read.status).toBe('ready'); expect(read.assets.get('one')).toEqual(photo);
    expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({ resolveWithFullInfo: false, mediaType: 'photo' }));
});
it('does not treat an absent or wrong-type asset as visible and never changes records', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [{ ...photo, mediaType: 'video' }], hasNextPage: false } as any);
    expect((await readRecentDecisionMedia('photo', ['one'])).assets.size).toBe(0);
});
it('rejects a limited selection that changes without changing its permission level', async () => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce({ assets: [photo], hasNextPage: false } as any)
        .mockResolvedValueOnce({ assets: [], hasNextPage: false } as any);
    expect((await readRecentDecisionMedia('photo', ['one'])).assets.size).toBe(0);
});
it('discards fresh metadata when permissions or the caller generation change', async () => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValueOnce({ granted: true, accessPrivileges: 'all' } as any)
        .mockResolvedValueOnce({ granted: false } as any);
    expect(await readRecentDecisionMedia('photo', ['one'])).toMatchObject({ status: 'permission', assets: new Map() });
    expect(await readRecentDecisionMedia('photo', ['one'], () => false)).toMatchObject({ status: 'stale', assets: new Map() });
});
it('reads later pages but refuses provider errors or cyclic pagination', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce({ assets: [], hasNextPage: true, endCursor: 'next' } as any)
        .mockResolvedValueOnce({ assets: [photo], hasNextPage: false } as any);
    expect((await readRecentDecisionMedia('photo', ['one'])).assets.get('one')).toEqual(photo);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [], hasNextPage: true, endCursor: 'loop' } as any);
    expect(await readRecentDecisionMedia('photo', ['one'])).toMatchObject({ status: 'failed' });
    jest.mocked(MediaLibrary.getAssetsAsync).mockRejectedValue(new Error('synthetic failure'));
    expect(await readRecentDecisionMedia('photo', ['one'])).toMatchObject({ status: 'failed' });
});
