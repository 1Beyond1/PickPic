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
      isConfirmingDeletion: false,
      isConfirmingVideoTrash: false,
      hasPermission: true,
      permissionScope: 'full',
      hiddenPhotoQueuedAssetIds: null,
      hiddenVideoQueuedAssetIds: null,
    });
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
});
