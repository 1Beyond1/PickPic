jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAlbumsAsync: jest.fn() }));
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { matchesSourceAlbumTitle, readSourceAlbums } from '../services/mediaSourceAlbums';
const os = Platform.OS;
beforeEach(() => {
    Platform.OS = 'android';
    jest.mocked(MediaLibrary.getPermissionsAsync).mockReset().mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockReset().mockResolvedValue([]);
});
afterEach(() => { Platform.OS = os; });
it('matches only deliberate whole album titles, not filenames, substrings or generic audio recordings', () => {
    for (const title of ['Screenshots', '屏幕截图', ' SCREEN-CAPTURES ', 'Ｓｃｒｅｅｎｓｈｏｔｓ']) expect(matchesSourceAlbumTitle('photo', title)).toBe(true);
    for (const title of ['Screen Recordings', 'ScreenRecorder', '录屏', '屏幕录制']) expect(matchesSourceAlbumTitle('video', title)).toBe(true);
    for (const title of ['Screenshot_001.png', 'My Screenshots edits', 'Recordings', 'Camera', 'Vacation Screenshot', undefined]) {
        expect(matchesSourceAlbumTitle('photo', title)).toBe(false); expect(matchesSourceAlbumTitle('video', title)).toBe(false);
    }
    expect(matchesSourceAlbumTitle('video', 'Screenshots')).toBe(false);
});
it('includes system albums, deduplicates IDs and returns only ephemeral names/IDs', async () => {
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([{ id: 'shot', title: 'Screenshots', assetCount: 9 },
        { id: 'shot', title: 'Screenshots' }, { id: 'record', title: 'ScreenRecordings' }, { id: 'camera', title: 'Camera' }] as any);
    expect(await readSourceAlbums('photo')).toEqual({ status: 'ready', albums: [{ id: 'shot', title: 'Screenshots' }] });
    expect(MediaLibrary.getAlbumsAsync).toHaveBeenCalledWith({ includeSmartAlbums: true });
});
it('no suggested album is distinct from no screenshot/recording content', async () => {
    expect(await readSourceAlbums('video')).toEqual({ status: 'ready', albums: [] });
});
it('does not query album APIs under iOS selected-photo access', async () => {
    Platform.OS = 'ios';
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    expect((await readSourceAlbums('photo')).status).toBe('unavailable');
    expect(MediaLibrary.getAlbumsAsync).not.toHaveBeenCalled();
});
it('uses the most recent limited selection and rejects expired permission/generation results', async () => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValueOnce([{ id: 'old', title: 'Screenshots' }] as any)
        .mockResolvedValueOnce([{ id: 'new', title: '屏幕截图' }] as any);
    expect((await readSourceAlbums('photo')).albums.map(album => album.id)).toEqual(['new']);
    let current = true;
    jest.mocked(MediaLibrary.getAlbumsAsync).mockImplementation(async () => { current = false; return [{ id: 'old', title: 'Screenshots' }] as any; });
    expect(await readSourceAlbums('photo', () => current)).toEqual({ status: 'stale', albums: [] });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: false } as any);
    expect((await readSourceAlbums('photo')).status).toBe('permission');
});
it('keeps a provider failure distinct from an empty suggestion', async () => {
    jest.mocked(MediaLibrary.getAlbumsAsync).mockRejectedValue(new Error('Provider unavailable'));
    expect(await readSourceAlbums('video')).toEqual({ status: 'failed', albums: [] });
});
