jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), deleteAssetsAsync: jest.fn(), SortBy: { creationTime: 'creationTime' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../database', () => ({ AssetRepository: {} }));
import * as MediaLibrary from 'expo-media-library';
import { useMediaStore } from '../stores/useMediaStore';
import { usePrivacyStore } from '../stores/usePrivacyStore';
import { acquireRecordOperation } from '../services/recordOperationLock';
const photo = (id: string) => ({ id, mediaType: 'photo', uri: `file:///fresh-${id}.jpg`, filename: `${id}.jpg`, creationTime: 1, width: 10, height: 10 }) as any;
const video = (id: string) => ({ ...photo(id), mediaType: 'video', uri: `file:///fresh-${id}.mp4` }) as any;
let library = [photo('one'), photo('two'), video('movie')];
beforeEach(() => {
    library = [photo('one'), photo('two'), video('movie')]; usePrivacyStore.setState({ failures: {} });
    useMediaStore.setState({ hasHydrated: true, photoProcessedIds: [], videoProcessedIds: [], deleteQueue: [], collectionQueue: [], videoTrashBin: [],
        pendingDeletionInfo: {}, recentDecisions: [], organizingSessions: { photo: null, video: null }, photos: library.slice(0, 2), videos: [video('movie')],
        isConfirmingDeletion: false, isConfirmingVideoTrash: false, permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0,
        permissionScope: 'full', hiddenPhotoQueuedAssetIds: null, hiddenVideoQueuedAssetIds: null });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async options => ({ assets: library.filter(asset => asset.mediaType === options?.mediaType), hasNextPage: false } as any));
});
const latest = () => useMediaStore.getState().recentDecisions[0].eventId;
it('undoes only the requested keep and returns its original batch member without changing later decisions', async () => {
    const store = useMediaStore.getState();
    store.startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['one', 'two']);
    store.markAsSkipped(photo('one')); const first = latest(); store.markAsSkipped(photo('two')); store.markVideoAsProcessed(video('movie'));
    expect(await store.changeRecentDecision(first, 'undo')).toBe('changed');
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['two']); expect(useMediaStore.getState().videoProcessedIds).toEqual(['movie']);
    expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ position: 0, phase: 'organizing', assetIds: ['one', 'two'] });
    expect(useMediaStore.getState().recentDecisions.some(entry => entry.eventId === first)).toBe(false);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
it('distinguishes pending-to-keep from undo and restores the prior pending source using fresh metadata', async () => {
    const store = useMediaStore.getState(); store.enqueuePendingDeletion([{ ...photo('one'), uri: 'file:///stale.jpg' }], 'similar');
    store.keepPendingDeletion('one');
    expect(await store.changeRecentDecision(latest(), 'undo')).toBe('changed');
    expect(useMediaStore.getState().deleteQueue[0].uri).toBe('file:///fresh-one.jpg');
    expect(useMediaStore.getState().pendingDeletionInfo.one.source).toBe('similar');
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['one']);
    expect(await store.changeRecentDecision(latest(), 'undo')).toBe('changed');
    expect(useMediaStore.getState().deleteQueue).toEqual([]); expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
});
it('changes a kept video to pending and removes only that video from playback; undo does not delete a file', async () => {
    const store = useMediaStore.getState(); store.markVideoAsProcessed(video('movie'));
    expect(await store.changeRecentDecision(latest(), 'pending')).toBe('changed');
    expect(useMediaStore.getState().videoTrashBin[0].uri).toBe('file:///fresh-movie.mp4');
    expect(useMediaStore.getState().videos).toEqual([]);
    expect(await store.changeRecentDecision(latest(), 'undo')).toBe('changed');
    expect(useMediaStore.getState().videoTrashBin).toEqual([]); expect(useMediaStore.getState().videoProcessedIds).toEqual(['movie']);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
it('does not resurrect confirmed deleted media or act on an older superseded event', async () => {
    const store = useMediaStore.getState(); store.markAsSkipped(photo('one')); const old = latest();
    store.enqueuePendingDeletion([photo('one')], 'classification'); const queued = latest();
    expect(await store.changeRecentDecision(old, 'undo')).toBe('stale');
    store.removeDeletedAssets(['one']);
    expect(await store.changeRecentDecision(queued, 'undo')).toBe('nothing');
    expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
});
it('undoes a skip in its round but never recreates an old round exclusion in a new session', async () => {
    const store = useMediaStore.getState(); store.startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['one', 'two']);
    store.deferSessionMedia('photo', 'one');
    expect(await store.changeRecentDecision(latest(), 'undo')).toBe('changed');
    expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ position: 0, deferredIds: [] });
    store.deferSessionMedia('photo', 'one'); const old = latest();
    store.startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['one', 'two']);
    expect(await store.changeRecentDecision(old, 'undo')).toBe('stale');
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
    expect(await store.changeRecentDecision(old, 'keep')).toBe('changed');
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['one']);
    expect(useMediaStore.getState().organizingSessions.photo?.deferredIds).toEqual([]);
});
it('navigates to an explicitly undone video without unprocessing a previously kept video', async () => {
    library = [video('one'), video('movie')]; const store = useMediaStore.getState();
    store.startOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['one', 'movie']);
    useMediaStore.setState({ videos: library }); store.markVideoAsProcessed(video('one'));
    store.moveVideoSession('movie'); store.enqueuePendingDeletion([video('movie')], 'videos'); const queued = latest();
    store.moveVideoSession('one');
    expect(await store.changeRecentDecision(queued, 'undo')).toBe('changed');
    expect(useMediaStore.getState().organizingSessions.video).toMatchObject({ position: 1, phase: 'organizing' });
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['one']);
});
it('preserves all records for absent media, revoked permission and metadata errors', async () => {
    const store = useMediaStore.getState(); store.markAsSkipped(photo('one')); const event = latest();
    const before = useMediaStore.getState();
    library = [photo('two')]; expect(await store.changeRecentDecision(event, 'undo')).toBe('unavailable');
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: false } as any);
    expect(await store.changeRecentDecision(event, 'undo')).toBe('unavailable');
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockRejectedValue(new Error('synthetic failure'));
    expect(await store.changeRecentDecision(event, 'undo')).toBe('failed');
    expect(useMediaStore.getState().recentDecisions).toBe(before.recentDecisions); expect(useMediaStore.getState().photoProcessedIds).toBe(before.photoProcessedIds);
});
it('discards an asynchronous undo when the permission generation changes', async () => {
    const store = useMediaStore.getState(); store.markAsSkipped(photo('one')); const event = latest();
    let release!: (page: any) => void;
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = store.changeRecentDecision(event, 'undo');
    for (let step = 0; step < 10 && !release; step++) await Promise.resolve();
    useMediaStore.setState({ permissionRefreshVersion: 1 }); release({ assets: [photo('one')], hasNextPage: false });
    expect(await pending).toBe('stale'); expect(useMediaStore.getState().photoProcessedIds).toEqual(['one']);
});
it('blocks transfers, confirmation and failed records storage without dropping history', async () => {
    const store = useMediaStore.getState(); store.markAsSkipped(photo('one')); const event = latest();
    const release = acquireRecordOperation('backup')!;
    try { expect(await store.changeRecentDecision(event, 'undo')).toBe('busy'); } finally { release(); }
    useMediaStore.setState({ isConfirmingVideoTrash: true }); expect(await store.changeRecentDecision(event, 'undo')).toBe('busy');
    useMediaStore.setState({ isConfirmingVideoTrash: false }); usePrivacyStore.setState({ failures: { records: 'write' } });
    expect(await store.changeRecentDecision(event, 'undo')).toBe('busy');
    expect(useMediaStore.getState().recentDecisions).toHaveLength(1);
});

