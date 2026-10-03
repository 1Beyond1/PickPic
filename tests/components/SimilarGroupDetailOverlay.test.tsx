import React from 'react';
import { act, fireEvent, renderAsync, screen, waitFor, within } from '@testing-library/react-native';
import { FlatList, Modal, StyleSheet } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

let mockBottomInset = 24;
const mockRemoveDeletedAssets = jest.fn();
const mockEnqueuePending = jest.fn(() => 1);
const mockMediaState = { deleteQueue: [], videoTrashBin: [], pendingDeletionInfo: {}, enqueuePendingDeletion: mockEnqueuePending, removeDeletedAssets: mockRemoveDeletedAssets };
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
  useMediaStore: Object.assign((selector: any) => selector(mockMediaState), { getState: () => mockMediaState }),
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

const props = {
  visible: true, groupId: 'group', memberAssetIds: ['first', 'second'],
  originRect: null, onClose: jest.fn(), onComplete: jest.fn(),
};

beforeEach(() => {
  mockBottomInset = 24;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` }));
  (MediaLibrary.deleteAssetsAsync as jest.Mock).mockResolvedValue(false);
});

it.each(['rejected', 'no-uri'])('explains %s group members and retries without completing or deleting the group', async failure => {
  if (failure === 'rejected') (MediaLibrary.getAssetInfoAsync as jest.Mock).mockRejectedValue(new Error('Provider unavailable'));
  else (MediaLibrary.getAssetInfoAsync as jest.Mock).mockResolvedValue({});
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await screen.findByText('photos_load_failed');
  expect(mockEnqueuePending).not.toHaveBeenCalled();
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ uri: `file:///${id}.jpg` }));
  fireEvent.press(screen.getByRole('button', { name: 'retry' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(2));
  expect(screen.queryByText('photos_load_failed')).toBeNull();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(mockRemoveDeletedAssets).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('offers a preview retry when decoding fails without changing selection or deleting', async () => {
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(2));
  fireEvent.press(screen.getAllByRole('button', { name: 'similar_photo' })[0]);
  const preview = screen.getByTestId('similar-preview');
  fireEvent(within(preview).getByRole('image'), 'error', { nativeEvent: { error: 'Decoder unavailable' } });
  expect(within(preview).getByText('scan_photo_unavailable')).toBeTruthy();
  fireEvent.press(within(preview).getByRole('button', { name: 'retry' }));
  await waitFor(() => expect(within(screen.getByTestId('similar-preview')).getByRole('image')).toBeTruthy());
  expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2);
  expect(mockEnqueuePending).not.toHaveBeenCalled();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('keeps available members and explains partial failure without treating the group as completed', async () => {
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockRejectedValueOnce(new Error('Member unavailable'));
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await screen.findByText('similar_unavailable_count');
  expect(screen.UNSAFE_getByType(FlatList).props.data.map((photo: { assetId: string }) => photo.assetId)).toEqual(['second']);
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('ignores a late decoder error from before a same-URI preview retry', async () => {
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
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
  const view = await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await view.rerenderAsync(<SimilarGroupDetailOverlay {...props} visible={false} />);
  const newMembers = ['new-photo'];
  await view.rerenderAsync(<SimilarGroupDetailOverlay {...props} groupId="new-group" memberAssetIds={newMembers} />);
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
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2));
  expect(screen.getByTestId('similar-detail')).toHaveStyle({ paddingBottom: 65 + bottom });
  expect(StyleSheet.flatten(screen.UNSAFE_getByType(FlatList).props.contentContainerStyle).paddingBottom).toBeGreaterThanOrEqual(16);
});

it('names the group close and selected-delete icon controls and provides reachable touch targets', async () => {
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2));
  const close = screen.getByRole('button', { name: 'close' });
  expect(StyleSheet.flatten(close.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
  const firstPhoto = screen.UNSAFE_root.findAll((node: { props: any }) => typeof node.props.onLongPress === 'function')[0];
  fireEvent(firstPhoto!, 'longPress');
  const deleteButton = screen.getByRole('button', { name: 'pending_add' });
  expect(StyleSheet.flatten(deleteButton.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
  fireEvent.press(close);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('names preview actions and allows closing without deleting or losing the group', async () => {
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2));
  const firstPhoto = screen.UNSAFE_root.findAll((node: { props: any }) => typeof node.props.onLongPress === 'function')[0];
  fireEvent.press(firstPhoto!);
  const close = within(screen.getByTestId('similar-preview')).getByRole('button', { name: 'close' });
  expect(StyleSheet.flatten(close.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
  expect(screen.getByRole('button', { name: 'pending_add' }).props.accessibilityState).toMatchObject({ disabled: false, busy: false });
  expect(within(screen.getByTestId('similar-preview')).getByText('pending_keep_hint')).toBeTruthy();
  fireEvent.press(close);
  expect(screen.queryByTestId('similar-preview')).toBeNull();
  expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2);
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('discards a delayed old group lookup after closing and opening a different group', async () => {
  let resolveOld!: (info: { uri: string }) => void;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const view = await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await view.rerenderAsync(<SimilarGroupDetailOverlay {...props} visible={false} />);
  await view.rerenderAsync(<SimilarGroupDetailOverlay {...props} groupId="new-group" memberAssetIds={['new-photo']} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toEqual([
    { assetId: 'new-photo', uri: 'file:///new-photo.jpg' },
  ]));
  await act(async () => { resolveOld({ uri: 'file:///old.jpg' }); });
  expect(screen.UNSAFE_getByType(FlatList).props.data.map((photo: { assetId: string }) => photo.assetId)).toEqual(['new-photo']);
});

it('locks during a queue preflight without issuing system deletion, then adds the selected photo once', async () => {
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2));
  let resolve!: (info: unknown) => void;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent(screen.getAllByRole('button', { name: 'similar_photo' })[0], 'longPress');
  fireEvent.press(screen.getByRole('button', { name: 'pending_add' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'pending_add' })).toBeDisabled());
  fireEvent.press(screen.getByRole('button', { name: 'pending_add' }));
  expect(mockEnqueuePending).not.toHaveBeenCalled();
  await act(async () => { resolve({ id: 'first', mediaType: 'photo', uri: 'file:///first.jpg' }); });
  expect(mockEnqueuePending).toHaveBeenCalledTimes(1);
  expect(mockEnqueuePending).toHaveBeenCalledWith([expect.objectContaining({ id: 'first' })], 'similar');
  expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2);
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(mockRemoveDeletedAssets).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('retains the complete selection if one selected item becomes unavailable before queueing', async () => {
  await renderAsync(<SimilarGroupDetailOverlay {...props} memberAssetIds={['first', 'second', 'third']} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(3));
  const [first, second] = screen.getAllByRole('button', { name: 'similar_photo' });
  fireEvent(first, 'longPress');
  fireEvent.press(second);
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => id === 'second' ? null : { id, mediaType: 'photo', uri: `file:///${id}.jpg` });
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'pending_add' })); });
  expect(mockEnqueuePending).not.toHaveBeenCalled();
  expect(screen.getByText('pending_add_failed')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'similar_photo' })[0]).toBeSelected();
  expect(screen.getAllByRole('button', { name: 'similar_photo' })[1]).toBeSelected();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('explains selection and exposes photo selection state without changing media or processing the group', async () => {
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
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
  expect(screen.queryByTestId('similar-preview')).toBeNull();
  fireEvent.press(first);
  expect(first).not.toBeSelected();
  fireEvent.press(second);
  expect(second).not.toBeSelected();
  expect(screen.queryByRole('button', { name: 'pending_add' })).toBeNull();
  fireEvent.press(first);
  fireEvent(screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.visible)!, 'requestClose');
  expect(screen.queryByTestId('similar-preview')).toBeNull();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(mockRemoveDeletedAssets).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('queues only the previewed photo and does not implicitly keep the remaining group member', async () => {
  await renderAsync(<SimilarGroupDetailOverlay {...props} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'similar_photo' })).toHaveLength(2));
  fireEvent.press(screen.getAllByRole('button', { name: 'similar_photo' })[0]);
  await act(async () => { fireEvent.press(within(screen.getByTestId('similar-preview')).getByRole('button', { name: 'pending_add' })); });
  expect(mockEnqueuePending).toHaveBeenCalledWith([expect.objectContaining({ id: 'first' })], 'similar');
  expect(screen.queryByTestId('similar-preview')).toBeNull();
  expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(2);
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});
