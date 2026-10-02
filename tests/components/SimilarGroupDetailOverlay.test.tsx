import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Alert, FlatList, Modal, StyleSheet } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

let mockBottomInset = 24;
const mockRemoveDeletedAssets = jest.fn();
jest.mock('expo-media-library', () => ({ getAssetInfoAsync: jest.fn(), deleteAssetsAsync: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 60, bottom: mockBottomInset, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key, language: 'en' }) }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({
  colors: require('../../constants/theme').COLORS_DARK, isDark: true,
}) }));
jest.mock('../../database', () => ({ AssetRepository: { removeAssetAndDerivedData: jest.fn() } }));
jest.mock('../../stores/useMediaStore', () => ({
  useMediaStore: { getState: () => ({ removeDeletedAssets: mockRemoveDeletedAssets }) },
  getCurrentlyVisibleAssetIds: jest.fn(async (ids: string[]) => new Set(ids)),
}));
// Complete animations, but keep the shared-value identity stable like native
// Reanimated. These tests do not claim to simulate Yoga or system scrolling.
jest.mock('react-native-reanimated', () => ({
  __esModule: true, default: { View: require('react-native').View },
  useSharedValue: (value: number) => require('react').useRef({ value }).current,
  useAnimatedStyle: (callback: () => unknown) => callback(),
  withTiming: (value: number, _config: unknown, callback?: (finished: boolean) => void) => {
    callback?.(true); return value;
  },
  runOnJS: (callback: unknown) => callback,
  Easing: { bezier: () => (value: number) => value },
}));

import { SimilarGroupDetailOverlay } from '../../components/SimilarGroupDetailOverlay';
import { AssetRepository } from '../../database';
import * as MediaDeletion from '../../services/mediaDeletion';

const props = {
  visible: true, groupId: 'group', memberAssetIds: ['first', 'second'],
  originRect: null, onClose: jest.fn(), onComplete: jest.fn(),
};

beforeEach(() => {
  mockBottomInset = 24;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ id, uri: `file:///${id}.jpg` }));
  (MediaLibrary.deleteAssetsAsync as jest.Mock).mockResolvedValue(false);
});