it.each(['new-session', 'superseded'] as const)('does not apply an inverse after its %s changes during a media read', async reason => {
    const store = useMediaStore.getState();
    store.startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['one', 'two']);
    store.markAsSkipped(photo('one')); const event = latest();
    let release!: (page: any) => void;
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = store.changeRecentDecision(event, 'undo');
    for (let step = 0; step < 10 && !release; step++) await Promise.resolve();
    if (reason === 'new-session') store.startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['two']);
    else store.enqueuePendingDeletion([photo('one')], 'similar');
    const expected = useMediaStore.getState();
    release({ assets: [photo('one')], hasNextPage: false });
    expect(await pending).toBe('stale');
    expect(useMediaStore.getState().recentDecisions).toBe(expected.recentDecisions);
    expect(useMediaStore.getState().organizingSessions).toBe(expected.organizingSessions);
    expect(useMediaStore.getState().deleteQueue).toBe(expected.deleteQueue);
});

it('preserves a different media kind changed while the inverse is reading metadata', async () => {
    const store = useMediaStore.getState(); store.markAsSkipped(photo('one')); const event = latest();
    let release!: (page: any) => void;
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = store.changeRecentDecision(event, 'undo');
    for (let step = 0; step < 10 && !release; step++) await Promise.resolve();
    store.startOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['movie']);
    store.enqueuePendingDeletion([video('movie')], 'videos');
    const videoSession = useMediaStore.getState().organizingSessions.video;
    release({ assets: [photo('one')], hasNextPage: false });
    expect(await pending).toBe('changed');
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
    expect(useMediaStore.getState().videoTrashBin.map(asset => asset.id)).toEqual(['movie']);
    expect(useMediaStore.getState().organizingSessions.video).toBe(videoSession);
    expect(useMediaStore.getState().recentDecisions.map(entry => entry.assetId)).toEqual(['movie']);
});

it('does not rebuild or unhide the other type of queue when undoing a video', async () => {
    const store = useMediaStore.getState();
    store.enqueuePendingDeletion([photo('one')], 'similar'); store.markForCollection(photo('two'));
    store.markVideoAsProcessed(video('movie')); const event = latest();
    useMediaStore.setState({ hiddenPhotoQueuedAssetIds: ['one', 'two'], permissionScope: 'limited' });
    const before = useMediaStore.getState();
    expect(await store.changeRecentDecision(event, 'undo')).toBe('changed');
    expect(useMediaStore.getState().deleteQueue).toBe(before.deleteQueue);
    expect(useMediaStore.getState().collectionQueue).toBe(before.collectionQueue);
    expect(useMediaStore.getState().hiddenPhotoQueuedAssetIds).toBe(before.hiddenPhotoQueuedAssetIds);
    expect(useMediaStore.getState().videoProcessedIds).toEqual([]);
});
