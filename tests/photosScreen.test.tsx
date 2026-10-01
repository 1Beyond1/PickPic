import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Image, Modal, ScrollView, StyleSheet } from 'react-native';

let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
const mockCardSizes = new Map<string, { maxWidth: number; maxHeight: number }>();

const mockLoadPhotos = jest.fn().mockResolvedValue(undefined);
const mockLoadAlbums = jest.fn().mockResolvedValue(undefined);
const mockPhoto = (id: string) => ({ id, uri: `file:///${id}.jpg`, filename: `${id}.jpg`, creationTime: 1 });
const mockMediaState = {
  photos: [mockPhoto('one'), mockPhoto('two'), mockPhoto('three')],
  albums: [],
  loadPhotos: mockLoadPhotos,
  loadAlbums: mockLoadAlbums,
  isLoading: false,
  hasHydrated: true,
  photoProcessedIds: [] as string[],
  markForDeletion: jest.fn(),
  markAsSkipped: jest.fn(),
  undoAction: jest.fn(),
  confirmDeletion: jest.fn(),
  deleteQueue: [] as ReturnType<typeof mockPhoto>[],
  resetBatch: jest.fn(),
  isConfirmingDeletion: false,
  createAlbum: jest.fn(),
  addAssetToAlbum: jest.fn(),
  permissionScope: 'full',
  hiddenPhotoQueuedAssetIds: null as string[] | null,
  mediaLibraryRefreshVersion: 0,
  setPermissionScope: jest.fn(),
  refreshQueuedAssetVisibility: jest.fn(),
  pruneUnavailableQueuedAssets: jest.fn(),
  notifyPermissionRefresh: jest.fn(),
};
const mockSettingsState = {
  groupSize: 10,
  displayOrder: 'random',
  selectedAlbumIds: [],
  setSelectedAlbums: jest.fn(),
  hasHydrated: true,
};

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn(),
  presentPermissionsPickerAsync: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (effect: () => void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(effect, [effect]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, Feather: () => null }));
jest.mock('../components/AlbumSelector', () => ({ AlbumSelector: () => null }));
jest.mock('../components/GlassContainer', () => ({ GlassContainer: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../components/PhotoCard', () => ({
  PhotoCard: ({ photo, maxWidth, maxHeight }: { photo: { id: string }; maxWidth: number; maxHeight: number }) => {
    mockCardSizes.set(photo.id, { maxWidth, maxHeight });
    const ReactModule = require('react');
    const { Text } = require('react-native');
    return ReactModule.createElement(Text, null, `card:${photo.id}`);
  },
}));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => ({
    isDark: true,
    colors: {
      background: '#111212', text: '#F1F2EF', textSecondary: '#B1B8B0',
      surface: '#1D1E1E', surfaceHover: '#232524', divider: '#2B2D2B',
      actionBackground: '#EFF2ED', actionForeground: '#181B18',
      danger: '#EAB0A4', dangerBackground: '#A7483F', dangerForeground: '#FFFFFF',
    },
  }),
}));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: Object.assign(() => mockMediaState, { getState: () => mockMediaState }),
}));
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: () => mockSettingsState }));

import PhotosScreen from '../app/(tabs)/photos';
import * as MediaLibrary from 'expo-media-library';

