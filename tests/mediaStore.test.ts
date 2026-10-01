jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  getAlbumsAsync: jest.fn(),
  getAssetsAsync: jest.fn(),
  deleteAssetsAsync: jest.fn(),
  SortBy: { creationTime: 'creationTime' },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../database', () => ({
  AssetRepository: {
    removeAssetAndDerivedData: jest.fn(),
  },
}));
jest.mock('../stores/useSettingsStore', () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({
      selectedAlbumIds: [],
      setSelectedAlbums: jest.fn(),
    })),
  },
}));

import * as MediaLibrary from 'expo-media-library';
import { waitFor } from '@testing-library/react-native';
import { AssetRepository } from '../database';
import { getCurrentlyVisibleAssetIds, useMediaStore } from '../stores/useMediaStore';

const mockRemoveAssetAndDerivedData = AssetRepository.removeAssetAndDerivedData as jest.Mock;

describe('media visibility checks', () => {
  const getPermissionsAsync = MediaLibrary.getPermissionsAsync as jest.Mock;
  const getAssetInfoAsync = MediaLibrary.getAssetInfoAsync as jest.Mock;
  const getAlbumsAsync = MediaLibrary.getAlbumsAsync as jest.Mock;
  const getAssetsAsync = MediaLibrary.getAssetsAsync as jest.Mock;
  const deleteAssetsAsync = MediaLibrary.deleteAssetsAsync as jest.Mock;

  beforeEach(() => {
    getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    getAssetInfoAsync.mockImplementation(async (assetId: string) => (
      assetId === 'visible' ? { id: assetId } : null
    ));
    getAlbumsAsync.mockResolvedValue([]);
    getAssetsAsync.mockResolvedValue({ assets: [], hasNextPage: false, endCursor: '', totalCount: 0 });
    deleteAssetsAsync.mockResolvedValue(true);
    mockRemoveAssetAndDerivedData.mockResolvedValue(undefined);
    useMediaStore.setState({
      photos: [],
      videos: [],
      albums: [],
      currentIndex: 0,
      videoCurrentIndex: 0,
      deleteQueue: [],
      collectionQueue: [],
      videoTrashBin: [],
      photoProcessedIds: [],
      videoProcessedIds: [],
      totalPhotos: 0,
      totalVideos: 0,
      isLoading: false,
      photoLoadFailed: false,
      videoLoadFailed: false,
      isConfirmingDeletion: false,
      isConfirmingVideoTrash: false,
      hasPermission: true,
      permissionScope: 'full',
      hiddenPhotoQueuedAssetIds: null,
      hiddenVideoQueuedAssetIds: null,
    });
  });

  it.each(['photo', 'video'] as const)('exposes a recoverable %s read failure without changing queued decisions', async mediaType => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const listKey = mediaType === 'photo' ? 'photos' : 'videos';
    const queueKey = mediaType === 'photo' ? 'deleteQueue' : 'videoTrashBin';
    const progressKey = mediaType === 'photo' ? 'photoProcessedIds' : 'videoProcessedIds';
    const errorKey = mediaType === 'photo' ? 'photoLoadFailed' : 'videoLoadFailed';
    const queued = { id: 'queued', mediaType } as any;
    useMediaStore.setState({ [queueKey]: [queued], [progressKey]: ['queued'] });
    getAssetsAsync.mockRejectedValueOnce(new Error('Media provider unavailable'));
    try {
      await useMediaStore.getState()[mediaType === 'photo' ? 'loadPhotos' : 'loadVideos'](10);
      expect(useMediaStore.getState()[errorKey]).toBe(true);
      expect(useMediaStore.getState()[listKey]).toEqual([]);
      expect(useMediaStore.getState().isLoading).toBe(false);
      expect(useMediaStore.getState()[queueKey]).toEqual([queued]);
      expect(useMediaStore.getState()[progressKey]).toEqual(['queued']);
      await useMediaStore.getState()[mediaType === 'photo' ? 'loadPhotos' : 'loadVideos'](10);
      expect(useMediaStore.getState()[errorKey]).toBe(false);
      expect(useMediaStore.getState()[queueKey]).toEqual([queued]);
    } finally { errorLog.mockRestore(); }
  });

  it.each(['photo', 'video'] as const)('does not let a stale %s rejection replace newer successful feedback', async mediaType => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const load = useMediaStore.getState()[mediaType === 'photo' ? 'loadPhotos' : 'loadVideos'];
    const errorKey = mediaType === 'photo' ? 'photoLoadFailed' : 'videoLoadFailed';
    let rejectOld!: (error: Error) => void;
    getAssetsAsync.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    try {
      const oldLoad = load(10);
      await waitFor(() => expect(rejectOld).toBeDefined());
      await load(10);
      expect(useMediaStore.getState()[errorKey]).toBe(false);
      rejectOld(new Error('Old provider request failed'));
      await oldLoad;
      expect(useMediaStore.getState()[errorKey]).toBe(false);
      expect(useMediaStore.getState().isLoading).toBe(false);
    } finally { errorLog.mockRestore(); }
  });

  it('uses asset-level visibility instead of trusting a limited global grant', async () => {
    const visible = await getCurrentlyVisibleAssetIds(['visible', 'hidden', 'visible'], 'photo');

    expect(Array.from(visible)).toEqual(['visible']);
    expect(getAssetInfoAsync).toHaveBeenCalledWith('visible', { shouldDownloadFromNetwork: false });
    expect(getAssetInfoAsync).toHaveBeenCalledWith('hidden', { shouldDownloadFromNetwork: false });
  });

  it('fails closed when the media permission is denied', async () => {
    getPermissionsAsync.mockResolvedValue({ granted: false, accessPrivileges: 'none' });

    await expect(getCurrentlyVisibleAssetIds(['visible'], 'photo')).resolves.toEqual(new Set());
    expect(getAssetInfoAsync).not.toHaveBeenCalled();
  });

  describe.each(['photo', 'video'] as const)('%s queue permission changes', mediaType => {
    const queueKey = mediaType === 'photo' ? 'deleteQueue' : 'videoTrashBin';
    const progressKey = mediaType === 'photo' ? 'photoProcessedIds' : 'videoProcessedIds';
    const hiddenKey = mediaType === 'photo' ? 'hiddenPhotoQueuedAssetIds' : 'hiddenVideoQueuedAssetIds';
    const assets = ['visible', 'hidden'].map(id => ({ id, mediaType })) as any[];

    beforeEach(() => {
      useMediaStore.setState({ [queueKey]: assets, [progressKey]: ['visible', 'hidden'] });
    });

    it('hides inaccessible entries without discarding their queue or progress, then restores full visibility', async () => {
      useMediaStore.getState().refreshQueuedAssetVisibility('limited', mediaType);
      expect(useMediaStore.getState()[hiddenKey]).toEqual(['visible', 'hidden']);
      await waitFor(() => expect(useMediaStore.getState()[hiddenKey]).toEqual(['hidden']));
      expect(useMediaStore.getState()[queueKey]).toEqual(assets);
      expect(useMediaStore.getState()[progressKey]).toEqual(['visible', 'hidden']);

      useMediaStore.getState().refreshQueuedAssetVisibility('none', mediaType);
      expect(useMediaStore.getState()[hiddenKey]).toEqual(['visible', 'hidden']);
      useMediaStore.getState().refreshQueuedAssetVisibility('full', mediaType);
      expect(useMediaStore.getState()[hiddenKey]).toBeNull();
      expect(useMediaStore.getState()[queueKey]).toEqual(assets);
      expect(useMediaStore.getState()[progressKey]).toEqual(['visible', 'hidden']);
      expect(deleteAssetsAsync).not.toHaveBeenCalled();
      expect(mockRemoveAssetAndDerivedData).not.toHaveBeenCalled();
    });

    it('does not reveal assets from a stale limited check after permission is revoked or replaced', async () => {
      let resolveOld!: (info: { id: string }) => void;
      getAssetInfoAsync.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
      useMediaStore.getState().refreshQueuedAssetVisibility('limited', mediaType);
      useMediaStore.getState().refreshQueuedAssetVisibility('none', mediaType);
      resolveOld({ id: 'visible' });
      // Let the entire old Promise.all continuation finish before asserting;
      // checking while it is still pending would miss a stale publication.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(useMediaStore.getState()[hiddenKey]).toEqual(['visible', 'hidden']);

      getAssetInfoAsync.mockImplementation(async (id: string) => id === 'hidden' ? { id } : null);
      useMediaStore.getState().refreshQueuedAssetVisibility('limited', mediaType);
      await waitFor(() => expect(useMediaStore.getState()[hiddenKey]).toEqual(['visible']));
      expect(useMediaStore.getState()[queueKey]).toEqual(assets);
      expect(useMediaStore.getState()[progressKey]).toEqual(['visible', 'hidden']);
    });

    it('fails closed on a per-asset read error while keeping accessible entries and allowing a later retry', async () => {
      getAssetInfoAsync.mockImplementation(async (id: string) => {
        if (id === 'hidden') throw new Error('Native read denied');
        return { id };
      });
      useMediaStore.getState().refreshQueuedAssetVisibility('limited', mediaType);
      await waitFor(() => expect(useMediaStore.getState()[hiddenKey]).toEqual(['hidden']));
      getAssetInfoAsync.mockImplementation(async (id: string) => ({ id }));
      useMediaStore.getState().refreshQueuedAssetVisibility('limited', mediaType);
      await waitFor(() => expect(useMediaStore.getState()[hiddenKey]).toEqual([]));
      expect(useMediaStore.getState()[queueKey]).toEqual(assets);
      expect(useMediaStore.getState()[progressKey]).toEqual(['visible', 'hidden']);
    });
  });

  it('deletes only queue items that pass the visibility preflight', async () => {
    const visibleAsset = { id: 'visible', mediaType: 'photo' } as any;
    const hiddenAsset = { id: 'hidden', mediaType: 'photo' } as any;
    useMediaStore.setState({
      deleteQueue: [visibleAsset, hiddenAsset],
      photoProcessedIds: ['visible', 'hidden'],
    });

    await expect(useMediaStore.getState().confirmDeletion()).resolves.toEqual(['visible']);

    expect(deleteAssetsAsync).toHaveBeenCalledWith(['visible']);
    expect(mockRemoveAssetAndDerivedData).toHaveBeenCalledWith('visible');
    expect(useMediaStore.getState().deleteQueue).toEqual([hiddenAsset]);
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['hidden']);
  });

  describe.each(['photo', 'video'] as const)('%s deletion safety', mediaType => {
    const queueKey = mediaType === 'photo' ? 'deleteQueue' : 'videoTrashBin';
    const progressKey = mediaType === 'photo' ? 'photoProcessedIds' : 'videoProcessedIds';
    const confirm = (ids?: string[]) => mediaType === 'photo'
      ? useMediaStore.getState().confirmDeletion(ids)
      : useMediaStore.getState().confirmVideoTrash(ids);
    const locked = () => mediaType === 'photo'
      ? useMediaStore.getState().isConfirmingDeletion
      : useMediaStore.getState().isConfirmingVideoTrash;
    const asset = { id: 'visible', mediaType } as any;

    beforeEach(() => {
      useMediaStore.setState({ [queueKey]: [asset], [progressKey]: ['visible'] });
    });

    it.each(['cancelled', 'rejected'] as const)('retains the queue and progress when native deletion is %s', async outcome => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      if (outcome === 'cancelled') deleteAssetsAsync.mockResolvedValue(false);
      else deleteAssetsAsync.mockRejectedValue(new Error('Native failure'));
      await expect(confirm()).rejects.toThrow();
      expect(useMediaStore.getState()[queueKey]).toEqual([asset]);
      expect(useMediaStore.getState()[progressKey]).toEqual(['visible']);
      expect(locked()).toBe(false);
      expect(mockRemoveAssetAndDerivedData).not.toHaveBeenCalled();
    });

    it('does nothing for an explicitly empty request', async () => {
      await expect(confirm([])).resolves.toEqual([]);
      expect(deleteAssetsAsync).not.toHaveBeenCalled();
      expect(getAssetInfoAsync).not.toHaveBeenCalled();
      expect(useMediaStore.getState()[queueKey]).toEqual([asset]);
    });

    it('keeps requested-ID scope and leaves other queued visible items untouched', async () => {
      const other = { id: 'also-visible', mediaType } as any;
      getAssetInfoAsync.mockImplementation(async (id: string) => ({ id }));
      useMediaStore.setState({ [queueKey]: [asset, other], [progressKey]: ['visible', 'also-visible'] });
      await expect(confirm(['visible', 'not-queued'])).resolves.toEqual(['visible']);
      expect(getAssetInfoAsync).toHaveBeenCalledTimes(1);
      expect(useMediaStore.getState()[queueKey]).toEqual([other]);
      expect(useMediaStore.getState()[progressKey]).toEqual(['also-visible']);
      const nativeIds = deleteAssetsAsync.mock.calls[0][0].map((entry: string | { id: string }) => (
        typeof entry === 'string' ? entry : entry.id
      ));
      expect(nativeIds).toEqual(['visible']);
    });

    it('blocks repeated confirmations, undo and resets while native deletion is pending', async () => {
      let resolveDelete!: (deleted: boolean) => void;
      deleteAssetsAsync.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveDelete = resolve; }));
      const pending = confirm();
      try {
        await waitFor(() => expect(deleteAssetsAsync).toHaveBeenCalledTimes(1));
        expect(locked()).toBe(true);
        await expect(confirm()).resolves.toEqual([]);
        if (mediaType === 'photo') {
          useMediaStore.getState().undoAction('visible');
          useMediaStore.getState().resetBatch();
          useMediaStore.getState().resetPhotoProgress();
        } else {
          useMediaStore.getState().restoreFromTrash('visible');
          useMediaStore.getState().resetVideoProgress();
        }
        expect(useMediaStore.getState()[queueKey]).toEqual([asset]);
        expect(useMediaStore.getState()[progressKey]).toEqual(['visible']);
        expect(deleteAssetsAsync).toHaveBeenCalledTimes(1);
      } finally {
        resolveDelete(true);
        await pending;
      }
      expect(locked()).toBe(false);
      expect(useMediaStore.getState()[queueKey]).toEqual([]);
    });

    it('rechecks the queue after preflight so external removal wins and new entries are not deleted', async () => {
      let resolveInfo!: (info: { id: string }) => void;
      getAssetInfoAsync.mockImplementationOnce(() => new Promise(resolve => { resolveInfo = resolve; }));
      const pending = confirm();
      try {
        await waitFor(() => expect(getAssetInfoAsync).toHaveBeenCalledTimes(1));
        useMediaStore.getState().removeDeletedAssets(['visible']);
        const newlyQueued = { id: 'newly-queued', mediaType } as any;
        if (mediaType === 'photo') useMediaStore.getState().markForDeletion(newlyQueued);
        else useMediaStore.getState().markVideoForTrash(newlyQueued);
        resolveInfo({ id: 'visible' });
        await expect(pending).resolves.toEqual([]);
        expect(deleteAssetsAsync).not.toHaveBeenCalled();
        expect(useMediaStore.getState()[queueKey]).toEqual([newlyQueued]);
      } finally {
        resolveInfo({ id: 'visible' });
        await pending;
      }
      expect(locked()).toBe(false);
    });
  });

  it('does not report a failed deletion or retain deleted media when best-effort index cleanup fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const asset = { id: 'visible', mediaType: 'photo' } as any;
    useMediaStore.setState({ deleteQueue: [asset], photoProcessedIds: ['visible'] });
    mockRemoveAssetAndDerivedData.mockRejectedValue(new Error('Index unavailable'));
    await expect(useMediaStore.getState().confirmDeletion()).resolves.toEqual(['visible']);
    expect(useMediaStore.getState().deleteQueue).toEqual([]);
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
    expect(useMediaStore.getState().isConfirmingDeletion).toBe(false);
  });

  it('does not widen an all-invalid album filter into an unscoped query', async () => {
    getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    getAlbumsAsync.mockResolvedValue([{ id: 'still-present' }]);

    await useMediaStore.getState().loadPhotos(2, 'oldest', ['deleted-album']);

    expect(getAssetsAsync).not.toHaveBeenCalled();
    expect(useMediaStore.getState().photos).toEqual([]);
  });

  it('lets the newest photo load win when an older native query resolves later', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    getAssetsAsync
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    const firstLoad = useMediaStore.getState().loadPhotos(1, 'oldest');
    const secondLoad = useMediaStore.getState().loadPhotos(1, 'oldest');

    await waitFor(() => expect(getAssetsAsync).toHaveBeenCalledTimes(2));

    resolveSecond?.({
      assets: [{ id: 'newest', mediaType: 'photo', creationTime: 2 }],
      hasNextPage: false,
      endCursor: '',
      totalCount: 1,
    });
    await secondLoad;

    resolveFirst?.({
      assets: [{ id: 'stale', mediaType: 'photo', creationTime: 1 }],
      hasNextPage: false,
      endCursor: '',
      totalCount: 1,
    });
    await firstLoad;

    expect(useMediaStore.getState().photos.map(asset => asset.id)).toEqual(['newest']);
  });

  it('shuffles a random video batch even when all videos fit in it', async () => {
    getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    getAssetsAsync.mockResolvedValue({
      assets: [
        { id: 'first', mediaType: 'video', creationTime: 3 },
        { id: 'second', mediaType: 'video', creationTime: 2 },
        { id: 'third', mediaType: 'video', creationTime: 1 },
      ],
      hasNextPage: false,
      endCursor: '',
      totalCount: 3,
    });
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await useMediaStore.getState().loadVideos(50, 'random');
      expect(useMediaStore.getState().videos.map(asset => asset.id)).toEqual([
        'second', 'third', 'first',
      ]);
      expect(random).toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});
