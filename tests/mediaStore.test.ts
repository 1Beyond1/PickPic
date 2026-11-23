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
    removeAssetsAndDerivedData: jest.fn(),
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
import { Platform } from 'react-native';
import { AssetRepository } from '../database';
import { getCurrentlyVisibleAssetIds, useMediaStore } from '../stores/useMediaStore';
import { getPendingDeletionEntries } from '../services/pendingDeletion';

const mockRemoveAssetAndDerivedData = AssetRepository.removeAssetAndDerivedData as jest.Mock;
const mockRemoveAssetsAndDerivedData = AssetRepository.removeAssetsAndDerivedData as jest.Mock;

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
    mockRemoveAssetsAndDerivedData.mockResolvedValue(undefined);
    useMediaStore.setState({
      photos: [],
      videos: [],
      albums: [],
      currentIndex: 0,
      videoCurrentIndex: 0,
      deleteQueue: [],
      collectionQueue: [],
      videoTrashBin: [],
      pendingDeletionInfo: {},
      deletedCounts: { photos: 0, videos: 0 },
      lastDeletionResult: null,
      recentDecisions: [],
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
      hasHydrated: true,
      organizingSessions: { photo: null, video: null },
      photoSessionRecoveryStatus: null, photoSessionUnavailableCount: 0,
      videoSessionRecoveryStatus: null, videoSessionUnavailableCount: 0,
      permissionScope: 'full',
      hiddenPhotoQueuedAssetIds: null,
      hiddenVideoQueuedAssetIds: null,
    });
  });

  it('keeps just the selected queued photo processed without changing collection or video decisions', async () => {
    const kept = { id: 'kept', mediaType: 'photo' } as any;
    const hidden = { id: 'hidden', mediaType: 'photo' } as any;
    const collection = { id: 'collection', mediaType: 'photo' } as any;
    const video = { id: 'video', mediaType: 'video' } as any;
    useMediaStore.setState({
      deleteQueue: [kept, hidden], collectionQueue: [collection], videoTrashBin: [video],
      photoProcessedIds: ['kept', 'hidden', 'collection'], videoProcessedIds: ['video'],
      permissionScope: 'limited', hiddenPhotoQueuedAssetIds: ['hidden', 'collection'],
    });
    expect(useMediaStore.getState().keepPhotoFromDeleteQueue('kept')).toBe(true);
    expect(useMediaStore.getState()).toMatchObject({
      deleteQueue: [hidden], collectionQueue: [collection], videoTrashBin: [video],
      photoProcessedIds: ['kept', 'hidden', 'collection'], videoProcessedIds: ['video'],
      hiddenPhotoQueuedAssetIds: ['hidden', 'collection'],
    });
    const state = useMediaStore.getState();
    expect(state.keepPhotoFromDeleteQueue('kept')).toBe(false);
    expect(state.keepPhotoFromDeleteQueue('unknown')).toBe(false);
    expect(useMediaStore.getState()).toBe(state);
    expect(deleteAssetsAsync).not.toHaveBeenCalled();
    expect(getAssetsAsync).not.toHaveBeenCalled();
    expect(mockRemoveAssetAndDerivedData).not.toHaveBeenCalled();
    getAssetsAsync.mockResolvedValueOnce({ assets: [kept], hasNextPage: false, endCursor: '', totalCount: 1 });
    await useMediaStore.getState().loadPhotos(10);
    expect(useMediaStore.getState().photos).toEqual([]);
    expect(useMediaStore.getState().photoProcessedIds).toContain('kept');
    useMediaStore.getState().resetBatch([]);
    expect(useMediaStore.getState().deleteQueue).toEqual([hidden]);
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['kept', 'hidden', 'collection']);
  });

  it('defers the current session member without recording it as organized or pending deletion', () => {
      useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'random' }, ['a', 'b']);
      expect(useMediaStore.getState().deferSessionMedia('photo', 'b')).toBe(false);
      expect(useMediaStore.getState().deferSessionMedia('photo', 'a')).toBe(true);
      expect(useMediaStore.getState()).toMatchObject({ photoProcessedIds: [], deleteQueue: [],
          organizingSessions: { photo: { position: 1, deferredIds: ['a'], assetIds: ['a', 'b'] } } });
      expect(useMediaStore.getState().continueSessionBatch('photo', ['new'])).toBe(false);
      useMediaStore.getState().markAsSkipped({ id: 'b', mediaType: 'photo' } as any); // Existing downward keep, not new defer.
      expect(useMediaStore.getState().continueSessionBatch('photo', ['a', 'new'])).toBe(true);
      expect(useMediaStore.getState().organizingSessions.photo?.assetIds).toEqual(['new']);
  });

  it('resumes a captured randomized batch in original order without replacing its saved scope or processed decisions', async () => {
      getAssetsAsync.mockResolvedValue({ assets: ['b', 'a'].map(id => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` })), hasNextPage: false });
      const session = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'random' }, ['a', 'b']);
      const result = await useMediaStore.getState().resumeOrganizingSession('photo');
      expect(result.status).toBe('ready');
      expect(useMediaStore.getState().photos.map(asset => asset.id)).toEqual(['a', 'b']);
      expect(useMediaStore.getState().organizingSessions.photo).toBe(session);
      expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
  });

  it('preserves the saved album and order on an automatic refresh even if new settings select a different scope', async () => {
      getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
      getAlbumsAsync.mockResolvedValue([{ id: 'saved-album' }]);
      getAssetsAsync.mockResolvedValue({ assets: ['a', 'b'].map(id => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` })), hasNextPage: false });
      const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: ['saved-album'], order: 'oldest' }, ['b', 'a']);
      await useMediaStore.getState().loadPhotos(10, 'newest', ['new-setting']);
      expect(getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({ album: 'saved-album', first: 200, resolveWithFullInfo: false }));
      expect(useMediaStore.getState().photos.map(asset => asset.id)).toEqual(['b', 'a']);
      expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
  });

  it('continues only the saved scope, excluding deferred items, while a deliberate new round includes them again', async () => {
      useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['deferred', 'kept']);
      useMediaStore.getState().deferSessionMedia('photo', 'deferred');
      useMediaStore.getState().markAsSkipped({ id: 'kept', mediaType: 'photo' } as any);
      const savedId = useMediaStore.getState().organizingSessions.photo!.sessionId;
      getAssetsAsync.mockResolvedValue({ assets: ['deferred', 'kept', 'new'].map(id => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` })), hasNextPage: false, totalCount: 3 });
      await useMediaStore.getState().loadPhotos(10, 'newest', ['must-not-use'], 'continue');
      expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ sessionId: savedId, scope: { albumIds: [], order: 'oldest' },
          assetIds: ['new'], deferredIds: ['deferred'] });
      expect(getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({ sortBy: [['creationTime', true]] }));
      await useMediaStore.getState().loadPhotos(10, 'oldest', [], 'new');
      expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ assetIds: ['deferred', 'new'], deferredIds: [] });
      expect(useMediaStore.getState().organizingSessions.photo!.sessionId).not.toBe(savedId);
      expect(useMediaStore.getState().photoProcessedIds).toEqual(['kept']);
  });

  it('preserves an inaccessible earlier member when the user defers a readable later photo', async () => {
      const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['unavailable', 'readable']);
      useMediaStore.setState({ photos: [{ id: 'readable', mediaType: 'photo', uri: 'file:///readable.jpg' } as any] });
      expect(useMediaStore.getState().deferSessionMedia('photo', 'readable')).toBe(true);
      expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ assetIds: saved!.assetIds, position: 0, deferredIds: ['readable'], phase: 'organizing' });
      getAssetsAsync.mockResolvedValue({ assets: [{ id: 'unavailable', mediaType: 'photo', uri: 'file:///new-grant.jpg' }], hasNextPage: false });
      expect((await useMediaStore.getState().resumeOrganizingSession('photo')).status).toBe('ready');
      expect(useMediaStore.getState().photos.map(asset => asset.id)).toEqual(['unavailable']);
      expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
      useMediaStore.getState().markAsSkipped({ id: 'unavailable', mediaType: 'photo' } as any);
      expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ position: 2, phase: 'review', deferredIds: ['readable'] });
      expect(useMediaStore.getState().photoProcessedIds).toEqual(['unavailable']);
  });

  it('removes old preview URIs and preserves session data when recovery fails', async () => {
      const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['a']);
      useMediaStore.setState({ photos: [{ id: 'a', uri: 'file:///old-authorized.jpg' } as any] });
      getAssetsAsync.mockRejectedValue(new Error('Synthetic provider failure'));
      expect((await useMediaStore.getState().resumeOrganizingSession('photo')).status).toBe('failed');
      expect(useMediaStore.getState().photos).toEqual([]);
      expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
      expect(useMediaStore.getState().photoSessionRecoveryStatus).toBe('failed');
  });

  it('reconciles an old cursor with restored decisions so a settled batch can continue without resetting progress', async () => {
      useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['a', 'b']);
      // A password backup can restore decisions made after this saved cursor.
      useMediaStore.setState({ photoProcessedIds: ['a', 'b'] });
      expect((await useMediaStore.getState().resumeOrganizingSession('photo')).status).toBe('review');
      expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ position: 2, phase: 'review' });
      expect(useMediaStore.getState().continueSessionBatch('photo', ['new'])).toBe(true);
      expect(useMediaStore.getState().photoProcessedIds).toEqual(['a', 'b']);
  });

  it('does not replace a saved session if photo permission changes during explicit new-round loading', async () => {
      const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['old']);
      getPermissionsAsync.mockResolvedValueOnce({ granted: true, accessPrivileges: 'all' }).mockResolvedValueOnce({ granted: true, accessPrivileges: 'limited' });
      getAssetsAsync.mockResolvedValue({ assets: [{ id: 'new', mediaType: 'photo' }], hasNextPage: false, totalCount: 1 });
      await useMediaStore.getState().loadPhotos(10, 'oldest', [], 'new');
      expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
      expect(useMediaStore.getState().photos).toEqual([]);
      expect(useMediaStore.getState().photoSessionRecoveryStatus).toBe('permission');
  });

  it('does not overwrite an independently started video session when an older photo recovery finishes', async () => {
      let finish!: (value: any) => void;
      getAssetsAsync.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['a']);
      const recovery = useMediaStore.getState().resumeOrganizingSession('photo');
      await waitFor(() => expect(getAssetsAsync).toHaveBeenCalled());
      const videoSession = useMediaStore.getState().startOrganizingSession('video', { albumIds: [], order: 'random' }, ['video']);
      finish({ assets: [{ id: 'a', mediaType: 'photo', uri: 'file:///fresh-a.jpg' }], hasNextPage: false });
      expect((await recovery).status).toBe('ready');
      expect(useMediaStore.getState().organizingSessions.video).toBe(videoSession);
  });

  it('advances the saved photo cursor for collection decisions without changing their existing meaning', () => {
      const a = { id: 'a', mediaType: 'photo' } as any;
      const b = { id: 'b', mediaType: 'photo' } as any;
      useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'random' }, ['a', 'b']);
      useMediaStore.getState().markForCollection(a);
      expect(useMediaStore.getState()).toMatchObject({ collectionQueue: [a], photoProcessedIds: ['a'],
          deleteQueue: [], organizingSessions: { photo: { position: 1, phase: 'organizing' } } });
      useMediaStore.getState().markForCollection(b);
      expect(useMediaStore.getState()).toMatchObject({ collectionQueue: [a, b], photoProcessedIds: ['a', 'b'],
          deleteQueue: [], organizingSessions: { photo: { position: 2, phase: 'review' } } });
  });

  it('does not abandon the unseen current photo when an AI result queues a later session member', () => {
      useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'random' }, ['a', 'b']);
      useMediaStore.getState().enqueuePendingDeletion([{ id: 'b', mediaType: 'photo' } as any], 'classification');
      expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ position: 0, phase: 'organizing' });
      useMediaStore.getState().markAsSkipped({ id: 'a', mediaType: 'photo' } as any);
      expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ position: 2, phase: 'review' });
      expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['b']);
  });

  it('does not publish an old resume snapshot after a selection generation changes', async () => {
      let finish!: (value: any) => void;
      getAssetsAsync.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'random' }, ['a']);
      const recovery = useMediaStore.getState().resumeOrganizingSession('photo');
      await waitFor(() => expect(getAssetsAsync).toHaveBeenCalled());
      useMediaStore.getState().notifyPermissionRefresh();
      finish({ assets: [{ id: 'a', mediaType: 'photo', uri: 'file:///stale.jpg' }], hasNextPage: false });
      expect((await recovery).status).toBe('stale');
      expect(useMediaStore.getState().photos).toEqual([]);
      expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
  });

  it('does not reinsert a video newly queued for deletion while its session metadata is being read', async () => {
      let finish!: (value: any) => void;
      getAssetsAsync.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const asset = { id: 'video-resume', mediaType: 'video', uri: 'file:///synthetic-video.mp4' } as any;
      useMediaStore.getState().startOrganizingSession('video', { albumIds: [], order: 'random' }, [asset.id]);
      const recovery = useMediaStore.getState().resumeOrganizingSession('video');
      await waitFor(() => expect(getAssetsAsync).toHaveBeenCalled());
      useMediaStore.getState().enqueuePendingDeletion([asset], 'videos');
      finish({ assets: [asset], hasNextPage: false });
      expect((await recovery).status).toBe('stale');
      expect(useMediaStore.getState().videos).toEqual([]);
      expect(useMediaStore.getState().videoTrashBin).toEqual([asset]);
  });

  it('rejects a changed video permission generation during a new-round read and preserves the old session', async () => {
      getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
      const saved = useMediaStore.getState().startOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['saved']);
      let finish!: (value: any) => void;
      getAssetsAsync.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const loading = useMediaStore.getState().loadVideos(1, 'oldest', [], 'new');
      await waitFor(() => expect(getAssetsAsync).toHaveBeenCalled());
      useMediaStore.getState().notifyPermissionRefresh();
      finish({ assets: [{ id: 'new', mediaType: 'video', uri: 'file:///synthetic.mp4' }], hasNextPage: false, totalCount: 1 });
      await loading;
      expect(useMediaStore.getState().videos).toEqual([]);
      expect(useMediaStore.getState().organizingSessions.video).toBe(saved);
  });

  it('never widens an invalid captured video album into the full gallery', async () => {
      getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
      getAlbumsAsync.mockResolvedValue([{ id: 'other-album' }]);
      await useMediaStore.getState().loadVideos(10, 'oldest', ['missing'], 'new');
      expect(getAssetsAsync).not.toHaveBeenCalled();
      expect(useMediaStore.getState().videoSessionRecoveryStatus).toBe('unavailable');
      expect(useMediaStore.getState().organizingSessions.video).toBeNull();
  });

  it('keeps an independent photo session started while video recovery is paging', async () => {
      getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
      useMediaStore.getState().startOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['saved']);
      let finish!: (value: any) => void;
      getAssetsAsync.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const recovery = useMediaStore.getState().resumeOrganizingSession('video');
      await waitFor(() => expect(getAssetsAsync).toHaveBeenCalled());
      const photo = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'random' }, ['photo']);
      finish({ assets: [{ id: 'saved', mediaType: 'video', uri: 'file:///synthetic.mp4' }], hasNextPage: false });
      expect((await recovery).status).toBe('ready');
      expect(useMediaStore.getState().organizingSessions.photo).toBe(photo);
  });

  it('repairs a restored queue item without a processed record when it is explicitly kept', () => {
    useMediaStore.setState({ deleteQueue: [{ id: 'restored' } as any] });
    expect(useMediaStore.getState().keepPhotoFromDeleteQueue('restored')).toBe(true);
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['restored']);
    expect(useMediaStore.getState().deleteQueue).toEqual([]);
  });

  describe('shared pending deletion decisions', () => {
    const photo = { id: 'photo', mediaType: 'photo', uri: 'file:///synthetic-photo.jpg' } as any;
    const video = { id: 'video', mediaType: 'video', uri: 'file:///synthetic-video.mp4' } as any;

    beforeEach(() => getAssetInfoAsync.mockImplementation(async (id: string) => ({ id })));

    it('queues mixed media once without physically deleting or losing the first source', () => {
      useMediaStore.setState({ photoProcessedIds: ['photo'], collectionQueue: [photo], videos: [video] });
      expect(useMediaStore.getState().enqueuePendingDeletion([photo, video, photo], 'similar')).toBe(2);
      const firstInfo = useMediaStore.getState().pendingDeletionInfo;
      expect(useMediaStore.getState().enqueuePendingDeletion([photo, video], 'classification')).toBe(0);
      expect(getPendingDeletionEntries(useMediaStore.getState()).map(entry => [entry.asset.id, entry.type, entry.source]))
        .toEqual([['photo', 'photo', 'similar'], ['video', 'video', 'similar']]);
      expect(useMediaStore.getState()).toMatchObject({
        collectionQueue: [], videos: [], photoProcessedIds: ['photo'], videoProcessedIds: ['video'],
        deletedCounts: { photos: 0, videos: 0 }, pendingDeletionInfo: firstInfo,
      });
      expect(deleteAssetsAsync).not.toHaveBeenCalled();
    });

    it('keeping a queued video remains processed and removes only its deletion decision', () => {
      useMediaStore.getState().enqueuePendingDeletion([photo, video], 'blur');
      useMediaStore.getState().restoreFromTrash('video');
      expect(useMediaStore.getState()).toMatchObject({
        deleteQueue: [photo], videoTrashBin: [], videoProcessedIds: ['video'],
        pendingDeletionInfo: { photo: expect.objectContaining({ source: 'blur' }) },
      });
      expect(useMediaStore.getState().pendingDeletionInfo.video).toBeUndefined();
      expect(deleteAssetsAsync).not.toHaveBeenCalled();
    });

    it('keeping and undoing a photo have different processing semantics', () => {
      useMediaStore.getState().enqueuePendingDeletion([photo], 'photos');
      expect(useMediaStore.getState().keepPendingDeletion('photo')).toBe(true);
      expect(useMediaStore.getState().photoProcessedIds).toEqual(['photo']);
      useMediaStore.getState().enqueuePendingDeletion([photo], 'classification');
      useMediaStore.getState().undoAction('photo');
      expect(useMediaStore.getState()).toMatchObject({ deleteQueue: [], photoProcessedIds: [], pendingDeletionInfo: {} });
    });

    it('records a mixed partial confirmation without discarding the cancelled video', async () => {
      useMediaStore.getState().enqueuePendingDeletion([photo, video], 'photos');
      deleteAssetsAsync.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const result = await useMediaStore.getState().confirmPendingDeletion();
      expect(result).toEqual({ status: 'partial', requestedIds: ['photo', 'video'], deletedIds: ['photo'], remainingIds: ['video'], failureKind: 'cancelled' });
      expect(deleteAssetsAsync.mock.calls.map(([batch]) => batch.map((item: any) => typeof item === 'string' ? item : item.id)))
        .toEqual([['photo'], ['video']]);
      expect(useMediaStore.getState()).toMatchObject({
        deleteQueue: [], videoTrashBin: [video], deletedCounts: { photos: 1, videos: 0 },
        isConfirmingDeletion: false, isConfirmingVideoTrash: false,
      });
      expect(mockRemoveAssetsAndDerivedData).toHaveBeenCalledWith(['photo']);
      expect(getAssetsAsync).not.toHaveBeenCalled(); // A cancellation is not a deletion receipt.
    });

    it('does not open the second media prompt after the first is cancelled', async () => {
      useMediaStore.getState().enqueuePendingDeletion([photo, video], 'photos');
      deleteAssetsAsync.mockResolvedValue(false);
      expect(await useMediaStore.getState().confirmPendingDeletion()).toMatchObject({ status: 'cancelled', deletedIds: [], remainingIds: ['photo', 'video'] });
      expect(deleteAssetsAsync).toHaveBeenCalledTimes(1);
      expect(useMediaStore.getState().deletedCounts).toEqual({ photos: 0, videos: 0 });
    });

    it('does not turn externally removed media into app deletion statistics', () => {
      useMediaStore.getState().enqueuePendingDeletion([photo, video], 'photos');
      useMediaStore.getState().removeDeletedAssets(['photo', 'video']);
      expect(getPendingDeletionEntries(useMediaStore.getState())).toEqual([]);
      expect(useMediaStore.getState().deletedCounts).toEqual({ photos: 0, videos: 0 });
    });

    it('reconciles a provider rejection after one item is gone only with complete full-access evidence', async () => {
      const other = { ...photo, id: 'other' };
      useMediaStore.getState().enqueuePendingDeletion([photo, other], 'photos');
      getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
      deleteAssetsAsync.mockRejectedValue(new Error('Provider stopped after first deletion'));
      getAssetsAsync.mockResolvedValue({ assets: [other], hasNextPage: false, endCursor: '', totalCount: 1 });
      expect(await useMediaStore.getState().confirmPendingDeletion()).toMatchObject({ status: 'partial', deletedIds: ['photo'], remainingIds: ['other'], failureKind: 'failed' });
      expect(useMediaStore.getState()).toMatchObject({ deleteQueue: [other], deletedCounts: { photos: 1, videos: 0 } });
      expect(deleteAssetsAsync).toHaveBeenCalledTimes(1); // No fallback or automatic retry.
    });

    it.each(['limited', 'read-error', 'permission-changed', 'cursor-cycle'] as const)
      ('retains all unresolved items after a failed delete with %s evidence', async evidence => {
        useMediaStore.getState().enqueuePendingDeletion([photo], 'photos');
        getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: evidence === 'limited' ? 'limited' : 'all' });
        deleteAssetsAsync.mockRejectedValue(new Error('Provider unavailable'));
        if (evidence === 'read-error') getAssetsAsync.mockRejectedValue(new Error('Read unavailable'));
        if (evidence === 'permission-changed') getAssetsAsync.mockImplementation(async () => {
          useMediaStore.getState().notifyPermissionRefresh();
          return { assets: [], hasNextPage: false, endCursor: '' };
        });
        if (evidence === 'cursor-cycle') {
          getAssetsAsync.mockResolvedValueOnce({ assets: [], hasNextPage: true, endCursor: 'a' })
            .mockResolvedValueOnce({ assets: [], hasNextPage: true, endCursor: 'b' })
            .mockResolvedValueOnce({ assets: [], hasNextPage: true, endCursor: 'a' });
        }
        expect(await useMediaStore.getState().confirmPendingDeletion()).toMatchObject({ status: 'failed', deletedIds: [], remainingIds: ['photo'] });
        expect(useMediaStore.getState()).toMatchObject({ deleteQueue: [photo], deletedCounts: { photos: 0, videos: 0 } });
        expect(mockRemoveAssetAndDerivedData).not.toHaveBeenCalled();
        if (evidence === 'cursor-cycle') expect(getAssetsAsync).toHaveBeenCalledTimes(3);
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
    expect(mockRemoveAssetsAndDerivedData).toHaveBeenCalledWith(['visible']);
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

    describe('Android 11+ (API 30+) deletion request batching', () => {
      const osDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
      const versionDescriptor = Object.getOwnPropertyDescriptor(Platform, 'Version')!;
      let assets: any[];

      beforeEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        Object.defineProperty(Platform, 'Version', { configurable: true, value: 36 });
        assets = Array.from({ length: 2501 }, (_, i) => ({ id: String(i + 1), mediaType }));
        getAssetInfoAsync.mockImplementation(async (id: string) => ({ id }));
        useMediaStore.setState({ [queueKey]: assets, [progressKey]: assets.map(a => a.id) });
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        // Model the 1000-item safe batch limit across Android 11-16+.
        deleteAssetsAsync.mockImplementation(async (batch: unknown[]) => {
          if (batch.length > 1000) throw new Error('TransactionTooLargeException: too many URIs');
          return true;
        });
      });

      afterEach(() => {
        Object.defineProperty(Platform, 'OS', osDescriptor);
        Object.defineProperty(Platform, 'Version', versionDescriptor);
      });

      it('deletes a large confirmed selection in 1000-item batches without widening its scope', async () => {
        const requested = assets.slice(0, 2001).map(a => a.id);
        await expect(confirm(requested)).resolves.toEqual(requested);
        expect(deleteAssetsAsync.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1000, 1]);
        expect(useMediaStore.getState()[queueKey]).toEqual(assets.slice(2001));
        expect(useMediaStore.getState()[progressKey]).toEqual(assets.slice(2001).map(a => a.id));
        expect(locked()).toBe(false);
      });

      it.each(['cancelled', 'rejected'] as const)('stops after a %s second request and retains only the undeleted decisions', async outcome => {
        deleteAssetsAsync.mockImplementation(async (batch: unknown[]) => {
          if (batch.length > 1000) throw new Error('TransactionTooLargeException: too many URIs');
          if (deleteAssetsAsync.mock.calls.length === 2) {
            if (outcome === 'cancelled') return false;
            throw new Error('Provider failure');
          }
          return true;
        });
        await expect(confirm()).rejects.toThrow();
        expect(deleteAssetsAsync).toHaveBeenCalledTimes(2);
        expect(useMediaStore.getState()[queueKey]).toEqual(assets.slice(1000));
        expect(useMediaStore.getState()[progressKey]).toEqual(assets.slice(1000).map(a => a.id));
        expect(mockRemoveAssetsAndDerivedData).toHaveBeenCalledTimes(mediaType === 'photo' ? 1 : 0);
        if (mediaType === 'photo') {
          expect(mockRemoveAssetsAndDerivedData).toHaveBeenCalledWith(assets.slice(0, 1000).map(a => a.id));
        }
        expect(mockRemoveAssetAndDerivedData).not.toHaveBeenCalled();
        expect(locked()).toBe(false);
      });

      it('does not continue or clear any decisions when the first request is cancelled', async () => {
        deleteAssetsAsync.mockResolvedValue(false);
        await expect(confirm()).rejects.toThrow();
        expect(deleteAssetsAsync).toHaveBeenCalledTimes(1);
        expect(deleteAssetsAsync.mock.calls[0][0]).toHaveLength(1000);
        expect(useMediaStore.getState()[queueKey]).toEqual(assets);
        expect(useMediaStore.getState()[progressKey]).toEqual(assets.map(a => a.id));
        expect(locked()).toBe(false);
      });
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
          expect(useMediaStore.getState().keepPhotoFromDeleteQueue('visible')).toBe(false);
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
    mockRemoveAssetsAndDerivedData.mockRejectedValue(new Error('Index unavailable'));
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

  it('batches Android EXIF fallback into one scan for queue visibility and pruning without discarding transient failures', async () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    try {
      const exifError = new Error('Missing ACCESS_MEDIA_LOCATION permission');
      const photos = ['a', 'b', 'c', 'transient'].map(id => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` })) as any[];
      useMediaStore.setState({
        deleteQueue: photos,
        photoProcessedIds: photos.map(asset => asset.id),
      });
      getAssetInfoAsync.mockImplementation(async (id: string) => {
        if (id === 'transient') throw new Error('Provider temporarily busy');
        throw exifError;
      });
      getAssetsAsync.mockResolvedValue({
        assets: [
          { id: 'a', mediaType: 'photo', uri: 'file:///a.jpg' },
          { id: 'b', mediaType: 'photo', uri: 'file:///b.jpg' },
        ],
        hasNextPage: false,
      });

      useMediaStore.getState().refreshQueuedAssetVisibility('limited', 'photo');
      await waitFor(() => expect(useMediaStore.getState().hiddenPhotoQueuedAssetIds).toEqual(['c', 'transient']));
      expect(getAssetsAsync).toHaveBeenCalledTimes(1);

      getAssetsAsync.mockClear();
      useMediaStore.getState().pruneUnavailableQueuedAssets('full', 'photo');
      await waitFor(() => expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['a', 'b', 'transient']));
      expect(getAssetsAsync).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
    }
  });

  it('keeps many pending items atomically in one store transition without touching excluded media', () => {
    const photos = Array.from({ length: 200 }, (_, index) => ({
      id: `p-${index}`,
      mediaType: 'photo',
      uri: `file:///p-${index}.jpg`,
    })) as any[];
    const video = { id: 'v-1', mediaType: 'video', uri: 'file:///v-1.mp4' } as any;
    useMediaStore.getState().enqueuePendingDeletion([...photos, video], 'photos');

    const notifications = jest.fn();
    const unsubscribe = useMediaStore.subscribe(notifications);
    try {
      const kept = useMediaStore.getState().keepAllPendingDeletion(photos.map(asset => asset.id));
      expect(kept).toBe(200);
      expect(notifications).toHaveBeenCalledTimes(1);
      expect(useMediaStore.getState().deleteQueue).toEqual([]);
      expect(useMediaStore.getState().videoTrashBin).toEqual([video]);
      expect(useMediaStore.getState().photoProcessedIds).toHaveLength(200);
      expect(Object.keys(useMediaStore.getState().pendingDeletionInfo)).toEqual(['v-1']);
    } finally {
      unsubscribe();
    }
  });

  it('blocks resetPhotoProgress, resetVideoProgress, and undoAction during an active record transfer and clears stale deletion metadata on reset', () => {
    const { acquireRecordOperation } = require('../services/recordOperationLock');
    const photo = { id: 'p-reset', mediaType: 'photo', uri: 'file:///p-reset.jpg' } as any;
    const video = { id: 'v-reset', mediaType: 'video', uri: 'file:///v-reset.mp4' } as any;
    useMediaStore.getState().enqueuePendingDeletion([photo, video], 'photos');
    useMediaStore.setState({
      lastDeletionResult: { status: 'cancelled', requestedIds: ['p-reset'], deletedIds: [], remainingIds: ['p-reset'], failureKind: 'cancelled' },
    });

    const release = acquireRecordOperation('backup')!;
    try {
      useMediaStore.getState().resetPhotoProgress();
      useMediaStore.getState().resetVideoProgress();
      useMediaStore.getState().undoAction('p-reset');
      expect(useMediaStore.getState().deleteQueue).toEqual([photo]);
      expect(useMediaStore.getState().videoTrashBin).toEqual([video]);
      expect(useMediaStore.getState().pendingDeletionInfo['p-reset']).toBeDefined();
      expect(useMediaStore.getState().lastDeletionResult).not.toBeNull();
    } finally {
      release();
    }

    useMediaStore.getState().resetPhotoProgress();
    expect(useMediaStore.getState().deleteQueue).toEqual([]);
    expect(useMediaStore.getState().pendingDeletionInfo['p-reset']).toBeUndefined();
    expect(useMediaStore.getState().pendingDeletionInfo['v-reset']).toBeDefined();
    expect(useMediaStore.getState().lastDeletionResult).toBeNull();

    useMediaStore.setState({
      lastDeletionResult: { status: 'failed', requestedIds: ['v-reset'], deletedIds: [], remainingIds: ['v-reset'], failureKind: 'failed' },
    });
    useMediaStore.getState().resetVideoProgress();
    expect(useMediaStore.getState().videoTrashBin).toEqual([]);
    expect(useMediaStore.getState().pendingDeletionInfo).toEqual({});
    expect(useMediaStore.getState().lastDeletionResult).toBeNull();
  });
});
