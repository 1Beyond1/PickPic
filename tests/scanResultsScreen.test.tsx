import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActivityIndicator, Alert, Image, Modal, StyleSheet } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

const mockMediaState = {
  permissionScope: 'full', mediaLibraryRefreshVersion: 0,
  removeDeletedAssets: jest.fn(),
};
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
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: () => ({ enableAIClassification: mockClassificationEnabled }) }));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: Object.assign((selector: any) => selector(mockMediaState), { getState: () => mockMediaState }),
  getCurrentlyVisibleAssetIds: jest.fn().mockImplementation(async (ids: string[]) => new Set(ids)),
}));
jest.mock('../database', () => ({
  AssetRepository: { getBlurryAssets: jest.fn(), getStatusCounts: jest.fn().mockResolvedValue({ pending: 0, done: 1, error: 0 }), removeAssetAndDerivedData: jest.fn() },
  DupGroupRepository: { getAllGroups: jest.fn().mockResolvedValue([]), getGroupMembers: jest.fn() },
}));

import ScanResultsScreen from '../app/(tabs)/scanResults';
import { AssetRepository, DupGroupRepository } from '../database';
import { getCurrentlyVisibleAssetIds } from '../stores/useMediaStore';

describe('empty results and read failures', () => {
  beforeEach(() => {
    mockClassificationEnabled = true;
    mockMediaState.permissionScope = 'full';
    mockMediaState.mediaLibraryRefreshVersion = 0;
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
    render(<ScanResultsScreen />);
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
    render(<ScanResultsScreen />);
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
    render(<ScanResultsScreen />);
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
    render(<ScanResultsScreen />);
    await screen.findByText('scan_results_not_ready');
    expect(AssetRepository.getStatusCounts).toHaveBeenCalledWith(['visible']);
    expect(AssetRepository.getBlurryAssets).toHaveBeenCalledWith(['visible'], 50);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('keeps the existing no-match copy after some visible photos actually completed scanning', async () => {
    render(<ScanResultsScreen />);
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
      render(<ScanResultsScreen />);
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
    const view = render(<ScanResultsScreen />);
    await waitFor(() => expect(AssetRepository.getBlurryAssets).toHaveBeenCalledTimes(1));
    mockMediaState.mediaLibraryRefreshVersion += 1;
    view.rerender(<ScanResultsScreen />);
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
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ uri: `file:///${id}.jpg` }));
  });

  it('switches among all result types without deleting media or marking a group', async () => {
    render(<ScanResultsScreen />);
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
    render(<ScanResultsScreen />);
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
    render(<ScanResultsScreen />);
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
    render(<ScanResultsScreen />);
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
    render(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    expect(screen.getByTestId('scan-results')).toHaveStyle({ paddingTop: 60, paddingBottom: 89, paddingLeft: 0, paddingRight: 0 });
    expect(screen.getByRole('header', { name: 'tab_scan_results' })).toHaveStyle({ fontSize: 22, lineHeight: 30 });
  });

  it('does not offer the AI tab when classification is disabled', async () => {
    mockClassificationEnabled = false;
    render(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    expect(screen.queryByRole('tab', { name: 'scan_tab_ai' })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('hides the covered result controls from accessibility until the similar detail closes', async () => {
    (DupGroupRepository.getAllGroups as jest.Mock).mockResolvedValue([{ group_id: 'group', representative_asset_id: 'first', best_asset_id: 'first' }]);
    (DupGroupRepository.getGroupMembers as jest.Mock).mockResolvedValue([{ asset_id: 'first' }, { asset_id: 'second' }]);
    const view = render(<ScanResultsScreen />);
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
      view.unmount();
      (DupGroupRepository.getAllGroups as jest.Mock).mockResolvedValue([]);
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
  const view = render(<ScanResultsScreen />);
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
    mockMediaState.permissionScope = 'full';
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([
      { asset_id: 'blurred', blur_score: 12, mean_luma: 80 },
    ]);
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ uri: `file:///${id}.jpg` }));
    (getCurrentlyVisibleAssetIds as jest.Mock).mockImplementation(async (ids: string[]) => new Set(ids));
    (MediaLibrary.deleteAssetsAsync as jest.Mock).mockResolvedValue(true);
    (AssetRepository.removeAssetAndDerivedData as jest.Mock).mockResolvedValue(undefined);
  });

  it('warns about unrecoverable deletion and cloud sync before confirming a blurry photo', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<ScanResultsScreen />);
    const button = await screen.findByRole('button', { name: 'scan_delete_blurry_title' });
    fireEvent.press(button);
    expect(alert.mock.calls[0][1]).toContain('media_delete_warning');
    expect(alert.mock.calls[0][2]![0]).toMatchObject({ text: 'cancel', style: 'cancel' });
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
  });

  it('allows only one native deletion while a confirmed request is pending, then unlocks on failure', async () => {
    const nativeDelete = deferred<boolean>();
    (MediaLibrary.deleteAssetsAsync as jest.Mock).mockReturnValueOnce(nativeDelete.promise);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<ScanResultsScreen />);
    await screen.findByText('scan_blur_score');
    const deleteButton = screen.getByRole('button', { name: 'scan_delete_blurry_title' });
    fireEvent.press(deleteButton);
    const confirm = alert.mock.calls[0][2]![1].onPress!;
    let first!: Promise<void>;
    try {
      await act(async () => {
        first = confirm() as unknown as Promise<void>;
        await Promise.resolve();
      });
      await act(async () => { await confirm(); });
      expect(MediaLibrary.deleteAssetsAsync).toHaveBeenCalledTimes(1);
      expect(deleteButton.props.accessibilityState.disabled).toBe(true);
      expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
    } finally {
      await act(async () => { nativeDelete.resolve(false); await first; });
    }
    expect(screen.getByText('scan_blur_score')).toBeTruthy();
    expect(deleteButton.props.accessibilityState.disabled).toBe(false);
    expect(AssetRepository.removeAssetAndDerivedData).not.toHaveBeenCalled();
    expect(alert).toHaveBeenLastCalledWith('delete_failed', expect.any(String));
    fireEvent.press(deleteButton);
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    await act(async () => { await alert.mock.calls.at(-1)![2]![1].onPress!(); });
    expect(MediaLibrary.deleteAssetsAsync).toHaveBeenCalledTimes(2);
    expect(mockMediaState.removeDeletedAssets).toHaveBeenCalledWith(['blurred']);
    await screen.findByText('scan_no_blurry');
  });

  it('locks during preflight and fails closed when the selected photo is no longer visible', async () => {
    const visibility = deferred<Set<string>>();
    (getCurrentlyVisibleAssetIds as jest.Mock).mockReturnValueOnce(visibility.promise);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<ScanResultsScreen />);
    const deleteButton = await screen.findByRole('button', { name: 'scan_delete_blurry_title' });
    fireEvent.press(deleteButton);
    const confirm = alert.mock.calls[0][2]![1].onPress!;
    let request!: Promise<void>;
    try {
      await act(async () => { request = confirm() as unknown as Promise<void>; });
      await act(async () => { await confirm(); });
      expect(getCurrentlyVisibleAssetIds).toHaveBeenCalledTimes(1);
      expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
      fireEvent.press(deleteButton);
      expect(alert).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { visibility.resolve(new Set()); await request; });
    }
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
    expect(AssetRepository.removeAssetAndDerivedData).not.toHaveBeenCalled();
    expect(screen.getByText('scan_blur_score')).toBeTruthy();
    expect(deleteButton.props.accessibilityState.disabled).toBe(false);
  });

  it('does not preflight or delete when the application confirmation is cancelled', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<ScanResultsScreen />);
    const deleteButton = await screen.findByRole('button', { name: 'scan_delete_blurry_title' });
    fireEvent.press(deleteButton);
    expect(alert.mock.calls[0][2]![0]).toMatchObject({ text: 'cancel', style: 'cancel' });
    expect(getCurrentlyVisibleAssetIds).not.toHaveBeenCalled();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(deleteButton.props.accessibilityState.disabled).toBe(false);
  });

  it('keeps a successful native deletion successful even if best-effort index cleanup fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (AssetRepository.removeAssetAndDerivedData as jest.Mock).mockRejectedValueOnce(new Error('SQLite busy'));
    render(<ScanResultsScreen />);
    fireEvent.press(await screen.findByRole('button', { name: 'scan_delete_blurry_title' }));
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    await act(async () => { await alert.mock.calls[0][2]![1].onPress!(); });
    await screen.findByText('scan_no_blurry');
    expect(mockMediaState.removeDeletedAssets).toHaveBeenCalledWith(['blurred']);
    expect(MediaLibrary.deleteAssetsAsync).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'scan_delete_blurry_title' })).toBeNull();
  });

  it('does not republish a delayed full-access result after the visible media selection changes', async () => {
    const staleRead = deferred<{ asset_id: string; blur_score: number; mean_luma: number }[]>();
    (AssetRepository.getBlurryAssets as jest.Mock).mockReturnValueOnce(staleRead.promise).mockResolvedValue([]);
    const view = render(<ScanResultsScreen />);
    await waitFor(() => expect(AssetRepository.getBlurryAssets).toHaveBeenCalledTimes(1));
    mockMediaState.mediaLibraryRefreshVersion += 1;
    view.rerender(<ScanResultsScreen />);
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
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ uri: `file:///${id}.jpg` }));
  });

  it('provides a named and reachable category close control without changing media', async () => {
    render(<ScanResultsScreen />);
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
      image.props.source.uri === 'file:///category-photo.jpg' && image.props.style?.resizeMode === 'contain'
    ))).toBe(true));
    fireEvent.press(screen.getByRole('button', { name: 'close' }));
    expect(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.transparent)?.props.visible).toBe(false);
    expect(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.presentationStyle === 'pageSheet')?.props.visible).toBe(true);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(mockMediaState.removeDeletedAssets).not.toHaveBeenCalled();
  });

  it('gives each category photo a named open action rather than an unnamed image target', async () => {
    const view = render(<ScanResultsScreen />);
    await screen.findByText('scan_no_blurry');
    await act(async () => { fireEvent.press(screen.getByText('scan_tab_ai')); });
    await act(async () => { fireEvent.press(screen.getByText('Cat')); });
    const photo = screen.getByRole('button', { name: 'scan_open_category_photo' });
    await act(async () => { fireEvent.press(photo); });
    expect(screen.getByRole('button', { name: 'close' })).toBeTruthy();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps long category headings flexible while reserving a non-shrinking close target', async () => {
    const originalTitle = mockCategory.title;
    mockCategory.title = 'A category with a long translated title';
    try {
      render(<ScanResultsScreen />);
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
    expect(screen.UNSAFE_getAllByType(Image).some(image => image.props.style?.resizeMode === 'contain')).toBe(true);
    expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
  });

  it('reports a missing URI and a native image decoding failure rather than spinning forever', async () => {
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValue({});
    await openPhoto();
    await screen.findByText('scan_photo_unavailable');
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValue({ uri: 'file:///category-photo.jpg' });
    fireEvent.press(screen.getByRole('button', { name: 'retry' }));
    const image = await waitFor(() => {
      const viewerImage = screen.UNSAFE_getAllByType(Image).find(item => item.props.style?.resizeMode === 'contain');
      expect(viewerImage).toBeDefined();
      return viewerImage!;
    });
    fireEvent(image, 'error', { nativeEvent: { error: 'Decoder failed' } });
    expect(screen.getByText('scan_photo_unavailable')).toBeTruthy();
  });

  it('opens a readable photo and lets system back return to its category without changing data', async () => {
    await openPhoto();
    await waitFor(() => expect(screen.UNSAFE_getAllByType(Image).some(image => (
      image.props.style?.resizeMode === 'contain' && image.props.source.uri === 'file:///category-photo.jpg'
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
    mockMediaState.mediaLibraryRefreshVersion += 1;
    view.rerender(<ScanResultsScreen />);
    await act(async () => { lookup.resolve({ uri: 'file:///stale.jpg' }); await lookup.promise; });
    expect(screen.UNSAFE_getAllByType(Modal).every(modal => !modal.props.visible)).toBe(true);
    expect(screen.UNSAFE_getAllByType(Image).some(image => image.props.source.uri === 'file:///stale.jpg')).toBe(false);
  });
});