describe('PhotosScreen visual entry', () => {
  afterEach(() => jest.useRealTimers());

  beforeEach(() => {
    mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    mockMediaState.photos = [mockPhoto('one'), mockPhoto('two'), mockPhoto('three')];
    mockMediaState.photoProcessedIds = [];
    mockMediaState.deleteQueue = [];
    mockMediaState.permissionScope = 'full';
    mockMediaState.isConfirmingDeletion = false;
    mockMediaState.hiddenPhotoQueuedAssetIds = null;
    mockMediaState.mediaLibraryRefreshVersion = 0;
    jest.clearAllMocks();
    mockCardSizes.clear();
  });

  it('shows the real current batch count, then opens the existing photo deck', () => {
    mockMediaState.photos = [mockPhoto('one'), mockPhoto('two')];
    render(<PhotosScreen />);
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.press(screen.getByText('photos_home_start'));
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 390, height: 500 } } });
    expect(screen.getByText('card:one')).toBeTruthy();
  });

  it('does not duplicate the dock settings entry in the home header', () => {
    render(<PhotosScreen />);
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(screen.queryByLabelText('tab_settings')).toBeNull();
    expect(screen.getByRole('button', { name: 'photos_home_album' })).toBeTruthy();
    expect(screen.queryByText('photos_manage_access')).toBeNull();
  });

  it('keeps the system top inset outside the scrollable home without changing the batch or filter', () => {
    mockInsets = { top: 32, bottom: 24, left: 0, right: 0 };
    const view = render(<PhotosScreen />);
    expect(screen.getByTestId('photos-home')).toHaveStyle({ paddingTop: 32 });
    const scrollContent = StyleSheet.flatten(view.UNSAFE_getByType(ScrollView).props.contentContainerStyle);
    expect(scrollContent.paddingTop).toBe(16);
    expect(scrollContent.paddingBottom).toBe(24 + 65 + 24);
    expect(screen.getByText('3')).toBeTruthy();
    expect(mockSettingsState.setSelectedAlbums).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
  });

  it('reserves the Dock and safe areas before measuring space for media', () => {
    mockInsets = { top: 32, bottom: 24, left: 4, right: 8 };
    render(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    expect(screen.getByTestId('photos-deck')).toHaveStyle({ paddingTop: 32, paddingBottom: 89, paddingLeft: 4, paddingRight: 8 });
    expect(screen.queryByText('card:one')).toBeNull();
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 308, height: 400 } } });
    expect(mockCardSizes.get('one')).toEqual({ maxWidth: 268, maxHeight: 384 });
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
  });

  it('updates all card bounds when the viewport changes without changing batch or filters', () => {
    render(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 320, height: 360 } } });
    expect(mockCardSizes.get('one')).toEqual({ maxWidth: 280, maxHeight: 344 });
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 280, height: 240 } } });
    expect(mockCardSizes.get('one')).toEqual({ maxWidth: 240, maxHeight: 224 });
    expect(mockCardSizes.get('two')).toEqual({ maxWidth: 240, maxHeight: 224 });
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
    expect(mockSettingsState.setSelectedAlbums).not.toHaveBeenCalled();
  });

  it('keeps readable, wrapping gesture directions distinct from the later deletion review', () => {
    render(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    const hint = screen.getByText('hint_swipe_up');
    expect(hint.props.numberOfLines).toBeUndefined();
    let ancestor: typeof hint | null = hint;
    while (ancestor) {
      expect(StyleSheet.flatten(ancestor.props.style)?.opacity).toBeUndefined();
      ancestor = ancestor.parent;
    }
    expect(screen.getByText('photos_queue_review_hint')).toBeTruthy();
    expect(mockMediaState.confirmDeletion).not.toHaveBeenCalled();
  });

  it('lets a limited-access user change the selection from a nonempty home without organizing photos first', async () => {
    mockMediaState.permissionScope = 'limited';
    (MediaLibrary.presentPermissionsPickerAsync as jest.Mock).mockResolvedValue(undefined);
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    render(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'photos_manage_access' }));
    await waitFor(() => expect(mockMediaState.notifyPermissionRefresh).toHaveBeenCalledTimes(1));
    expect(MediaLibrary.presentPermissionsPickerAsync).toHaveBeenCalledWith(['photo']);
    expect(mockMediaState.refreshQueuedAssetVisibility).toHaveBeenCalledWith('limited', 'photo');
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.resetBatch).not.toHaveBeenCalled();
    expect(screen.getByText('photos_home_start')).toBeTruthy();
  });

  it('disables the limited-access entry while its picker is pending without starting another request', async () => {
    mockMediaState.permissionScope = 'limited';
    let finishPicker!: () => void;
    (MediaLibrary.presentPermissionsPickerAsync as jest.Mock).mockReturnValueOnce(new Promise<void>(resolve => { finishPicker = resolve; }));
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    render(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'photos_manage_access' }));
    const busyEntry = screen.getByRole('button', { name: 'permission_requesting' });
    expect(busyEntry.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    fireEvent.press(busyEntry);
    expect(MediaLibrary.presentPermissionsPickerAsync).toHaveBeenCalledTimes(1);
    await act(async () => { finishPicker(); });
    expect(screen.getByRole('button', { name: 'photos_manage_access' }).props.accessibilityState.disabled).toBe(false);
    expect(mockMediaState.resetBatch).not.toHaveBeenCalled();
  });

  it('recovers the limited-access entry after a picker failure without changing organizing decisions', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockMediaState.permissionScope = 'limited';
    (MediaLibrary.presentPermissionsPickerAsync as jest.Mock).mockRejectedValueOnce(new Error('Picker unavailable'));
    render(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'photos_manage_access' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'photos_manage_access' }).props.accessibilityState.disabled).toBe(false));
    expect(mockMediaState.notifyPermissionRefresh).not.toHaveBeenCalled();
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.resetBatch).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 30])('previews at most three real photos from a %s-photo batch without reordering it', count => {
    mockMediaState.photos = Array.from({ length: count }, (_, index) => mockPhoto(`photo-${index}`));
    const originalIds = mockMediaState.photos.map(photo => photo.id);
    render(<PhotosScreen />);
    expect(screen.getByText(String(count))).toBeTruthy();
    expect(screen.UNSAFE_getAllByType(Image).map(image => image.props.source.uri))
      .toEqual(mockMediaState.photos.slice(0, 3).map(photo => photo.uri));
    expect(mockMediaState.photos.map(photo => photo.id)).toEqual(originalIds);
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
  });

  it('keeps the deck open as an in-memory batch is processed', () => {
    const view = render(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 390, height: 500 } } });
    mockMediaState.photoProcessedIds = ['one'];
    view.rerender(<PhotosScreen />);
    expect(screen.queryByText('photos_home_start')).toBeNull();
    expect(screen.getByText('card:two')).toBeTruthy();
  });

  it('keeps the deletion review reachable when the batch is finished', () => {
    mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    render(<PhotosScreen />);
    expect(screen.getByText('photos_confirm')).toBeTruthy();
  });

  it('returns to an empty home after the final batch without reopening processed photos', () => {
    const view = render(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    mockMediaState.photos = [];
    mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    view.rerender(<PhotosScreen />);

    fireEvent.press(screen.getByText('photos_back_home'));
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(screen.getByText('photos_home_album')).toBeTruthy();
    expect(screen.queryByText('photos_home_start')).toBeNull();
    expect(mockMediaState.photoProcessedIds).toEqual(['one', 'two', 'three']);
    expect(screen.queryByText('card:one')).toBeNull();
  });

  it('opens an empty home safely when there are no photos at launch', () => {
    mockMediaState.photos = [];
    render(<PhotosScreen />);
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(screen.getByText('photos_empty')).toBeTruthy();
    expect(screen.getByText('photos_reload')).toBeTruthy();
  });

  it('keeps a restored delete queue in review even when no photos remain', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    render(<PhotosScreen />);
    expect(screen.getByText('photos_confirm')).toBeTruthy();
    expect(screen.queryByText('PickPic')).toBeNull();
  });

  it('keeps permission management available from the empty home', () => {
    mockMediaState.photos = [];
    mockMediaState.permissionScope = 'limited';
    render(<PhotosScreen />);
    expect(screen.getByText('photos_manage_access')).toBeTruthy();
    expect(screen.getByText('photos_limited_access_desc')).toBeTruthy();
  });

  it('lets users preview and undo a queued photo beyond the first nine without undoing earlier items', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = Array.from({ length: 10 }, (_, i) => mockPhoto(`queued-${i}`));
    render(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'photos_review_next' }));
    fireEvent.press(screen.getByRole('button', { name: 'photos_review_previous' }));
    expect(screen.UNSAFE_getAllByType(Image).map(image => image.props.source.uri))
      .toEqual(mockMediaState.deleteQueue.slice(0, 9).map(photo => photo.uri));
    fireEvent.press(screen.getByRole('button', { name: 'photos_review_next' }));
    const tenth = screen.UNSAFE_getAllByType(Image).find(image => image.props.source.uri === 'file:///queued-9.jpg')!;
    expect(tenth).toBeTruthy();
    fireEvent(tenth, 'longPress');
    expect(screen.UNSAFE_getAllByType(Image).some(image => (
      image.props.source.uri === 'file:///queued-9.jpg' && image.props.resizeMode === 'contain'
    ))).toBe(true);
    expect(mockMediaState.undoAction).not.toHaveBeenCalled();
    fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose');
    fireEvent.press(tenth);
    expect(mockMediaState.undoAction).toHaveBeenCalledTimes(1);
    expect(mockMediaState.undoAction).toHaveBeenCalledWith('queued-9');
  });

  it('confirms the complete visible queue rather than just the selected review page', async () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = Array.from({ length: 10 }, (_, i) => mockPhoto(`queued-${i}`));
    mockMediaState.confirmDeletion.mockResolvedValue([]);
    render(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'photos_review_next' }));
    fireEvent.press(screen.getByText('photos_confirm'));
    await waitFor(() => expect(mockMediaState.confirmDeletion).toHaveBeenCalledWith(
      mockMediaState.deleteQueue.map(photo => photo.id)
    ));
  });

  it('closes a preview by tapping its media without undoing or confirming a decision', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    render(<PhotosScreen />);
    const thumbnail = screen.UNSAFE_getAllByType(Image)[0];
    fireEvent(thumbnail, 'longPress');
    const preview = screen.UNSAFE_getAllByType(Image).find(image => image.props.resizeMode === 'contain')!;
    fireEvent.press(preview);
    expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(1);
    expect(mockMediaState.undoAction).not.toHaveBeenCalled();
    expect(mockMediaState.confirmDeletion).not.toHaveBeenCalled();
  });

  it('names thumbnail undo actions and disables all review actions while deletion is pending', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    mockMediaState.isConfirmingDeletion = true;
    render(<PhotosScreen />);
    expect(screen.getByRole('button', { name: 'photos_review_undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'photos_confirm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'photos_skip' })).toBeDisabled();
  });

  it('provides a visible named close action for the long-press preview without changing the queue', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    render(<PhotosScreen />);
    fireEvent(screen.UNSAFE_getAllByType(Image)[0], 'longPress');
    fireEvent.press(screen.getByRole('button', { name: 'close' }));
    expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(1);
    expect(mockMediaState.undoAction).not.toHaveBeenCalled();
    expect(mockMediaState.confirmDeletion).not.toHaveBeenCalled();
  });

  it('fits nine thumbnails in the inset-aware width and keeps final actions outside the scrolling grid', () => {
    jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 320, height: 719, scale: 1, fontScale: 1.4 });
    mockInsets = { top: 32, bottom: 24, left: 4, right: 8 };
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = Array.from({ length: 9 }, (_, i) => mockPhoto(`queued-${i}`));
    render(<PhotosScreen />);
    expect(screen.getByTestId('photo-review')).toHaveStyle({ paddingTop: 32, paddingBottom: 89, paddingLeft: 4, paddingRight: 8 });
    for (const image of screen.UNSAFE_getAllByType(Image)) {
      expect(StyleSheet.flatten(image.props.style)).toMatchObject({ width: 84, height: 84 });
    }
    const scroll = screen.UNSAFE_getByType(ScrollView);
    expect(scroll.findAll((node: { props: { testID?: string } }) => node.props.testID === 'photo-review-actions')).toHaveLength(0);
    expect(screen.getByTestId('photo-review-actions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'photos_confirm' })).toHaveStyle({ minHeight: 50 });
  });

  it('keeps preview safe areas and closing controls independent of the image', () => {
    mockInsets = { top: 32, bottom: 24, left: 4, right: 8 };
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    render(<PhotosScreen />);
    fireEvent(screen.UNSAFE_getAllByType(Image)[0], 'longPress');
    expect(screen.getByTestId('photo-preview')).toHaveStyle({ paddingTop: 40, paddingBottom: 24, paddingLeft: 4, paddingRight: 8 });
    expect(screen.getByRole('button', { name: 'close' })).toHaveStyle({ width: 44, height: 44, flexShrink: 0 });
    expect(screen.getByTestId('photo-preview-touch-area')).toHaveStyle({ flex: 1, minHeight: 0 });
    expect(screen.UNSAFE_getByType(Modal).props).toMatchObject({ statusBarTranslucent: true, navigationBarTranslucent: true });
  });

  it('dismisses a stale preview on a library refresh without changing pending decisions', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    const view = render(<PhotosScreen />);
    fireEvent(screen.UNSAFE_getAllByType(Image)[0], 'longPress');
    mockMediaState.mediaLibraryRefreshVersion++;
    view.rerender(<PhotosScreen />);
    expect(screen.UNSAFE_getByType(Modal).props.visible).toBe(false);
    expect(mockMediaState.undoAction).not.toHaveBeenCalled();
    expect(mockMediaState.resetBatch).not.toHaveBeenCalled();
  });

  it('shows a wrapping complete state with a reachable continue action and no dangerous confirmation', () => {
    mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    render(<PhotosScreen />);
    expect(screen.getByRole('header', { name: 'photos_finished' }).props.numberOfLines).toBeUndefined();
    expect(screen.getByRole('button', { name: 'continue_next_batch' })).toHaveStyle({ minHeight: 50 });
    expect(screen.queryByText('photos_confirm')).toBeNull();
  });

  it('skips the whole visible queue without deleting media or undoing processed records', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = Array.from({ length: 10 }, (_, i) => mockPhoto(`queued-${i}`));
    render(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'photos_review_next' }));
    mockLoadPhotos.mockClear();
    fireEvent.press(screen.getByText('photos_skip'));
    expect(mockMediaState.resetBatch).toHaveBeenCalledWith(mockMediaState.deleteQueue.map(photo => photo.id));
    expect(mockLoadPhotos).toHaveBeenCalledWith(10, 'random', []);
    expect(mockMediaState.confirmDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.undoAction).not.toHaveBeenCalled();
  });

  it('clears only confirmed deleted IDs rather than losing failed visibility checks', async () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one'), mockPhoto('two')];
    mockMediaState.confirmDeletion.mockResolvedValueOnce(['one']);
    render(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_confirm'));
    await waitFor(() => expect(mockMediaState.resetBatch).toHaveBeenCalledWith(['one']));
    expect(mockMediaState.confirmDeletion).toHaveBeenCalledWith(['one', 'two']);
  });

  it('does not include hidden limited-grant queue entries in review or confirmation', async () => {
    mockMediaState.permissionScope = 'limited';
    mockMediaState.hiddenPhotoQueuedAssetIds = ['two'];
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one'), mockPhoto('two')];
    mockMediaState.confirmDeletion.mockResolvedValueOnce([]);
    render(<PhotosScreen />);
    expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(1);
    fireEvent.press(screen.getByText('photos_confirm'));
    await waitFor(() => expect(mockMediaState.confirmDeletion).toHaveBeenCalledWith(['one']));
  });

  it('continues a no-deletion batch with the original filter without calling native deletion', () => {
    mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    render(<PhotosScreen />);
    fireEvent.press(screen.getByText('continue_next_batch'));
    expect(mockMediaState.resetBatch).toHaveBeenCalledWith([]);
    expect(mockLoadPhotos).toHaveBeenCalledWith(10, 'random', []);
    expect(mockMediaState.confirmDeletion).not.toHaveBeenCalled();
  });

  it.each(['finished batch', 'restored queue'])('shows native deletion failure in %s review without clearing decisions', async source => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    if (source === 'restored queue') mockMediaState.photos = [];
    else mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    mockMediaState.confirmDeletion.mockRejectedValueOnce(new Error('Native deletion failed'));
    render(<PhotosScreen />);
    mockLoadPhotos.mockClear();

    fireEvent.press(screen.getByText('photos_confirm'));

    await waitFor(() => expect(screen.getByText('photos_delete_failed')).toBeTruthy());
    expect(mockMediaState.resetBatch).not.toHaveBeenCalled();
    expect(mockLoadPhotos).not.toHaveBeenCalled();
    expect(mockMediaState.deleteQueue.map(photo => photo.id)).toEqual(['one']);
    expect(screen.getByText('photos_confirm')).toBeTruthy();
    act(() => jest.advanceTimersByTime(1500));
    expect(screen.queryByText('photos_delete_failed')).toBeNull();
    expect(screen.getByText('photos_confirm')).toBeTruthy();
  });

  it('clamps review pagination after the queue shrinks and prevents duplicate undo during deletion', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = Array.from({ length: 10 }, (_, i) => mockPhoto(`queued-${i}`));
    const view = render(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'photos_review_next' }));
    mockMediaState.deleteQueue = mockMediaState.deleteQueue.slice(0, 9);
    mockMediaState.isConfirmingDeletion = true;
    view.rerender(<PhotosScreen />);
    const first = screen.UNSAFE_getAllByType(Image).find(image => image.props.source.uri === 'file:///queued-0.jpg')!;
    expect(first).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'photos_review_next' })).toBeNull();
    fireEvent.press(first);
    expect(mockMediaState.undoAction).not.toHaveBeenCalled();
  });

  it('renders a bounded review page for a large restored queue', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = Array.from({ length: 1000 }, (_, i) => mockPhoto(`queued-${i}`));
    render(<PhotosScreen />);
    expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(9);
    fireEvent.press(screen.getByRole('button', { name: 'photos_review_next' }));
    expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(9);
    expect(mockMediaState.undoAction).not.toHaveBeenCalled();
  });

  it('allows tall deletion-review content to grow past the viewport instead of flex-shrinking its actions offscreen', () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = Array.from({ length: 9 }, (_, i) => mockPhoto(`queued-${i}`));
    render(<PhotosScreen />);
    const style = StyleSheet.flatten(screen.UNSAFE_getByType(ScrollView).props.contentContainerStyle);
    expect(style.flex).not.toBe(1);
    expect(style.flexShrink).toBe(0);
    expect(style.flexGrow).toBe(1);
  });
});
