import React from 'react';
import { act, fireEvent, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { ActivityIndicator, Image, Modal, StyleSheet } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

const mockMediaState = {
  permissionScope: 'full', mediaLibraryRefreshVersion: 0, permissionRefreshVersion: 0,
  lastDeletionResult: null as null | { status: string; requestedIds: string[]; deletedIds: string[]; remainingIds: string[]; failureKind: null },
  removeDeletedAssets: jest.fn(),
  deleteQueue: [] as any[], videoTrashBin: [], pendingDeletionInfo: {}, enqueuePendingDeletion: jest.fn(() => 1),
  photoProcessedIds: [] as string[], hasHydrated: true,
};
const mockGetSimilarSnapshotsBatch = jest.fn(async (..._args: any[]): Promise<Map<string, any>> => new Map());
const mockGetSimilarReviewsBatch = jest.fn(async (..._args: any[]): Promise<Map<string, any>> => new Map());
jest.mock('../database/db', () => ({ getDatabase: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../database/repositories/SimilarReviewRepository', () => ({
  SimilarReviewRepository: {
    getSnapshotsBatch: (...args: any[]) => mockGetSimilarSnapshotsBatch(...args),
    getReviewsBatch: (...args: any[]) => mockGetSimilarReviewsBatch(...args),
  },
  isSimilarReviewCurrent: jest.requireActual('../database/repositories/SimilarReviewRepository').isSimilarReviewCurrent,
}));
const mockRefreshAI = jest.fn().mockResolvedValue(undefined);
const mockRouter = { navigate: jest.fn() };
const mockCategory = {
  id: 'objects', title: 'Cat', count: 1,
  coverAsset: { asset_id: 'category-photo' },
  assets: [{ asset_id: 'category-photo' }],
};
const mockCategories = {
  peopleGroups: [], objectGroups: [mockCategory], uncategorizedGroup: null,
  isLoading: false, hasError: false, completedCount: 1, refresh: mockRefreshAI,
};
let mockClassificationEnabled = true;

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' }),
  getAssetInfoAsync: jest.fn(), getAssetsAsync: jest.fn(), deleteAssetsAsync: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 60, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../components/GlassContainer', () => ({ GlassContainer: ({ children }: any) => children }));
jest.mock('../components/SimilarGroupCard', () => ({ SimilarGroupCard: ({ onPress }: any) =>
  require('react').createElement(require('react-native').Pressable, { accessibilityRole: 'button', accessibilityLabel: 'Open group', onPress: () => onPress({ x: 0, y: 0, width: 80, height: 80 }) }) }));
jest.mock('../components/SimilarGroupDetailOverlay', () => ({ SimilarGroupDetailOverlay: ({ visible, onClose }: any) => visible
  ? require('react').createElement(require('react-native').Pressable, { accessibilityRole: 'button', accessibilityLabel: 'Close group', onPress: onClose }) : null }));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => ({ colors: {
    background: '#111', text: '#fff', textSecondary: '#aaa', primary: '#fff',
    danger: '#f00', dangerBackground: '#500', dangerForeground: '#fff',
  } }),
}));
jest.mock('../hooks/useAICategories', () => ({ useAICategories: () => mockCategories }));
jest.mock('../services/mediaProgressStorage', () => ({
  flushMediaProgress: jest.fn(async () => {}),
}));
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: () => ({ enableAIClassification: mockClassificationEnabled }) }));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: Object.assign((selector: any) => selector(mockMediaState), { getState: () => mockMediaState }),
  getCurrentlyVisibleAssetIds: jest.fn().mockImplementation(async (ids: string[]) => new Set(ids)),
}));
jest.mock('../database', () => ({
  AssetRepository: { getBlurryAssets: jest.fn(), getStatusCounts: jest.fn().mockResolvedValue({ pending: 0, done: 1, error: 0 }), removeAssetAndDerivedData: jest.fn() },
  DupGroupRepository: {
    getGroupsPage: jest.fn().mockResolvedValue([]),
    getGroupMembersBatch: jest.fn().mockResolvedValue(new Map()),
  },
}));

import ScanResultsScreen from '../app/(tabs)/scanResults';
import { AssetRepository, DupGroupRepository } from '../database';

