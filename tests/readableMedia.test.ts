import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { getReadableMediaInfo, getReadableMediaInfos } from '../services/readableMedia';

jest.mock('expo-media-library', () => ({ getAssetInfoAsync: jest.fn(), getAssetsAsync: jest.fn() }));
const info = MediaLibrary.getAssetInfoAsync as jest.Mock;
const page = MediaLibrary.getAssetsAsync as jest.Mock;
const locationFailure = new Error('Cannot access ExifInterface because of missing ACCESS_MEDIA_LOCATION permission');
const asset = { id: 'photo', mediaType: 'photo', uri: 'file:///synthetic.jpg' };
const originalOS = Platform.OS;
beforeEach(() => { Platform.OS = 'android'; info.mockRejectedValue(locationFailure); page.mockResolvedValue({ assets: [asset], hasNextPage: false }); });
afterEach(() => { Platform.OS = originalOS; });

it('reads indexed pixels without GPS access or an original-media download', async () => {
    expect(await getReadableMediaInfo('photo', 'photo', { shouldDownloadFromNetwork: false })).toEqual({ ...asset, localUri: asset.uri });
    expect(info).toHaveBeenCalledWith('photo', { shouldDownloadFromNetwork: false });
    expect(page).toHaveBeenCalledWith({ mediaType: 'photo', first: 200, resolveWithFullInfo: false });
});
it('does not replace a successful full-info result with a library scan', async () => {
    info.mockResolvedValue(asset);
    expect(await getReadableMediaInfo('photo')).toBe(asset);
    expect(page).not.toHaveBeenCalled();
});
it.each(['Permission denied', 'File no longer exists', 'Provider failed'])('never hides an unrelated failure: %s', async message => {
    info.mockRejectedValue(new Error(message));
    await expect(getReadableMediaInfo('photo')).rejects.toThrow(message);
    expect(page).not.toHaveBeenCalled();
});
it('does not apply the Android EXIF workaround to iOS', async () => {
    Platform.OS = 'ios';
    await expect(getReadableMediaInfo('photo')).rejects.toBe(locationFailure);
    expect(page).not.toHaveBeenCalled();
});
it('requires the requested ID and media type in the current accessible library', async () => {
    page.mockResolvedValue({ assets: [{ ...asset, id: 'other' }, { ...asset, mediaType: 'video' }], hasNextPage: false });
    await expect(getReadableMediaInfo('photo')).rejects.toThrow('not accessible');
});
it('can find a later page without treating a repeated cursor as absence', async () => {
    page.mockResolvedValueOnce({ assets: [], hasNextPage: true, endCursor: 'next' });
    expect((await getReadableMediaInfo('photo')).id).toBe('photo');
    expect(page).toHaveBeenLastCalledWith({ mediaType: 'photo', first: 200, resolveWithFullInfo: false, after: 'next' });
});
it('rejects a cyclic or incomplete provider enumeration', async () => {
    page.mockResolvedValue({ assets: [], hasNextPage: true, endCursor: 'cycle' });
    await expect(getReadableMediaInfo('photo')).rejects.toThrow('incomplete');
    expect(page).toHaveBeenCalledTimes(2);
});

it('resolves many known EXIF failures in one metadata pass, without retrying unrelated errors', async () => {
    info.mockImplementation(async (id: string) => { throw id === 'denied' ? new Error('Permission denied') : locationFailure; });
    page.mockResolvedValue({ assets: [asset, { ...asset, id: 'second' }, { ...asset, id: 'denied' }], hasNextPage: false });
    const found = await getReadableMediaInfos(['photo', 'second', 'photo', 'denied'], 'photo');
    expect([...found.keys()]).toEqual(['photo', 'second']);
    expect(info).toHaveBeenCalledTimes(3);
    expect(page).toHaveBeenCalledTimes(1);
});
it('does not publish partial enumeration results after a provider cursor cycle', async () => {
    page.mockResolvedValue({ assets: [asset], hasNextPage: true, endCursor: 'cycle' });
    const found = await getReadableMediaInfos(['photo', 'missing'], 'photo');
    expect(found.size).toBe(0);
});
