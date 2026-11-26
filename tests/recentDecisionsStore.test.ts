jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetInfoAsync: jest.fn(), getAssetsAsync: jest.fn(),
    deleteAssetsAsync: jest.fn(), SortBy: { creationTime: 'creationTime' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../database', () => ({ AssetRepository: { removeAssetAndDerivedData: jest.fn(async () => {}) } }));
import * as MediaLibrary from 'expo-media-library';
import { useMediaStore } from '../stores/useMediaStore';
import { isRecentDecisions } from '../services/recentDecisions';
import { acquireRecordOperation } from '../services/recordOperationLock';

const photo = (id: string) => ({ id, mediaType: 'photo', uri: `file:///private-${id}.jpg` }) as any;
const video = (id: string) => ({ ...photo(id), mediaType: 'video', uri: `file:///private-${id}.mp4` }) as any;
beforeEach(() => useMediaStore.setState({ hasHydrated: true, photoProcessedIds: [], videoProcessedIds: [],
    deleteQueue: [], videoTrashBin: [], collectionQueue: [], pendingDeletionInfo: {}, recentDecisions: [],
    organizingSessions: { photo: null, video: null }, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
    photos: [], videos: [], videoCurrentIndex: 0, permissionScope: 'full' }));

it('records keep, collection and mixed AI pending changes atomically with their real before/after state', () => {
    const store = useMediaStore.getState();
    store.markAsSkipped(photo('kept')); store.markForCollection(photo('collected'));
    store.enqueuePendingDeletion([photo('kept'), video('movie')], 'similar');
    const state = useMediaStore.getState();
    expect(state.recentDecisions.map(entry => [entry.assetId, entry.action])).toEqual([
        ['movie', 'pending'], ['kept', 'pending'], ['collected', 'collect'], ['kept', 'keep'],
    ]);
    expect(state.recentDecisions[1].before).toMatchObject({ processed: true, pending: null });
    expect(state.recentDecisions[1].after).toMatchObject({ processed: true, pending: { source: 'similar' } });
    expect(state.videoTrashBin.map(asset => asset.id)).toEqual(['movie']);
    expect(isRecentDecisions(state.recentDecisions)).toBe(true);
    expect(JSON.stringify(state.recentDecisions)).not.toContain('file:///');
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
it('does not create history from repeated keeps, duplicate queue input or backwards viewing', () => {
    const store = useMediaStore.getState();
    store.startOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['one', 'two']);
    useMediaStore.setState({ videos: [video('one'), video('two')] });
    store.markVideoAsProcessed(video('one')); store.markVideoAsProcessed(video('one'));
    store.moveVideoSession('two'); store.moveVideoSession('one');
    expect(useMediaStore.getState().recentDecisions).toHaveLength(1);
    store.enqueuePendingDeletion([video('two'), video('two')], 'videos');
    store.enqueuePendingDeletion([video('two')], 'classification');
    expect(useMediaStore.getState().recentDecisions).toHaveLength(2);
    expect(useMediaStore.getState().recentDecisions[0].after.pending?.source).toBe('videos');
});
it('keeps skip separate from processed and records a later explicit pending decision overriding that skip', () => {
    const store = useMediaStore.getState();
    store.startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['one', 'two']);
    useMediaStore.setState({ photos: [photo('one'), photo('two')] });
    expect(store.deferSessionMedia('photo', 'one')).toBe(true);
    expect(useMediaStore.getState().recentDecisions[0]).toMatchObject({ action: 'defer', position: 0,
        after: { processed: false, pending: null, deferred: true } });
    store.enqueuePendingDeletion([photo('one')], 'classification');
    const state = useMediaStore.getState();
    expect(state.recentDecisions[0]).toMatchObject({ action: 'pending', before: { deferred: true, processed: false }, after: { deferred: false, processed: true } });
    expect(state.organizingSessions.photo?.deferredIds).toEqual([]);
    expect(state.photoProcessedIds).toEqual(['one']);
});
it('records pending-to-keep without unprocessing or losing the original pending source', () => {
    const store = useMediaStore.getState();
    store.enqueuePendingDeletion([photo('one'), video('two')], 'blur');
    store.keepPendingDeletion('one');
    expect(useMediaStore.getState().recentDecisions[0]).toMatchObject({ assetId: 'one', action: 'keep',
        before: { pending: { source: 'blur' }, processed: true }, after: { pending: null, processed: true } });
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['one']);
    expect(useMediaStore.getState().videoTrashBin.map(asset => asset.id)).toEqual(['two']);
});
it('removes every inverse operation for confirmed gone media but retains other history', () => {
    const store = useMediaStore.getState();
    store.markAsSkipped(photo('one')); store.enqueuePendingDeletion([photo('one'), video('two')], 'photos');
    store.removeDeletedAssets(['one']);
    expect(useMediaStore.getState().recentDecisions.map(entry => entry.assetId)).toEqual(['two']);
    expect(useMediaStore.getState().deleteQueue).toEqual([]);
    expect(useMediaStore.getState().videoTrashBin.map(asset => asset.id)).toEqual(['two']);
});
it('retains the journal on native cancellation and removes only successful members after partial deletion', async () => {
    const store = useMediaStore.getState();
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async asset => {
        const assetId = typeof asset === 'string' ? asset : asset.id;
        return assetId === 'one' ? photo('one') : video('two');
    });
    store.markAsSkipped(photo('one')); store.enqueuePendingDeletion([photo('one'), video('two')], 'photos');
    const journal = useMediaStore.getState().recentDecisions;
    jest.mocked(MediaLibrary.deleteAssetsAsync).mockResolvedValueOnce(false);
    expect(await store.confirmPendingDeletion()).toMatchObject({ status: 'cancelled', deletedIds: [], remainingIds: ['one', 'two'] });
    expect(useMediaStore.getState().recentDecisions).toEqual(journal);
    jest.mocked(MediaLibrary.deleteAssetsAsync).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await store.confirmPendingDeletion()).toMatchObject({ status: 'partial', deletedIds: ['one'], remainingIds: ['two'] });
    expect(useMediaStore.getState().recentDecisions.map(entry => entry.assetId)).toEqual(['two']);
    expect(useMediaStore.getState().videoTrashBin.map(asset => asset.id)).toEqual(['two']);
});
it('resets only the chosen media kind and does not mutate decisions during encrypted transfer', () => {
    const store = useMediaStore.getState(); store.markAsSkipped(photo('one')); store.markVideoAsProcessed(video('two'));
    store.resetPhotoProgress();
    expect(useMediaStore.getState().recentDecisions.map(entry => entry.assetId)).toEqual(['two']);
    const release = acquireRecordOperation('backup')!;
    try { store.markAsSkipped(photo('three')); store.markForCollection(photo('four')); store.markVideoAsProcessed(video('five'));
        store.enqueuePendingDeletion([photo('six')], 'photos'); }
    finally { release(); }
    expect(useMediaStore.getState().recentDecisions.map(entry => entry.assetId)).toEqual(['two']);
    store.resetVideoProgress(); expect(useMediaStore.getState().recentDecisions).toEqual([]);
});
