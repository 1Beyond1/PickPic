jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), getAlbumsAsync: jest.fn(),
    SortBy: { creationTime: 'creationTime' } }));
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../database', () => ({ AssetRepository: {} }));
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: { getState: () => ({ selectedAlbumIds: [], setSelectedAlbums: jest.fn() }) } }));
import * as MediaLibrary from 'expo-media-library';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { useMediaStore } from '../stores/useMediaStore';
import { createMediaMonth } from '../services/mediaMonth';
const read = jest.fn(), os = Platform.OS, month = createMediaMonth(2026, 10);
let fixtures: any[];
beforeEach(() => {
    Platform.OS = 'android';
    fixtures = ['1', '2', '3'].map(id => ({ id, creationTime: month.startInclusive, mediaType: 'photo', uri: `file:///synthetic-${id}.jpg` }));
    jest.mocked(requireOptionalNativeModule).mockReturnValue({ readSizes: read });
    read.mockReset().mockImplementation(async (_, ids: string[]) => ids.map(id => ({ id, bytes: Number(id) * 100 })));
    useMediaStore.setState({ hasHydrated: true, photos: [], videos: [], organizingSessions: { photo: null, video: null },
        photoProcessedIds: [], videoProcessedIds: [], deleteQueue: [], videoTrashBin: [], collectionQueue: [],
        recentDecisions: [], pendingDeletionInfo: {}, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
        permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0, totalPhotos: 99, totalVideos: 82 });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([]);
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async () => ({ assets: fixtures, hasNextPage: false, totalCount: 3 }) as any);
});
afterEach(() => { Platform.OS = os; });
it.each(['photo', 'video'] as const)('reports %s permission loss during size enumeration rather than false completion or a generic read failure', async kind => {
    fixtures = fixtures.map(asset => ({ ...asset, mediaType: kind }));
    const saved = useMediaStore.getState().startOrganizingSession(kind, { albumIds: [], order: 'oldest' }, ['1']);
    read.mockImplementation(async (_, ids: string[]) => {
        jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: false, accessPrivileges: 'none' } as any);
        return ids.map(id => ({ id, bytes: 100 }));
    });
    const store = useMediaStore.getState();
    await (kind === 'photo' ? store.loadPhotos : store.loadVideos)(10, 'largest', [], 'new');
    const state = useMediaStore.getState();
    expect(state.organizingSessions[kind]).toBe(saved);
    expect(kind === 'photo' ? state.photoSessionRecoveryStatus : state.videoSessionRecoveryStatus).toBe('permission');
    expect(kind === 'photo' ? state.photoLoadFailed : state.videoLoadFailed).toBe(false);
});
it.each(['photo', 'video'] as const)('starts %s largest-first and continues captured order, excluding processed/deferred while preserving totals', async kind => {
    fixtures = fixtures.map(asset => ({ ...asset, mediaType: kind }));
    const load = () => kind === 'photo' ? useMediaStore.getState().loadPhotos : useMediaStore.getState().loadVideos;
    await load()(1, 'largest', [], 'new', month);
    expect(useMediaStore.getState().organizingSessions[kind]).toMatchObject({ scope: { albumIds: [], order: 'largest', date: month }, assetIds: ['3'] });
    if (kind === 'photo') useMediaStore.getState().markAsSkipped(fixtures[2]); else useMediaStore.getState().markVideoAsProcessed(fixtures[2]);
    await load()(10, 'oldest', [], 'continue');
    const state = useMediaStore.getState();
    expect(state.organizingSessions[kind]).toMatchObject({ scope: { order: 'largest', date: month }, assetIds: ['2', '1'] });
    expect(state.totalPhotos).toBe(99); expect(state.totalVideos).toBe(82);
});
it.each(['photo', 'video'] as const)('size failure does not replace the saved %s session or create empty completion', async kind => {
    fixtures = fixtures.map(asset => ({ ...asset, mediaType: kind }));
    const saved = useMediaStore.getState().startOrganizingSession(kind, { albumIds: [], order: 'oldest' }, ['1']);
    read.mockRejectedValue(new Error('Provider failed'));
    const store = useMediaStore.getState();
    await (kind === 'photo' ? store.loadPhotos : store.loadVideos)(10, 'largest', [], 'new');
    const state = useMediaStore.getState();
    expect(state.organizingSessions[kind]).toBe(saved);
    expect(kind === 'photo' ? state.photoLoadFailed : state.videoLoadFailed).toBe(true);
});