describe('empty results and read failures', () => {
  beforeEach(() => {
    mockClassificationEnabled = true;
    mockMediaState.permissionScope = 'full';
    mockMediaState.mediaLibraryRefreshVersion = 0;
    mockMediaState.permissionRefreshVersion = 0;
    mockMediaState.lastDeletionResult = null;
    mockMediaState.deleteQueue = [];
    mockMediaState.photoProcessedIds = [];
    mockCategories.hasError = false;
    mockCategories.completedCount = 1;
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    (AssetRepository.getStatusCounts as jest.Mock).mockResolvedValue({ pending: 0, done: 1, error: 0 });
  });

  afterEach(() => {
    mockCategories.hasError = false;
    mockCategories.completedCount = 1;
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    (AssetRepository.getStatusCounts as jest.Mock).mockResolvedValue({ pending: 0, done: 1, error: 0 });
  });

  it('does not claim a clean scan when no visible photos have completed analysis', async () => {
    (AssetRepository.getStatusCounts as jest.Mock).mockResolvedValue({ pending: 3, done: 0, error: 2 });
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_results_not_ready');
    expect(screen.queryByText('scan_no_blurry')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_similar')); });
    expect(screen.queryByText('scan_no_similar')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'scan_open_settings' }));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/(tabs)/settings');
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('shows a read error, not a clean scan, and retries the same result surface', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (AssetRepository.getBlurryAssets as jest.Mock).mockRejectedValueOnce(new Error('SQLite busy'));
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_results_load_failed');
    expect(screen.queryByText('scan_no_blurry')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'retry' })); });
    expect(screen.getByText('scan_no_blurry')).toBeTruthy();
    expect(screen.queryByText('scan_results_load_failed')).toBeNull();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('does not show stale category cards as actionable after a category read failure', async () => {
    mockCategories.hasError = true;
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
    expect(screen.getByText('scan_results_load_failed')).toBeTruthy();
    expect(screen.queryByText('Cat')).toBeNull();
    mockRefreshAI.mockClear();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'retry' })); });
    expect(mockRefreshAI).toHaveBeenCalledTimes(1);
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('uses the visible permission scope, not hidden completed records, for the empty state', async () => {
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValue({ assets: [{ id: 'visible' }], hasNextPage: false });
    (AssetRepository.getStatusCounts as jest.Mock).mockResolvedValue({ pending: 0, done: 0, error: 0 });
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_results_not_ready');
    expect(AssetRepository.getStatusCounts).toHaveBeenCalledWith(['visible']);
    expect(AssetRepository.getBlurryAssets).toHaveBeenCalledWith(['visible'], 50, 0);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('keeps the existing no-match copy after some visible photos actually completed scanning', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_similar')); });
    expect(screen.getByText('scan_no_similar')).toBeTruthy();
    expect(screen.queryByText('scan_results_not_ready')).toBeNull();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('shows the same next step on an unscanned classification tab', async () => {
    const oldGroups = mockCategories.objectGroups;
    mockCategories.objectGroups = [];
    mockCategories.completedCount = 0;
    try {
      await renderAsync(<ScanResultsScreen />);
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
      expect(screen.getByText('scan_results_not_ready')).toBeTruthy();
      expect(screen.queryByText('scan_no_people')).toBeNull();
      fireEvent.press(screen.getByRole('button', { name: 'scan_open_settings' }));
      expect(mockRouter.navigate).toHaveBeenCalledWith('/(tabs)/settings');
      expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    } finally {
      mockCategories.objectGroups = oldGroups;
    }
  });

  it('ignores a stale failed read after a newer permission refresh has succeeded', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let fail!: (error: Error) => void;
    const stale = new Promise<never>((_resolve, reject) => { fail = reject; });
    (AssetRepository.getBlurryAssets as jest.Mock).mockReturnValueOnce(stale).mockResolvedValue([]);
    const view = await renderAsync(<ScanResultsScreen />);
    await waitFor(() => expect(AssetRepository.getBlurryAssets).toHaveBeenCalledTimes(1));
    mockMediaState.permissionRefreshVersion += 1;
    mockMediaState.mediaLibraryRefreshVersion += 1;
    await view.rerenderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fail(new Error('Old read failed')); });
    expect(screen.queryByText('scan_results_load_failed')).toBeNull();
    expect(screen.getByText('scan_no_blurry')).toBeTruthy();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });
});

