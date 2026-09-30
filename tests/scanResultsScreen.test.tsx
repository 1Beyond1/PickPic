import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActivityIndicator, Alert, Image, Modal, StyleSheet } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

const mockMediaState = {
  permissionScope: 'full', mediaLibraryRefreshVersion: 0,
  removeDeletedAssets: jest.fn(),
};
const mockRefreshAI = jest.fn().mockResolvedValue(undefined);
const mockCategory = {
  id: 'objects', title: 'Cat', count: 1,
  coverAsset: { asset_id: 'category-photo' },
  assets: [{ asset_id: 'category-photo' }],
};
const mockCategories = {
  peopleGroups: [], objectGroups: [mockCategory], uncategorizedGroup: null,
  isLoading: false, refresh: mockRefreshAI,
};

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' }),
  getAssetInfoAsync: jest.fn(), getAssetsAsync: jest.fn(), deleteAssetsAsync: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 60, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../components/GlassContainer', () => ({ GlassContainer: ({ children }: any) => children }));
jest.mock('../components/SimilarGroupCard', () => ({ SimilarGroupCard: () => null }));
jest.mock('../components/SimilarGroupDetailOverlay', () => ({ SimilarGroupDetailOverlay: () => null }));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => ({ colors: {
    background: '#111', text: '#fff', textSecondary: '#aaa', primary: '#fff',
    danger: '#f00', dangerBackground: '#500', dangerForeground: '#fff',
  } }),
}));
jest.mock('../hooks/useAICategories', () => ({ useAICategories: () => mockCategories }));
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: () => ({ enableAIClassification: true }) }));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: Object.assign((selector: any) => selector(mockMediaState), { getState: () => mockMediaState }),
  getCurrentlyVisibleAssetIds: jest.fn().mockImplementation(async (ids: string[]) => new Set(ids)),
}));
jest.mock('../database', () => ({
  AssetRepository: { getBlurryAssets: jest.fn(), removeAssetAndDerivedData: jest.fn() },
  DupGroupRepository: { getAllGroups: jest.fn().mockResolvedValue([]) },
}));

import ScanResultsScreen from '../app/(tabs)/scanResults';
import { AssetRepository } from '../database';
import { getCurrentlyVisibleAssetIds } from '../stores/useMediaStore';

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
});

describe('category photo viewing', () => {
  beforeEach(() => {
    mockMediaState.mediaLibraryRefreshVersion = 0;
    (AssetRepository.getBlurryAssets as jest.Mock).mockResolvedValue([]);
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ uri: `file:///${id}.jpg` }));
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
    expect(controlStyle.backgroundColor).toBe('rgba(0,0,0,0.65)');
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
