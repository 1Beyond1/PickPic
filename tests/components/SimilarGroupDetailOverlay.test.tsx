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

const props = {
  visible: true, groupId: 'group', memberAssetIds: ['first', 'second'],
  originRect: null, onClose: jest.fn(), onComplete: jest.fn(),
};

beforeEach(() => {
  mockBottomInset = 24;
  (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => ({ id, uri: `file:///${id}.jpg` }));
  (MediaLibrary.deleteAssetsAsync as jest.Mock).mockResolvedValue(false);
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
  expect(first).toBeSelected();
  expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
  expect(mockRemoveDeletedAssets).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});