describe('result navigation preserves media decisions', () => {
  beforeEach(() => {
    mockClassificationEnabled = true;
    mockMediaState.permissionScope = 'full';
    mockMediaState.mediaLibraryRefreshVersion = 0;
    mockMediaState.permissionRefreshVersion = 0;
    mockMediaState.lastDeletionResult = null;
    mockMediaState.deleteQueue = [];
    mockMediaState.photoProcessedIds = [];
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` }));
  });

  it('switches among all result types without deleting media or marking a group', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_similar')); });
    expect(screen.getByText('scan_no_similar')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
    expect(screen.getByText('Cat')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_blur')); });
    expect(screen.getByText('scan_no_blurry')).toBeTruthy();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
  });

  it('returns from a category on system back without changing the selected result tab', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
    fireEvent.press(screen.getByText('Cat'));
    const categoryModal = screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.presentationStyle === 'pageSheet')!;
    expect(categoryModal.props.visible).toBe(true);
    await act(async () => { fireEvent(categoryModal, 'requestClose'); });
    expect(categoryModal.props.visible).toBe(false);
    expect(screen.getByText('Cat')).toBeTruthy();
    expect(screen.queryByText('scan_no_blurry')).toBeNull();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
  });

  it('exposes named, selected, wrapping result tabs with at least 44dp targets', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    const blurry = screen.getByRole('tab', { name: 'scan_tab_blur' });
    const similar = screen.getByRole('tab', { name: 'scan_tab_similar' });
    const ai = screen.getByRole('tab', { name: 'scan_tab_ai' });
    expect(blurry).toBeSelected();
    expect(similar).not.toBeSelected();
    expect(ai).toHaveStyle({ minHeight: 44 });
    expect(screen.getByText('scan_tab_ai').props.numberOfLines).toBeUndefined();
    await act(async () => { fireEvent.press(ai); });
    expect(ai).toBeSelected();
    expect(blurry).not.toBeSelected();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('names a category entry and keeps its full title outside the media preview', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
    const category = screen.getByRole('button', { name: 'Cat, scan_photo_count' });
    expect(category).toBeEnabled();
    expect(screen.getByText('Cat').props.numberOfLines).toBeUndefined();
    await act(async () => { fireEvent.press(category); });
    expect(screen.getByRole('button', { name: 'scan_close_category' })).toBeTruthy();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('reserves the actual Dock and safe areas outside every result list', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    expect(screen.getByTestId('scan-results')).toHaveStyle({ paddingTop: 60, paddingBottom: 89, paddingLeft: 0, paddingRight: 0 });
    expect(screen.getByRole('header', { name: 'tab_scan_results' })).toHaveStyle({ fontSize: 22, lineHeight: 30 });
  });

  it('does not offer the AI tab when classification is disabled', async () => {
    mockClassificationEnabled = false;
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    expect(screen.queryByRole('tab', { name: 'scan_tab_ai' })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('hides the covered result controls from accessibility until the similar detail closes', async () => {
    (DupGroupRepository.getGroupsPage as jest.Mock).mockResolvedValue([{ group_id: 'group', representative_asset_id: 'first', best_asset_id: 'first' }]);
    (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockResolvedValue(new Map([['group', [{ group_id: 'group', asset_id: 'first', distance: 0 }, { group_id: 'group', asset_id: 'second', distance: 1 }]]]));
    const view = await renderAsync(<ScanResultsScreen />);
    try {
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_similar')); });
      fireEvent.press(await screen.findByRole('button', { name: 'Open group' }));
      expect(screen.getByTestId('scan-results-main', { includeHiddenElements: true }).props).toMatchObject({ accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' });
      expect(screen.queryByRole('tab', { name: 'scan_tab_similar' })).toBeNull();
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Close group' })); });
      expect(screen.getByTestId('scan-results-main').props).toMatchObject({ accessibilityElementsHidden: false, importantForAccessibility: 'auto' });
      expect(screen.getByRole('tab', { name: 'scan_tab_similar' })).toBeSelected();
      expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    } finally {
      await view.unmountAsync();
      (DupGroupRepository.getGroupsPage as jest.Mock).mockResolvedValue([]);
      (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockResolvedValue(new Map());
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function openPhoto(beforePreview?: () => void) {
  const view = await renderAsync(<ScanResultsScreen />);
  await screen.findByText('scan_no_blurry');
  await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
  await act(async () => { fireEvent.press(screen.getByText('Cat')); });
  const grid = screen.UNSAFE_root.findAll((node: { props: any }) => node.props.onPress && StyleSheet.flatten(node.props.style)?.aspectRatio === 1)[0];
  expect(grid).toBeDefined();
  beforePreview?.();
  await act(async () => { fireEvent.press(grid!); });
  return view;
}

describe('scan result deletion safety', () => {
  beforeEach(() => {
    mockClassificationEnabled = true;
    mockMediaState.mediaLibraryRefreshVersion = 0;
    mockMediaState.permissionRefreshVersion = 0;
    mockMediaState.lastDeletionResult = null;
    mockMediaState.deleteQueue = [];
    mockMediaState.permissionScope = 'full';
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([
      { asset_id: 'blurred', blur_score: 12, mean_luma: 80 },
    ]);
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` }));
    (MediaLibrary.deleteAssetsAsync as jest.Mock).mockResolvedValue(true);
    (AssetRepository.removeAssetAndDerivedData as jest.Mock).mockResolvedValue(undefined);
  });

  it('adds a blurry result to pending deletion without a system deletion or index removal', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_blur_score');
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'pending_add' })); });
    expect(mockMediaState.enqueuePendingDeletion).toHaveBeenCalledWith([expect.objectContaining({ id: 'blurred', mediaType: 'photo' })], 'blur');
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
    expect(AssetRepository.removeAssetAndDerivedData).not.toHaveBeenCalled();
    expect(screen.getByText('pending_added')).toBeTruthy();
  });

  it('locks during an asset read and leaves the queue unchanged when that read fails', async () => {
    const info = deferred<any>();
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_blur_score');
    mockMediaState.enqueuePendingDeletion.mockClear();
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockReturnValueOnce(info.promise);
    fireEvent.press(screen.getByRole('button', { name: 'pending_add' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'pending_add' })).toBeDisabled());
    fireEvent.press(screen.getByRole('button', { name: 'pending_add' }));
    await act(async () => { info.reject(new Error('Synthetic unavailable photo')); });
    expect(screen.getByRole('button', { name: 'pending_add' })).toBeEnabled();
    expect(screen.getByText('pending_add_failed')).toBeTruthy();
    expect(mockMediaState.enqueuePendingDeletion).not.toHaveBeenCalled();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('shows a classification queue decision inside the open photo preview without physically deleting', async () => {
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    await openPhoto();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'pending_add' })); });
    await waitFor(() => expect(screen.getByTestId('category-queue-feedback').props.children).toBe('pending_added'));
    expect(mockMediaState.enqueuePendingDeletion).toHaveBeenCalledWith([expect.objectContaining({ id: 'category-photo', mediaType: 'photo' })], 'classification');
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('category-photo-preview')).toBeTruthy();
  });

  it('fails closed on denied permission without queueing or requesting deletion', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_blur_score');
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    mockMediaState.enqueuePendingDeletion.mockClear();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'pending_add' })); });
    expect(screen.getByText('pending_add_failed')).toBeTruthy();
    expect(mockMediaState.enqueuePendingDeletion).not.toHaveBeenCalled();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('does not republish a delayed full-access result after the visible media selection changes', async () => {
    const staleRead = deferred<{ asset_id: string; blur_score: number; mean_luma: number }[]>();
    (AssetRepository.getBlurryAssets as jest.Mock).mockReturnValueOnce(staleRead.promise).mockResolvedValue([]);
    const view = await renderAsync(<ScanResultsScreen />);
    await waitFor(() => expect(AssetRepository.getBlurryAssets).toHaveBeenCalledTimes(1));
    mockMediaState.permissionRefreshVersion += 1;
    mockMediaState.mediaLibraryRefreshVersion += 1;
    await view.rerenderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { staleRead.resolve([{ asset_id: 'old-hidden', blur_score: 5, mean_luma: 90 }]); });
    expect(screen.queryByText('scan_blur_score')).toBeNull();
    expect(screen.queryByRole('button', { name: 'scan_delete_blurry_title' })).toBeNull();
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
  });
});

