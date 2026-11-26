jest.mock('expo-media-library', () => ({ getAssetsAsync: jest.fn(), getAlbumsAsync: jest.fn(), getPermissionsAsync: jest.fn() }));
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));
import * as MediaLibrary from 'expo-media-library';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { loadLargestMedia } from '../services/largestMedia';
import { createMediaMonth } from '../services/mediaMonth';
const read = jest.fn();
const month = createMediaMonth(2026, 10), os = Platform.OS;
const asset = (id: string, time = month.startInclusive, kind = 'photo') => ({ id, uri: `file:///synthetic-${id}`, mediaType: kind, creationTime: time }) as any;
const page = (assets: any[], more = false, cursor?: string) => ({ assets, hasNextPage: more, endCursor: cursor, totalCount: 999 }) as any;
beforeEach(() => {
    Platform.OS = 'android'; read.mockReset();
    jest.mocked(requireOptionalNativeModule).mockReturnValue({ readSizes: read });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([{ id: 'camera' }, { id: 'downloads' }] as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockReset();
});
afterEach(() => { Platform.OS = os; });
it('finds largest candidates beyond the first page, excludes decisions/date mismatch, deduplicates albums and reports unknowns', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async options => options?.album === 'downloads'
        ? page([asset('4'), asset('6')]) : options?.after ? page([asset('4'), asset('5')])
            : page([asset('1'), asset('2'), asset('3', month.endExclusive), asset('7')], true, 'p2'));
    const bytes: Record<string, number | null> = { '1': 10, '2': null, '4': 5 * 1024 ** 3, '5': 100, '6': 0, '7': 99999 };
    read.mockImplementation(async (_, ids: string[]) => ids.map(id => ({ id, bytes: bytes[id] })));
    const result = await loadLargestMedia('photo', 2, ['camera', 'downloads'], new Set(['7']), month);
    expect(result.assets.map(item => item.id)).toEqual(['4', '5']);
    expect(result.sizeStats).toEqual({ knownCount: 3, unknownCount: 2 });
    expect(result.totalCount).toBeNull();
    expect(read.mock.calls.flatMap(call => call[1])).toEqual(['1', '2', '4', '5', '6']);
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({ first: 200, resolveWithFullInfo: false }));
});
it('does not fake zero sizes or require date metadata for an unrestricted scope', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue(page([asset('1', 0), asset('2', 0)]));
    read.mockResolvedValue([{ id: '1', bytes: 123 }, { id: '2', bytes: null }]);
    expect((await loadLargestMedia('photo', 10, [], new Set())).assets.map(item => item.id)).toEqual(['1']);
    read.mockResolvedValue([{ id: '1', bytes: 0 }]);
    const result = await loadLargestMedia('photo', 10, [], new Set());
    expect(result.assets).toEqual([]); expect(result.sizeStats).toEqual({ knownCount: 0, unknownCount: 2 });
});
it('does not publish partial ranking when a later page or native query fails', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce(page([asset('1')], true, 'p2')).mockRejectedValueOnce(new Error('Provider failed'));
    read.mockResolvedValue([{ id: '1', bytes: 100 }]);
    await expect(loadLargestMedia('photo', 1, [], new Set())).rejects.toMatchObject({ reason: 'failed' });
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue(page([asset('1')]));
    read.mockRejectedValue(new Error('Native query failed'));
    await expect(loadLargestMedia('photo', 1, [], new Set())).rejects.toMatchObject({ reason: 'failed' });
});
it('rejects disappeared album and repeated pagination cursor instead of widening or looping', async () => {
    await expect(loadLargestMedia('photo', 2, ['missing'], new Set())).rejects.toMatchObject({ reason: 'unavailable' });
    expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
    read.mockResolvedValue([]); jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue(page([], true, 'repeat'));
    await expect(loadLargestMedia('photo', 2, [], new Set())).rejects.toMatchObject({ reason: 'failed' });
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledTimes(2);
});
it('discard results after permission generation changes or final permission is denied', async () => {
    let current = true;
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async () => { current = false; return page([asset('1')]); });
    await expect(loadLargestMedia('photo', 2, [], new Set(), undefined, () => current)).rejects.toMatchObject({ reason: 'stale' });
    expect(read).not.toHaveBeenCalled();
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue(page([asset('1')])); read.mockResolvedValue([{ id: '1', bytes: 100 }]);
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValueOnce({ granted: true, accessPrivileges: 'all' } as any)
        .mockResolvedValueOnce({ granted: false, accessPrivileges: 'none' } as any);
    await expect(loadLargestMedia('photo', 2, [], new Set())).rejects.toMatchObject({ reason: 'permission' });
});
it('re-enumerates limited selection and uses only its latest ranking', async () => {
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValueOnce(page([asset('1')])).mockResolvedValueOnce(page([asset('2')]));
    read.mockImplementation(async (_, ids: string[]) => ids.map(id => ({ id, bytes: 100 })));
    expect((await loadLargestMedia('photo', 2, [], new Set())).assets.map(item => item.id)).toEqual(['2']);
});
it('unsupported native builds/platforms do not claim the library is empty', async () => {
    jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
    await expect(loadLargestMedia('photo', 2, [], new Set())).rejects.toMatchObject({ reason: 'unavailable' });
    expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
});
it('excludes assets belonging to excludedAlbumIds in largest-first mode', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue(page([
        { ...asset('1'), albumId: 'protected-vault' },
        { ...asset('2'), albumId: 'camera' },
    ]));
    read.mockImplementation(async (_, ids: string[]) => ids.map(id => ({ id, bytes: id === '1' ? 999999 : 500 })));
    const result = await loadLargestMedia('photo', 5, [], new Set(), undefined, () => true, new Set(['protected-vault']));
    expect(result.assets.map(item => item.id)).toEqual(['2']);
    expect(read).toHaveBeenCalledWith('photo', ['2']);
});