it.each(['rejected', 'no-uri'])('explains %s group members and retries without completing or deleting the group', async failure => {
  if (failure === 'rejected') (MediaLibrary.getAssetInfoAsync as jest.Mock).mockRejectedValue(new Error('Provider unavailable'));
  else (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValue({});
  render(<SimilarGroupDetailOverlay {...props} />);
  await screen.findByText('photos_load_failed');
  expect(screen.queryByRole('button', { name: 'similar_delete_selected' })).toBeNull();
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ uri: `file:///${id}.jpg` }));
  fireEvent.press(screen.getByRole('button', { name: 'retry' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(2));
  expect(screen.queryByText('photos_load_failed')).toBeNull();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(mockRemoveDeletedAssets).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('offers a preview retry when decoding fails without changing selection or deleting', async () => {
  render(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(2));
  fireEvent.press(screen.getAllByRole('button', { name: 'similar_photo' })[0]);
  const preview = screen.getByTestId('similar-preview');
  fireEvent(within(preview).getByRole('image'), 'error', { nativeEvent: { error: 'Decoder unavailable' } });
  expect(within(preview).getByText('scan_photo_unavailable')).toBeTruthy();
  fireEvent.press(within(preview).getByRole('button', { name: 'retry' }));
  await waitFor(() => expect(within(screen.getByTestId('similar-preview')).getByRole('image')).toBeTruthy());
  expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'similar_delete_selected' })).toBeNull();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('keeps available members and explains partial failure without treating the group as completed', async () => {
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockRejectedValueOnce(new Error('Member unavailable'));
  render(<SimilarGroupDetailOverlay {...props} />);
  await screen.findByText('similar_unavailable_count');
  expect(screen.UNSAFE_getByType(FlatList).props.data.map((photo: { assetId: string }) => photo.assetId)).toEqual(['second']);
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('ignores a late decoder error from before a same-URI preview retry', async () => {
  render(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(2));
  fireEvent.press(screen.getAllByRole('button', { name: 'similar_photo' })[0]);
  const image = within(screen.getByTestId('similar-preview')).getByRole('image');
  const oldError = image.props.onError;
  fireEvent(image, 'error');
  fireEvent.press(screen.getByRole('button', { name: 'retry' }));
  await waitFor(() => expect(within(screen.getByTestId('similar-preview')).getByRole('image')).toBeTruthy());
  act(() => oldError());
  expect(within(screen.getByTestId('similar-preview')).queryByText('scan_photo_unavailable')).toBeNull();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('cannot publish a failed old lookup or preview retry after its group has been closed', async () => {
  let rejectOld!: (error: Error) => void;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockReturnValueOnce(new Promise((_, reject) => { rejectOld = reject; }));
  const view = render(<SimilarGroupDetailOverlay {...props} />);
  view.rerender(<SimilarGroupDetailOverlay {...props} visible={false} />);
  const newMembers = ['new-photo'];
  view.rerender(<SimilarGroupDetailOverlay {...props} groupId="new-group" memberAssetIds={newMembers} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(1));
  await act(async () => { rejectOld(new Error('Old lookup failed')); });
  expect(screen.queryByText('scan_photo_unavailable')).toBeNull();
  expect(screen.queryByText('similar_unavailable_count')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'similar_photo' }));
  fireEvent(within(screen.getByTestId('similar-preview')).getByRole('image'), 'error');
  let resolveRetry!: (info: { uri: string }) => void;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockReturnValueOnce(new Promise(resolve => { resolveRetry = resolve; }));
  fireEvent.press(screen.getByRole('button', { name: 'retry' }));
  fireEvent.press(within(screen.getByTestId('similar-preview')).getByRole('button', { name: 'close' }));
  await act(async () => { resolveRetry({ uri: 'file:///recovered.jpg' }); });
  expect(screen.queryByTestId('similar-preview')).toBeNull();
  expect(screen.UNSAFE_getByType(FlatList).props.data.map((photo: { assetId: string }) => photo.assetId)).toEqual(['new-photo']);
  expect(props.onComplete).not.toHaveBeenCalled();
});

it.each([0, 24])('reserves the dock and safe area outside the grid (bottom inset %s)', async bottom => {
  mockBottomInset = bottom;
  render(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2));
  expect(screen.getByTestId('similar-detail')).toHaveStyle({ paddingBottom: 65 + bottom });
  expect(StyleSheet.flatten(screen.UNSAFE_getByType(FlatList).props.contentContainerStyle).paddingBottom).toBeGreaterThanOrEqual(16);
});

it('names the group close and selected-delete icon controls and provides reachable touch targets', async () => {
  render(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2));
  const close = screen.getByRole('button', { name: 'close' });
  expect(StyleSheet.flatten(close.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
  const firstPhoto = screen.UNSAFE_root.findAll((node: { props: any }) => typeof node.props.onLongPress === 'function')[0];
  fireEvent(firstPhoto!, 'longPress');
  const deleteButton = screen.getByRole('button', { name: 'similar_delete_selected' });
  expect(StyleSheet.flatten(deleteButton.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
  fireEvent.press(close);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('names preview actions and allows closing without deleting or losing the group', async () => {
  render(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2));
  const firstPhoto = screen.UNSAFE_root.findAll((node: { props: any }) => typeof node.props.onLongPress === 'function')[0];
  fireEvent.press(firstPhoto!);
  const close = within(screen.getByTestId('similar-preview')).getByRole('button', { name: 'close' });
  expect(StyleSheet.flatten(close.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
  expect(screen.getByRole('button', { name: 'delete' }).props.accessibilityState).toMatchObject({ disabled: false, busy: false });
  expect(within(screen.getByTestId('similar-preview')).getByText('media_delete_warning')).toBeTruthy();
  fireEvent.press(close);
  expect(screen.UNSAFE_queryByType(Modal)).toBeNull();
  expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2);
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('discards a delayed old group lookup after closing and opening a different group', async () => {
  let resolveOld!: (info: { uri: string }) => void;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const view = render(<SimilarGroupDetailOverlay {...props} />);
  view.rerender(<SimilarGroupDetailOverlay {...props} visible={false} />);
  view.rerender(<SimilarGroupDetailOverlay {...props} groupId="new-group" memberAssetIds={['new-photo']} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toEqual([
    { assetId: 'new-photo', uri: 'file:///new-photo.jpg' },
  ]));
  await act(async () => { resolveOld({ uri: 'file:///old.jpg' }); });
  expect(screen.UNSAFE_getByType(FlatList).props.data.map((photo: { assetId: string }) => photo.assetId)).toEqual(['new-photo']);
});

it('retains selection and records on a cancelled native deletion and ignores repeated pending confirmation', async () => {
  let resolveDelete!: (deleted: boolean) => void;
  const pendingDelete = new Promise<boolean>(resolve => { resolveDelete = resolve; });
  (MediaLibrary.deleteAssetsAsync as jest.Mock).mockReturnValueOnce(pendingDelete);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  render(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2));
  const firstPhoto = screen.UNSAFE_root.findAll((node: { props: any }) => typeof node.props.onLongPress === 'function')[0];
  fireEvent(firstPhoto!, 'longPress');
  const deleteButton = screen.getByRole('button', { name: 'similar_delete_selected' });
  fireEvent.press(deleteButton!);
  const confirm = alert.mock.calls[0][2]![1].onPress!;
  let request!: Promise<void>;
  try {
    await act(async () => { request = confirm() as unknown as Promise<void>; });
    await act(async () => { await confirm(); });
    expect(MediaLibrary.deleteAssetsAsync).toHaveBeenCalledTimes(1);
    expect(deleteButton).toBeDisabled();
    expect(mockRemoveDeletedAssets).not.toHaveBeenCalled();
  } finally {
    await act(async () => { resolveDelete(false); await request; });
  }
  expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2);
  expect(AssetRepository.removeAssetAndDerivedData).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
  expect(deleteButton).toBeEnabled();
});

it('reconciles completed batches but keeps the remaining selection and group open on a later failure', async () => {
  // Exercise the consumer's partial-success contract without rendering/selecting
  // thousands of images. The actual native-limit splitting is tested separately.
  jest.spyOn(MediaDeletion, 'deleteAssetsInBatches').mockImplementationOnce(async (assets, onDeleted) => {
    await onDeleted(assets.slice(0, 1));
    throw new Error('A later system confirmation was cancelled');
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  render(<SimilarGroupDetailOverlay {...props} memberAssetIds={['first', 'second', 'third']} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(3));
  const [first, second] = screen.getAllByRole('button', { name: 'similar_photo' });
  fireEvent(first, 'longPress');
  fireEvent.press(second);
  fireEvent.press(screen.getByRole('button', { name: 'similar_delete_selected' }));
  const confirm = alert.mock.calls[0][2]![1].onPress!;
  await act(async () => { await confirm(); });
  expect(mockRemoveDeletedAssets).toHaveBeenCalledWith(['first']);
  expect(AssetRepository.removeAssetAndDerivedData).toHaveBeenCalledWith('first');
  expect(AssetRepository.removeAssetAndDerivedData).not.toHaveBeenCalledWith('second');
  expect(screen.UNSAFE_getByType(FlatList).props.data.map((p: { assetId: string }) => p.assetId)).toEqual(['second', 'third']);
  const remaining = screen.getAllByRole('button', { name: 'similar_photo' });
  expect(remaining[0]).toBeSelected();
  expect(remaining[1]).not.toBeSelected();
  expect(props.onComplete).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'similar_delete_selected' })).toBeEnabled();
});

it('explains selection and exposes photo selection state without changing media or processing the group', async () => {
  render(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(2));
  expect(screen.getByText('similar_select_hint')).toBeTruthy();
  const [first, second] = screen.getAllByRole('button', { name: 'similar_photo' });
  fireEvent(first, 'longPress');
  expect(first).toBeSelected();
  expect(second).not.toBeSelected();
  expect(screen.getByText('similar_selected_count')).toBeTruthy();
  expect(screen.getByText('similar_toggle_hint')).toBeTruthy();
  fireEvent.press(second);
  expect(second).toBeSelected();
  expect(screen.UNSAFE_queryByType(Modal)).toBeNull();
  fireEvent.press(first);
  expect(first).not.toBeSelected();
  fireEvent.press(second);
  expect(second).not.toBeSelected();
  expect(screen.queryByRole('button', { name: 'similar_delete_selected' })).toBeNull();
  fireEvent.press(first);
  fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose');
  expect(screen.UNSAFE_queryByType(Modal)).toBeNull();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(mockRemoveDeletedAssets).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('keeps the selection when the application confirmation is cancelled', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  render(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(2));
  const first = screen.getAllByRole('button', { name: 'similar_photo' })[0];
  fireEvent(first, 'longPress');
  fireEvent.press(screen.getByRole('button', { name: 'similar_delete_selected' }));
  expect(alert.mock.calls[0][2]![0]).toMatchObject({ text: 'cancel', style: 'cancel' });
  expect(alert.mock.calls[0][1]).toContain('media_delete_warning');
  expect(first).toBeSelected();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(mockRemoveDeletedAssets).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});