describe('category photo viewing', () => {
  beforeEach(() => {
    mockClassificationEnabled = true;
    mockMediaState.mediaLibraryRefreshVersion = 0;
    mockMediaState.permissionRefreshVersion = 0;
    mockMediaState.lastDeletionResult = null;
    mockMediaState.deleteQueue = [];
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    (AssetRepository.getBlurryAssets as jest.Mock).mockReset().mockResolvedValue([]);
    (DupGroupRepository.getGroupsPage as jest.Mock).mockReset().mockResolvedValue([]);
    (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockReset().mockResolvedValue(new Map());
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` }));
  });

  it('provides a named and reachable category close control without changing media', async () => {
    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
    await act(async () => { fireEvent.press(screen.getByText('Cat')); });
    const close = screen.getByRole('button', { name: 'scan_close_category' });
    expect(StyleSheet.flatten(close.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
    fireEvent.press(close);
    expect(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.presentationStyle === 'pageSheet')?.props.visible).toBe(false);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
  });

  it('dismisses a readable preview with the visible close button and keeps its category open', async () => {
    await openPhoto();
    await waitFor(() => expect(screen.UNSAFE_getAllByType(Image).some(image => (
      image.props.source.uri === 'file:///category-photo.jpg'
      && image.props.contentFit === 'contain'
      && image.props.cachePolicy === 'memory'
    ))).toBe(true));
    fireEvent.press(screen.getByRole('button', { name: 'close' }));
    expect(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.transparent)?.props.visible).toBe(false);
    expect(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.presentationStyle === 'pageSheet')?.props.visible).toBe(true);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
  });

  it('gives each category photo a named open action rather than an unnamed image target', async () => {
    const view = await renderAsync(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
    await act(async () => { fireEvent.press(screen.getByText('Cat')); });
    const photo = screen.getByRole('button', { name: 'scan_open_category_photo' });
    await act(async () => { fireEvent.press(photo); });
    expect(screen.getByRole('button', { name: 'close' })).toBeTruthy();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    await view.unmountAsync();
  });

  it('keeps long category headings flexible while reserving a non-shrinking close target', async () => {
    const originalTitle = mockCategory.title;
    mockCategory.title = 'A category with a long translated title';
    try {
      await renderAsync(<ScanResultsScreen />);
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: `${mockCategory.title}, scan_photo_count` })); });
      const title = screen.getByRole('header', { name: mockCategory.title });
      expect(title.props.numberOfLines).toBeUndefined();
      expect(screen.getByTestId('category-heading')).toHaveStyle({ flex: 1, minWidth: 0 });
      expect(screen.getByRole('button', { name: 'scan_close_category' })).toHaveStyle({ flexShrink: 0, minWidth: 44, minHeight: 44 });
      expect(screen.getByTestId('category-detail')).toHaveStyle({ paddingTop: 68, paddingBottom: 24 });
    } finally {
      mockCategory.title = originalTitle;
    }
  });

  it('keeps a partially populated grid row at three-column widths and the preview outside the toolbar', async () => {
    await openPhoto();
    expect(screen.getByRole('button', { name: 'scan_open_category_photo', includeHiddenElements: true })).toHaveStyle({ width: '33.333333%', aspectRatio: 1 });
    expect(screen.getByTestId('category-photo-preview')).toHaveStyle({ paddingTop: 68, paddingBottom: 24 });
    const close = screen.getByRole('button', { name: 'close' });
    expect(close).toHaveStyle({ flexShrink: 0, minWidth: 44, minHeight: 44 });
    expect(StyleSheet.flatten(close.props.style).position).not.toBe('absolute');
    expect(screen.getByRole('image', { name: 'photo_detail_title' })).toBeTruthy();
  });

  it('replaces a rejected media lookup with visible feedback and allows retry without closing the viewer', async () => {
    await openPhoto(() => {
      (MediaLibrary.getAssetInfoAsync as jest.Mock).mockRejectedValueOnce(new Error('Native media unavailable'));
    });
    await screen.findByText('scan_photo_unavailable');
    fireEvent.press(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.queryByText('scan_photo_unavailable')).toBeNull());
    expect(screen.UNSAFE_getAllByType(Image).some(image => image.props.contentFit === 'contain' && image.props.cachePolicy === 'memory')).toBe(true);
    expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
  });

  it('reports a missing URI and a native image decoding failure rather than spinning forever', async () => {
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValue({});
    await openPhoto();
    await screen.findByText('scan_photo_unavailable');
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValue({ uri: 'file:///category-photo.jpg' });
    fireEvent.press(screen.getByRole('button', { name: 'retry' }));
    const image = await waitFor(() => {
      const viewerImage = screen.UNSAFE_getAllByType(Image).find(item => item.props.contentFit === 'contain');
      expect(viewerImage).toBeDefined();
      return viewerImage!;
    });
    fireEvent(image, 'error', { nativeEvent: { error: 'Decoder failed' } });
    expect(screen.getByText('scan_photo_unavailable')).toBeTruthy();
  });

  it('opens a readable photo and lets system back return to its category without changing data', async () => {
    await openPhoto();
    await waitFor(() => expect(screen.UNSAFE_getAllByType(Image).some(image => (
      image.props.contentFit === 'contain' && image.props.source.uri === 'file:///category-photo.jpg'
    ))).toBe(true));
    const viewer = screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.transparent)!;
    fireEvent(viewer, 'requestClose');
    expect(viewer.props.visible).toBe(false);
    expect(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.presentationStyle === 'pageSheet')?.props.visible).toBe(true);
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('keeps an identifiable close control usable even when a photo fails to open', async () => {
    await openPhoto(() => {
      (MediaLibrary.getAssetInfoAsync as jest.Mock).mockRejectedValueOnce(new Error('Unavailable'));
    });
    await screen.findByText('scan_photo_unavailable');
    const close = screen.getByRole('button', { name: 'close' });
    const controlStyle = StyleSheet.flatten(close.props.style);
    expect(screen.getByTestId('category-photo-preview')).toHaveStyle({ backgroundColor: '#111' });
    expect(controlStyle.flexShrink).toBe(0);
    expect(controlStyle.minWidth).toBeGreaterThanOrEqual(44);
    expect(controlStyle.minHeight).toBeGreaterThanOrEqual(44);
    fireEvent.press(close);
    expect(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.transparent)?.props.visible).toBe(false);
    expect(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.presentationStyle === 'pageSheet')?.props.visible).toBe(true);
  });

  it('closes nested viewers on a media scope refresh and ignores the pending old lookup', async () => {
    const lookup = deferred<{ uri: string }>();
    const view = await openPhoto(() => {
      (MediaLibrary.getAssetInfoAsync as jest.Mock).mockReturnValueOnce(lookup.promise);
    });
    mockMediaState.permissionRefreshVersion += 1;
    mockMediaState.mediaLibraryRefreshVersion += 1;
    await view.rerenderAsync(<ScanResultsScreen />);
    await act(async () => { lookup.resolve({ uri: 'file:///stale.jpg' }); await lookup.promise; });
    expect(screen.UNSAFE_getAllByType(Modal).every(modal => !modal.props.visible)).toBe(true);
    expect(screen.UNSAFE_getAllByType(Image).some(image => image.props.source.uri === 'file:///stale.jpg')).toBe(false);
  });

  it('batches Android EXIF fallback into one scan across blurry photos and similar groups', async () => {
    const { Platform } = require('react-native');
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    try {
      (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([
        { asset_id: 'blur-1', blur_score: 10, mean_luma: 80 },
        { asset_id: 'blur-2', blur_score: 20, mean_luma: 90 },
      ]);
      (DupGroupRepository.getGroupsPage as jest.Mock).mockResolvedValue([
        { group_id: 'group-1', representative_asset_id: 'sim-1', best_asset_id: 'sim-1' },
      ]);
      (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockResolvedValue(new Map([
        ['group-1', [{ group_id: 'group-1', asset_id: 'sim-1', distance: 0 }, { group_id: 'group-1', asset_id: 'sim-2', distance: 1 }]],
      ]));
      (MediaLibrary.getAssetInfoAsync as jest.Mock).mockRejectedValue(new Error('Missing ACCESS_MEDIA_LOCATION permission'));
      (MediaLibrary.getAssetsAsync as jest.Mock).mockClear();
      (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValue({
        assets: ['blur-1', 'blur-2', 'sim-1', 'sim-2'].map(id => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` })),
        hasNextPage: false,
      });

      await renderAsync(<ScanResultsScreen />);
      await waitFor(() => expect(screen.getAllByText('scan_blur_score')).toHaveLength(2));
      expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
      (DupGroupRepository.getGroupsPage as jest.Mock).mockResolvedValue([]);
      (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockResolvedValue(new Map());
    }
  });

  it('paginates blurry photos beyond 50 items via onEndReached without dropping earlier rows', async () => {
    const page1 = Array.from({ length: 50 }, (_, idx) => ({ asset_id: `blur-${idx}`, blur_score: idx + 1, mean_luma: 80 }));
    const page2 = Array.from({ length: 12 }, (_, idx) => ({ asset_id: `blur-${50 + idx}`, blur_score: 51 + idx, mean_luma: 85 }));
    (AssetRepository.getBlurryAssets as jest.Mock)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    (DupGroupRepository.getGroupsPage as jest.Mock).mockResolvedValue([]);
    (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockResolvedValue(new Map());

    await renderAsync(<ScanResultsScreen />);
    const blurryList = await screen.findByTestId('blurry-results-list');
    expect(blurryList.props.data).toHaveLength(50);
    expect(AssetRepository.getBlurryAssets).toHaveBeenCalledWith(undefined, 50, 0);

    await act(async () => { blurryList.props.onEndReached(); });
    await waitFor(() => expect(screen.getByTestId('blurry-results-list').props.data).toHaveLength(62));
    expect(AssetRepository.getBlurryAssets).toHaveBeenNthCalledWith(2, undefined, 50, 0, {
      blurScore: 50,
      assetId: 'blur-49',
    });
  });

  it('loads similar groups with batched SQL queries and paginates subsequent pages on scroll', async () => {
    const makePage = (start: number, count: number) => Array.from({ length: count }, (_, idx) => ({
      group_id: `grp-${start + idx}`,
      representative_asset_id: `a-${start + idx}`,
      best_asset_id: `a-${start + idx}`,
      created_at: 1000 - (start + idx),
    }));
    const page1 = makePage(0, 30);
    const page2 = makePage(30, 5);
    const membersFor = (groups: typeof page1) => new Map(
      groups.map(group => [
        group.group_id,
        [
          { group_id: group.group_id, asset_id: `a-${group.group_id}`, distance: 0 },
          { group_id: group.group_id, asset_id: `b-${group.group_id}`, distance: 1 },
        ],
      ]),
    );
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    (DupGroupRepository.getGroupsPage as jest.Mock)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    (DupGroupRepository.getGroupMembersBatch as jest.Mock)
      .mockResolvedValueOnce(membersFor(page1))
      .mockResolvedValueOnce(membersFor(page2));
    mockGetSimilarSnapshotsBatch.mockClear();
    mockGetSimilarReviewsBatch.mockClear();

    try {
      await renderAsync(<ScanResultsScreen />);
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_similar')); });

      const similarList = await screen.findByTestId('similar-results-list');
      expect(similarList.props.data).toHaveLength(30);
      // 30 groups resolved with O(1) batch calls instead of 2N/3N per-group SQL queries.
      expect(DupGroupRepository.getGroupMembersBatch).toHaveBeenCalledTimes(1);
      expect(mockGetSimilarSnapshotsBatch).toHaveBeenCalledTimes(1);
      expect(mockGetSimilarReviewsBatch).toHaveBeenCalledTimes(1);

      await act(async () => { similarList.props.onEndReached(); });
      await waitFor(() => expect(screen.getByTestId('similar-results-list').props.data).toHaveLength(35));
      expect(DupGroupRepository.getGroupsPage).toHaveBeenNthCalledWith(2, {
        limit: 30,
        cursor: { createdAt: 971, groupId: 'grp-29' },
        repair: false,
      });
      expect(DupGroupRepository.getGroupMembersBatch).toHaveBeenCalledTimes(2);
      expect(mockGetSimilarSnapshotsBatch).toHaveBeenCalledTimes(2);
      expect(mockGetSimilarReviewsBatch).toHaveBeenCalledTimes(2);
    } finally {
      (DupGroupRepository.getGroupsPage as jest.Mock).mockResolvedValue([]);
      (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockResolvedValue(new Map());
    }
  });

  it('virtualizes the category photo grid and caches prefetched thumbnail URIs in memory per refresh version', async () => {
    const manyAssets = Array.from({ length: 85 }, (_, idx) => ({ asset_id: `cat-photo-${idx}` }));
    const originalAssets = mockCategory.assets;
    const originalCount = mockCategory.count;
    mockCategory.assets = manyAssets;
    mockCategory.count = manyAssets.length;
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockClear();

    try {
      await renderAsync(<ScanResultsScreen />);
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
      await act(async () => { fireEvent.press(screen.getByText('Cat')); });

      const grid = await screen.findByTestId('category-detail-grid');
      expect(grid.props.windowSize).toBe(5);
      expect(grid.props.initialNumToRender).toBe(18);
      expect(grid.props.maxToRenderPerBatch).toBe(15);
      expect(grid.props.removeClippedSubviews).toBe(true);

      // Initial window prefetches only the first 60 thumbnails, not all 85 upfront.
      await waitFor(() => expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('cat-photo-59', { shouldDownloadFromNetwork: false }));
      expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalledWith('cat-photo-60', { shouldDownloadFromNetwork: false });

      // Closing and reopening within the same refresh version hits the in-memory URI cache.
      fireEvent.press(screen.getByRole('button', { name: 'scan_close_category' }));
      (MediaLibrary.getAssetInfoAsync as jest.Mock).mockClear();
      await act(async () => { fireEvent.press(screen.getByText('Cat')); });
      await screen.findByTestId('category-detail-grid');
      expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();

      // Scrolling to the end loads the remaining 25 thumbnails.
      await act(async () => { screen.getByTestId('category-detail-grid').props.onEndReached(); });
      await waitFor(() => expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('cat-photo-84', { shouldDownloadFromNetwork: false }));
    } finally {
      mockCategory.assets = originalAssets;
      mockCategory.count = originalCount;
    }
  });

  it('loads category thumbnails immediately when jumping to items 100, 500, and 2000 via onViewableItemsChanged (>120 deadlock fix)', async () => {
    const hugeAssets = Array.from({ length: 2200 }, (_, idx) => ({ asset_id: `huge-cat-${idx}` }));
    const originalAssets = mockCategory.assets;
    const originalCount = mockCategory.count;
    mockCategory.assets = hugeAssets;
    mockCategory.count = hugeAssets.length;
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockClear();

    try {
      await renderAsync(<ScanResultsScreen />);
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
      await act(async () => { fireEvent.press(screen.getByText('Cat')); });

      const grid = await screen.findByTestId('category-detail-grid');
      await waitFor(() => expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('huge-cat-59', { shouldDownloadFromNetwork: false }));

      // Jump directly to item 100, 500, and 2000 without ever firing onEndReached at the bottom!
      for (const targetIndex of [100, 500, 2000]) {
        await act(async () => {
          screen.getByTestId('category-detail-grid').props.onViewableItemsChanged({
            viewableItems: [{ item: hugeAssets[targetIndex], index: targetIndex, isViewable: true }],
          });
        });
        await waitFor(() => expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith(
          `huge-cat-${targetIndex}`,
          { shouldDownloadFromNetwork: false },
        ));
        expect(screen.getByTestId('category-detail-grid').props.extraData[`huge-cat-${targetIndex}`]).toBe(`file:///huge-cat-${targetIndex}.jpg`);
      }

      // Bounded detail URI map never exceeds CATEGORY_URI_CACHE_MAX (600).
      expect(Object.keys(screen.getByTestId('category-detail-grid').props.extraData).length).toBeLessThanOrEqual(600);
    } finally {
      mockCategory.assets = originalAssets;
      mockCategory.count = originalCount;
    }
  });

  it('continues past empty filtered similar pages under limited access with a loop bound instead of falsely reporting empty', async () => {
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValue({
      assets: [{ id: 'vis-a' }, { id: 'vis-b' }],
      hasNextPage: false,
    });
    const hiddenPage = Array.from({ length: 30 }, (_, idx) => ({
      group_id: `hid-${idx}`,
      representative_asset_id: `h-a-${idx}`,
      best_asset_id: `h-a-${idx}`,
      created_at: 2000 - idx,
    }));
    const visiblePage = [
      { group_id: 'vis-group', representative_asset_id: 'vis-a', best_asset_id: 'vis-a', created_at: 500 },
    ];
    (DupGroupRepository.getGroupsPage as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(hiddenPage)
      .mockResolvedValueOnce(visiblePage);
    (DupGroupRepository.getGroupMembersBatch as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(new Map(hiddenPage.map(g => [g.group_id, [
        { group_id: g.group_id, asset_id: `h-a-${g.group_id}`, distance: 0 },
        { group_id: g.group_id, asset_id: `h-b-${g.group_id}`, distance: 1 },
      ]])))
      .mockResolvedValueOnce(new Map([['vis-group', [
        { group_id: 'vis-group', asset_id: 'vis-a', distance: 0 },
        { group_id: 'vis-group', asset_id: 'vis-b', distance: 1 },
      ]]]));

    try {
      await renderAsync(<ScanResultsScreen />);
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_similar')); });

      const similarList = await screen.findByTestId('similar-results-list');
      expect(similarList.props.data.map((g: any) => g.groupId)).toEqual(['vis-group']);
      expect(screen.queryByText('scan_no_similar')).toBeNull();
      expect(DupGroupRepository.getGroupsPage).toHaveBeenCalledTimes(2);
    } finally {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'all' });
      (DupGroupRepository.getGroupsPage as jest.Mock).mockReset().mockResolvedValue([]);
      (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockReset().mockResolvedValue(new Map());
    }
  });

  it('caps empty filtered page continuation at MAX_FILTER_SKIP_PAGES to prevent infinite loops', async () => {
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValue({
      assets: [{ id: 'unrelated-visible' }],
      hasNextPage: false,
    });
    let pageCounter = 0;
    (DupGroupRepository.getGroupsPage as jest.Mock).mockReset().mockImplementation(async () => {
      pageCounter += 1;
      return Array.from({ length: 30 }, (_, idx) => ({
        group_id: `loop-p${pageCounter}-${idx}`,
        representative_asset_id: `x-${pageCounter}-${idx}`,
        best_asset_id: `x-${pageCounter}-${idx}`,
        created_at: 10000 - pageCounter * 100 - idx,
      }));
    });
    (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockReset().mockImplementation(async (ids: string[]) => new Map(
      ids.map(id => [id, [
        { group_id: id, asset_id: `hid-a-${id}`, distance: 0 },
        { group_id: id, asset_id: `hid-b-${id}`, distance: 1 },
      ]]),
    ));

    try {
      await renderAsync(<ScanResultsScreen />);
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_similar')); });
      await screen.findByText('scan_no_similar');
      // Bounded to exactly 10 pages total (1 initial + 9 continuation pages).
      expect(DupGroupRepository.getGroupsPage).toHaveBeenCalledTimes(10);
    } finally {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'all' });
      (DupGroupRepository.getGroupsPage as jest.Mock).mockReset().mockResolvedValue([]);
      (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockReset().mockResolvedValue(new Map());
    }
  });

  it('preserves pagination and open modals on unrelated incremental mediaLibraryRefreshVersion events, and avoids resetting page on inspect-only overlay close', async () => {
    const page1 = Array.from({ length: 30 }, (_, idx) => ({
      group_id: `stay-${idx}`,
      representative_asset_id: `sa-${idx}`,
      best_asset_id: `sa-${idx}`,
      created_at: 1000 - idx,
    }));
    const page2 = [
      { group_id: 'stay-30', representative_asset_id: 'sa-30', best_asset_id: 'sa-30', created_at: 900 },
    ];
    const membersFor = (groups: typeof page1) => new Map(
      groups.map(g => [g.group_id, [
        { group_id: g.group_id, asset_id: `a-${g.group_id}`, distance: 0 },
        { group_id: g.group_id, asset_id: `b-${g.group_id}`, distance: 1 },
      ]]),
    );
    (DupGroupRepository.getGroupsPage as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    (DupGroupRepository.getGroupMembersBatch as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(membersFor(page1))
      .mockResolvedValueOnce(membersFor(page2));

    try {
      const view = await renderAsync(<ScanResultsScreen />);
      await screen.findByText('scan_no_blurry');
      await act(async () => { fireEvent.press(screen.getByText('scan_tab_similar')); });
      const similarList = await screen.findByTestId('similar-results-list');
      await act(async () => { similarList.props.onEndReached(); });
      await waitFor(() => expect(screen.getByTestId('similar-results-list').props.data).toHaveLength(31));

      // Open and close SimilarGroupDetailOverlay without mutating -> must NOT reload or reset to page 1!
      const callsBeforeInspect = (DupGroupRepository.getGroupsPage as jest.Mock).mock.calls.length;
      fireEvent.press(screen.getAllByRole('button', { name: 'Open group' })[0]);
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Close group' })); });
      expect(DupGroupRepository.getGroupsPage).toHaveBeenCalledTimes(callsBeforeInspect);
      expect(screen.getByTestId('similar-results-list').props.data).toHaveLength(31);

      // Unrelated external screenshot bumps mediaLibraryRefreshVersion (not permissionRefreshVersion):
      // loaded pages must NOT be wiped!
      mockMediaState.mediaLibraryRefreshVersion += 1;
      await view.rerenderAsync(<ScanResultsScreen />);
      expect(screen.getByTestId('similar-results-list').props.data).toHaveLength(31);
      expect(DupGroupRepository.getGroupsPage).toHaveBeenCalledTimes(callsBeforeInspect);
    } finally {
      (DupGroupRepository.getGroupsPage as jest.Mock).mockReset().mockResolvedValue([]);
      (DupGroupRepository.getGroupMembersBatch as jest.Mock).mockReset().mockResolvedValue(new Map());
    }
  });

  it('shows a pending-deletion badge on queued blurry rows and syncs immediately after confirmPendingDeletion', async () => {
    mockMediaState.deleteQueue = [{ id: 'blur-queued', mediaType: 'photo', uri: 'file:///blur-queued.jpg' }];
    (AssetRepository.getBlurryAssets as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce([
        { asset_id: 'blur-queued', blur_score: 12, mean_luma: 90 },
        { asset_id: 'blur-other', blur_score: 18, mean_luma: 95 },
      ])
      .mockResolvedValueOnce([
        { asset_id: 'blur-other', blur_score: 18, mean_luma: 95 },
      ]);

    const view = await renderAsync(<ScanResultsScreen />);
    await screen.findByTestId('blurry-queued-badge-blur-queued');
    expect(screen.queryByTestId('blurry-queued-badge-blur-other')).toBeNull();
    expect(screen.getByTestId('blurry-results-list').props.data).toHaveLength(2);

    // Simulate confirmPendingDeletion completing deletion of 'blur-queued'.
    mockMediaState.deleteQueue = [];
    mockMediaState.lastDeletionResult = {
      status: 'success',
      requestedIds: ['blur-queued'],
      deletedIds: ['blur-queued'],
      remainingIds: [],
      failureKind: null,
    };
    await view.rerenderAsync(<ScanResultsScreen />);
    await waitFor(() => expect(screen.getByTestId('blurry-results-list').props.data.map((i: any) => i.assetId)).toEqual(['blur-other']));
  });
});
