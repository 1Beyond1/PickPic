jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), getAlbumsAsync: jest.fn(),
    SortBy: { creationTime: 'creationTime' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../database', () => ({ AssetRepository: {} }));
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: { getState: () => ({ selectedAlbumIds: [], setSelectedAlbums: jest.fn() }) } }));
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { useMediaStore } from '../stores/useMediaStore';
import { createMediaMonth, mediaMonthQuery } from '../services/mediaMonth';
const month = createMediaMonth(2026, 10);
const asset = (id: string, time: number, kind = 'photo') => ({ id, uri: `file:///synthetic-${id}.jpg`, mediaType: kind, filename: `${id}.jpg`, creationTime: time,
    width: 10, height: 10 }) as any;
let fixtures: any[];
beforeEach(() => {
    fixtures = [asset('start', month.startInclusive), asset('middle', month.startInclusive + 10000), asset('next', month.endExclusive), asset('unknown', 0)];
    useMediaStore.setState({ hasHydrated: true, photos: [], videos: [], organizingSessions: { photo: null, video: null },
        photoProcessedIds: ['legacy'], videoProcessedIds: ['old-video'], deleteQueue: [], videoTrashBin: [], collectionQueue: [],
        recentDecisions: [], pendingDeletionInfo: {}, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
        permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0, totalPhotos: 99, totalVideos: 82 });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([{ id: 'first' }, { id: 'second' }] as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async options => {
        const list = options?.album === 'first' ? fixtures.filter(item => item.id !== 'start') : fixtures;
        const dates = list.filter(item => (options?.createdAfter === undefined || item.creationTime > Number(options.createdAfter))
            && (options?.createdBefore === undefined || item.creationTime < Number(options.createdBefore)));
        const ascending = (options?.sortBy as any)?.[0]?.[1];
        dates.sort((a, b) => ascending ? a.creationTime - b.creationTime : b.creationTime - a.creationTime);
        return { assets: dates.filter(item => item.mediaType === options?.mediaType), hasNextPage: false, totalCount: dates.length } as any;
    });
});
async function load(kind: 'photo' | 'video', count: number, order: 'oldest' | 'newest' | 'random', albums: string[], mode: 'new' | 'continue', date = month as typeof month | 'unknown' | undefined) {
    const store = useMediaStore.getState();
    await (kind === 'photo' ? store.loadPhotos : store.loadVideos)(count, order, albums, mode, date);
}

it.each(['photo', 'video'] as const)('combines %s month, multiple albums and global ordering without changing whole-library counts', async kind => {
    fixtures = fixtures.map(item => ({ ...item, mediaType: kind }));
    await load(kind, 10, 'oldest', ['first', 'second'], 'new');
    const state = useMediaStore.getState();
    expect((kind === 'photo' ? state.photos : state.videos).map(item => item.id)).toEqual(['start', 'middle']);
    expect(state.organizingSessions[kind]?.scope).toEqual({ albumIds: ['first', 'second'], order: 'oldest', date: month });
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({ album: 'second', ...mediaMonthQuery(month) }));
    expect(state.totalPhotos).toBe(99); expect(state.totalVideos).toBe(82);
    expect(state.photoProcessedIds).toEqual(['legacy']); expect(state.videoProcessedIds).toEqual(['old-video']);
});
it.each(['photo', 'video'] as const)('continues %s within its saved month and accepts new matching media without a progress reset', async kind => {
    fixtures = fixtures.map(item => ({ ...item, mediaType: kind }));
    await load(kind, 1, 'oldest', [], 'new');
    const store = useMediaStore.getState();
    if (kind === 'photo') store.markAsSkipped(fixtures[0]); else store.markVideoAsProcessed(fixtures[0]);
    fixtures.push(asset('new-same-month', month.startInclusive + 5000, kind));
    await load(kind, 10, 'newest', ['first'], 'continue', createMediaMonth(2026, 11));
    const state = useMediaStore.getState();
    expect(state.organizingSessions[kind]?.scope).toEqual({ albumIds: [], order: 'oldest', date: month });
    expect((kind === 'photo' ? state.photos : state.videos).map(item => item.id)).toEqual(['new-same-month', 'middle']);
    expect((kind === 'photo' ? state.photoProcessedIds : state.videoProcessedIds)).toContain('start');
});
it.each(['photo', 'video'] as const)('treats unknown %s dates as a distinct filter without guessing a month', async kind => {
    fixtures = fixtures.map(item => ({ ...item, mediaType: kind }));
    await load(kind, 10, 'random', [], 'new', 'unknown');
    const state = useMediaStore.getState();
    expect((kind === 'photo' ? state.photos : state.videos).map(item => item.id)).toEqual(['unknown']);
    expect(state.organizingSessions[kind]?.scope.date).toBe('unknown');
    expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalledWith(expect.objectContaining({ createdAfter: expect.anything() }));
});
it('defensively rejects provider rows outside the month even when the provider ignores date constraints', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: fixtures, hasNextPage: false, totalCount: 4 } as any);
    await load('photo', 10, 'random', [], 'new');
    expect(new Set(useMediaStore.getState().photos.map(item => item.id))).toEqual(new Set(['start', 'middle']));
});
it.each(['photo', 'video'] as const)('does not replace a %s session if permission selection changes while a new scope loads', async kind => {
    fixtures = fixtures.map(item => ({ ...item, mediaType: kind }));
    const prior = useMediaStore.getState().startOrganizingSession(kind, { albumIds: [], order: 'oldest' }, ['unseen']);
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementationOnce(async () => {
        useMediaStore.setState({ permissionRefreshVersion: 1 }); return { assets: fixtures, hasNextPage: false, totalCount: 4 } as any;
    });
    await load(kind, 10, 'oldest', [], 'new');
    expect(useMediaStore.getState().organizingSessions[kind]).toBe(prior);
});

it.each(['photo', 'video'] as const)('accepts a still-present iOS smart album for a new %s month session', async kind => {
    const original = Platform.OS;
    try {
        Platform.OS = 'ios'; fixtures = fixtures.map(item => ({ ...item, mediaType: kind }));
        jest.mocked(MediaLibrary.getAlbumsAsync).mockImplementation(async options => options?.includeSmartAlbums ? [{ id: 'smart', type: 'smartAlbum' }] as any : []);
        await load(kind, 10, 'oldest', ['smart'], 'new');
        expect(useMediaStore.getState().organizingSessions[kind]?.assetIds).toEqual(['start', 'middle']);
    } finally { Platform.OS = original; }
});
it('does not publish an obsolete permission failure after the photo permission generation has advanced', async () => {
    const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['unseen']);
    jest.mocked(MediaLibrary.getPermissionsAsync).mockImplementationOnce(async () => {
        useMediaStore.setState({ permissionRefreshVersion: 1, photoSessionRecoveryStatus: 'ready' });
        return { granted: false, accessPrivileges: 'none' } as any;
    });
    await load('photo', 10, 'oldest', [], 'new');
    expect(useMediaStore.getState().photoSessionRecoveryStatus).toBe('ready');
    expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
});
