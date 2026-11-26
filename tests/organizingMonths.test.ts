jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), getAlbumsAsync: jest.fn() }));
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { readOrganizingMonths } from '../services/organizingMonths';
import { createMediaMonth } from '../services/mediaMonth';
const month = createMediaMonth(2026, 10);
const asset = (id: string, time: number) => ({ id, uri: `file:///synthetic-${id}.jpg`, mediaType: 'photo', creationTime: time }) as any;
const originalOS = Platform.OS;
beforeEach(() => {
    Platform.OS = 'android';
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([{ id: 'first' }, { id: 'second' }] as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [asset('one', month.startInclusive), asset('kept', month.startInclusive), asset('unknown', 0)], hasNextPage: false } as any);
});
afterEach(() => { Platform.OS = originalOS; });
it('counts the accessible unprocessed projection and deduplicates multi-album media without retaining metadata', async () => {
    const result = await readOrganizingMonths('photo', ['first', 'second'], new Set(['kept']));
    expect(result).toEqual({ status: 'ready', months: [{ ...month, count: 1 }], unknownDateCount: 1, limited: false });
    expect(JSON.stringify(result)).not.toContain('synthetic'); expect(JSON.stringify(result)).not.toContain('one');
});
it('never widens a missing album or an iOS selected-access album request', async () => {
    expect((await readOrganizingMonths('photo', ['missing'], new Set())).status).toBe('unavailable');
    expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
    Platform.OS = 'ios'; jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    expect((await readOrganizingMonths('photo', ['first'], new Set())).status).toBe('unavailable');
    expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
});
it('returns the latest selected-access projection instead of reusing its old same-privilege count', async () => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce({ assets: [asset('old', month.startInclusive)], hasNextPage: false } as any)
        .mockResolvedValueOnce({ assets: [], hasNextPage: false } as any);
    expect(await readOrganizingMonths('photo', [], new Set())).toEqual({ status: 'ready', months: [], unknownDateCount: 0, limited: true });
});
it('discards counts when albums disappear, the native cursor cycles, or the caller generation expires', async () => {
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValueOnce([{ id: 'first' }] as any).mockResolvedValueOnce([]);
    expect((await readOrganizingMonths('photo', ['first'], new Set())).status).toBe('unavailable');
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [], hasNextPage: true, endCursor: 'cycle' } as any);
    expect((await readOrganizingMonths('photo', [], new Set())).status).toBe('failed');
    expect((await readOrganizingMonths('photo', [], new Set(), () => false)).status).toBe('stale');
});
