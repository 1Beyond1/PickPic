jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  getAlbumsAsync: jest.fn(),
  getAssetsAsync: jest.fn(),
  addAssetsToAlbumAsync: jest.fn(),
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
    removeAssetAndDerivedData: jest.fn().mockResolvedValue(undefined),
    removeAssetsAndDerivedData: jest.fn().mockResolvedValue(undefined),
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
import { deleteAssetsInBatches } from '../services/mediaDeletion';
import * as protectedAlbumsService from '../services/protectedAlbums';
import { useMediaStore } from '../stores/useMediaStore';

const makePhoto = (id: string, albumId?: string) => ({
  id,
  filename: `${id}.jpg`,
  uri: `file:///${id}.jpg`,
  mediaType: 'photo' as const,
  width: 1200,
  height: 900,
  creationTime: 1000,
  modificationTime: 1000,
  duration: 0,
  ...(albumId ? { albumId } : {}),
});

describe('Protected Albums three-layer anti-accidental-deletion defense', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (protectedAlbumsService as any).__resetMockProtectedAlbums?.();
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([
      { id: 'alb-id-cards', title: 'ID Cards', assetCount: 2 },
      { id: 'alb-camera', title: 'Camera', assetCount: 5 },
      { id: 'alb-work', title: 'Work', assetCount: 1 },
      { id: 'alb-vault', title: 'Vault', assetCount: 1 },
    ] as any);
    jest.mocked(MediaLibrary.addAssetsToAlbumAsync).mockResolvedValue(true);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({
      assets: [],
      hasNextPage: false,
      endCursor: '',
      totalCount: 0,
    } as any);
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async (assetRef: any) => {
      const assetId = typeof assetRef === 'string' ? assetRef : assetRef.id;
      return { ...makePhoto(assetId) } as any;
    });
    jest.mocked(MediaLibrary.deleteAssetsAsync).mockResolvedValue(true);

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
      organizingSessions: { photo: null, video: null },
      photoProcessedIds: [],
      videoProcessedIds: [],
      protectedAlbums: [],
      protectedAssetIds: [],
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
      hasHydrated: true,
    });
  });

  it('Layer 1: excludes protected album photos from default unscoped swipe loading', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async (options?: any) => {
      if (options?.album === 'alb-id-cards') {
        return { assets: [makePhoto('passport-1', 'alb-id-cards')], hasNextPage: false, endCursor: '', totalCount: 1 } as any;
      }
      return {
        assets: [
          makePhoto('passport-1', 'alb-id-cards'),
          makePhoto('passport-2', 'alb-id-cards'),
          makePhoto('casual-1', 'alb-camera'),
        ],
        hasNextPage: false,
        endCursor: '',
        totalCount: 3,
      } as any;
    });

    await useMediaStore.getState().setProtectedAlbums([{ albumId: 'alb-id-cards', title: 'ID Cards' }]);
    await useMediaStore.getState().loadPhotos(10, 'newest', []);

    expect(useMediaStore.getState().photos.map(p => p.id)).toEqual(['casual-1']);
  });

  it('Layer 2: blocks markForDeletion and batch enqueuePendingDeletionWithReport for protected photos and returns exact skip counts', async () => {
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({
      assets: [makePhoto('id-by-membership')],
      hasNextPage: false,
      endCursor: '',
      totalCount: 1,
    } as any);

    await useMediaStore.getState().setProtectedAlbums([{ albumId: 'alb-id-cards', title: 'ID Cards' }]);

    // Blocked by albumId metadata.
    const singleResult = useMediaStore.getState().markForDeletion(makePhoto('doc-1', 'alb-id-cards'));
    expect(singleResult).toEqual({ added: 0, protectedSkipped: 1 });
    expect(useMediaStore.getState().deleteQueue).toEqual([]);
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);

    // Batch mixes protected-by-albumId, protected-by-membership-cache, and unprotected photos.
    const batchReport = useMediaStore.getState().enqueuePendingDeletionWithReport([
      makePhoto('doc-1', 'alb-id-cards'),
      makePhoto('id-by-membership'),
      makePhoto('normal-1', 'alb-camera'),
      makePhoto('normal-2', 'alb-camera'),
    ], 'blur');

    expect(batchReport).toEqual({
      added: 2,
      alreadyQueued: 0,
      protectedSkipped: 2,
      protectedAssetIds: ['doc-1', 'id-by-membership'],
    });
    expect(useMediaStore.getState().deleteQueue.map(p => p.id)).toEqual(['normal-1', 'normal-2']);
  });

  it('Layer 3: filters protected assets right before MediaLibrary.deleteAssetsAsync even if they were queued before protection was enabled', async () => {
    // Photo is queued BEFORE its album is protected.
    const protectedPhoto = makePhoto('work-1', 'alb-work');
    const normalPhoto = makePhoto('normal-1', 'alb-camera');
    useMediaStore.getState().enqueuePendingDeletion([protectedPhoto, normalPhoto], 'photos');
    expect(useMediaStore.getState().deleteQueue.map(p => p.id)).toEqual(['work-1', 'normal-1']);

    // Now the user protects 'alb-work' (e.g., via Settings or another flow).
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async (options?: any) => {
      if (options?.album === 'alb-work') {
        return { assets: [{ ...protectedPhoto, albumId: undefined }], hasNextPage: false, endCursor: '', totalCount: 1 } as any;
      }
      return { assets: [], hasNextPage: false, endCursor: '', totalCount: 0 } as any;
    });
    await useMediaStore.getState().setProtectedAlbums([{ albumId: 'alb-work', title: 'Work' }]);

    // Even if assetInfo omits albumId, Layer 3 queries the protected album and strips 'work-1'.
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async (assetRef: any) => {
      const assetId = typeof assetRef === 'string' ? assetRef : assetRef.id;
      return { ...makePhoto(assetId) } as any;
    });

    const result = await useMediaStore.getState().confirmPendingDeletion();

    expect(MediaLibrary.deleteAssetsAsync).toHaveBeenCalledTimes(1);
    expect(MediaLibrary.deleteAssetsAsync).toHaveBeenCalledWith(['normal-1']);
    expect(result.deletedIds).toEqual(['normal-1']);
    expect(result.remainingIds).toEqual(['work-1']);
    expect(result.protectedSkippedIds).toEqual(['work-1']);
    expect(result.status).toBe('partial');
  });

  it('Layer 3 fails closed and never invokes MediaLibrary.deleteAssetsAsync when protected album verification throws', async () => {
    const photo = makePhoto('maybe-protected');
    useMediaStore.setState({
      deleteQueue: [photo],
      photoProcessedIds: ['maybe-protected'],
      protectedAlbums: [{ albumId: 'alb-vault', title: 'Vault', createdAt: 1 }],
    });
    await protectedAlbumsService.saveProtectedAlbums([{ albumId: 'alb-vault', title: 'Vault', createdAt: 1 }]);

    // Album query throws while protected albums exist -> must fail closed and refuse deletion!
    jest.mocked(MediaLibrary.getAssetsAsync).mockRejectedValue(new Error('Provider error'));

    const result = await useMediaStore.getState().confirmPendingDeletion();

    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(result.deletedIds).toEqual([]);
    expect(result.protectedSkippedIds).toEqual(['maybe-protected']);
    expect(result.remainingIds).toEqual(['maybe-protected']);
    expect(result.status).toBe('protected');
  });

  it('deleteAssetsInBatches final guard strips protected IDs and albumIds before calling MediaLibrary.deleteAssetsAsync', async () => {
    const skipped: string[] = [];
    const deleted: string[] = [];
    await deleteAssetsInBatches(
      [makePhoto('p-protected', 'alb-secret'), makePhoto('p-id-protected'), makePhoto('p-ok', 'alb-cam')],
      batch => { deleted.push(...batch.map(item => item.id)); },
      {
        protectedAssetIds: new Set(['p-id-protected']),
        protectedAlbumIds: new Set(['alb-secret']),
        onProtectedSkipped: ids => skipped.push(...ids),
      },
    );

    expect(skipped).toEqual(['p-protected', 'p-id-protected']);
    expect(deleted).toEqual(['p-ok']);
    expect(MediaLibrary.deleteAssetsAsync).toHaveBeenCalledTimes(1);
    expect((MediaLibrary.deleteAssetsAsync as jest.Mock).mock.calls[0][0].map((a: any) => a.id)).toEqual(['p-ok']);
  });

  it('P0-2: never queries missing/deleted album IDs on iOS (preventing whole-library fallback DoS) and reports missingProtectedAlbumIds', async () => {
    const { Platform } = require('react-native');
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    try {
      jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([
        { id: 'alb-id-cards', title: 'ID Cards', assetCount: 1 },
      ] as any);
      jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async (options?: any) => {
        if (options?.album === 'alb-id-cards') {
          return { assets: [makePhoto('passport-1')], hasNextPage: false, endCursor: '', totalCount: 1 } as any;
        }
        // Simulate iOS native fallback: if a missing album were queried, it would return the whole library!
        return {
          assets: [makePhoto('passport-1'), makePhoto('casual-1'), makePhoto('casual-2')],
          hasNextPage: false,
          endCursor: '',
          totalCount: 3,
        } as any;
      });

      await useMediaStore.getState().setProtectedAlbums([
        { albumId: 'alb-id-cards', title: 'ID Cards' },
        { albumId: 'alb-deleted-ios', title: 'Deleted Album' },
      ]);

      expect(MediaLibrary.getAssetsAsync).not.toHaveBeenCalledWith(
        expect.objectContaining({ album: 'alb-deleted-ios' }),
      );
      expect(useMediaStore.getState().protectedAssetIds).toEqual(['passport-1']);
      expect(useMediaStore.getState().missingProtectedAlbumIds).toEqual(['alb-deleted-ios']);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
    }
  });

  it('P1-1: Layer 3 uses live enumeration instead of stale cache when an asset leaves a protected album or protection is removed', async () => {
    const movedPhoto = makePhoto('moved-out-1');
    useMediaStore.setState({
      deleteQueue: [movedPhoto],
      photoProcessedIds: ['moved-out-1'],
      protectedAlbums: [{ albumId: 'alb-id-cards', title: 'ID Cards', createdAt: 1 }],
      protectedAssetIds: ['moved-out-1'], // Stale cache from before photo moved out!
    });
    await protectedAlbumsService.saveProtectedAlbums([{ albumId: 'alb-id-cards', title: 'ID Cards', createdAt: 1 }]);
    // Live enumeration shows 'alb-id-cards' no longer contains 'moved-out-1'.
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({
      assets: [],
      hasNextPage: false,
      endCursor: '',
      totalCount: 0,
    } as any);

    const result = await useMediaStore.getState().confirmPendingDeletion();
    expect(MediaLibrary.deleteAssetsAsync).toHaveBeenCalledWith(['moved-out-1']);
    expect(result.deletedIds).toEqual(['moved-out-1']);
  });

  it('P1-1: blocks changeRecentDecision undo when restoring a now-protected photo back into pending deletion', async () => {
    const docPhoto = makePhoto('doc-undo-1', 'alb-id-cards');
    // 1. Queue before protection, then keep it so recentDecisions has an undo entry whose before.pending is non-null.
    useMediaStore.getState().enqueuePendingDeletion([docPhoto], 'photos');
    useMediaStore.getState().keepPendingDeletion(docPhoto.id);
    const keepEvent = useMediaStore.getState().recentDecisions[0];
    expect(keepEvent.before.pending).not.toBeNull();

    // 2. Enable protection on 'alb-id-cards'.
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({
      assets: [docPhoto],
      hasNextPage: false,
      endCursor: '',
      totalCount: 1,
    } as any);
    await useMediaStore.getState().setProtectedAlbums([{ albumId: 'alb-id-cards', title: 'ID Cards' }]);
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockResolvedValue(docPhoto as any);

    // 3. Undo must NOT push protected photo back into deleteQueue.
    const outcome = await useMediaStore.getState().changeRecentDecision(keepEvent.eventId, 'undo');
    expect(outcome).toBe('unchanged');
    expect(useMediaStore.getState().deleteQueue).toEqual([]);
  });

  it('P1-1: filters already-loaded unscoped feed when loadProtectedAlbums finishes and updates protection on addAssetToAlbum', async () => {
    const p1 = makePhoto('p-in-protected', 'alb-id-cards');
    const p2 = makePhoto('p-normal', 'alb-camera');
    useMediaStore.setState({ photos: [p1, p2], currentIndex: 0 });
    await protectedAlbumsService.saveProtectedAlbums([{ albumId: 'alb-id-cards', title: 'ID Cards', createdAt: 1 }]);
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({
      assets: [p1],
      hasNextPage: false,
      endCursor: '',
      totalCount: 1,
    } as any);

    await useMediaStore.getState().loadProtectedAlbums();
    expect(useMediaStore.getState().photos.map(p => p.id)).toEqual(['p-normal']);

    // Adding another photo into a protected album immediately marks it protected.
    const newlyAdded = makePhoto('p-newly-protected');
    await useMediaStore.getState().addAssetToAlbum('alb-id-cards', newlyAdded);
    expect(useMediaStore.getState().protectedAssetIds).toContain('p-newly-protected');
    expect(useMediaStore.getState().isAssetProtected(newlyAdded)).toBe(true);
  });
});
