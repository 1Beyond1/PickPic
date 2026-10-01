import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Image, Modal, ScrollView, StyleSheet } from 'react-native';

let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

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
  hiddenPhotoQueuedAssetIds: null,
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
  PhotoCard: ({ photo }: { photo: { id: string } }) => {
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
    jest.clearAllMocks();
  });

  it('shows the real current batch count, then opens the existing photo deck', () => {
    mockMediaState.photos = [mockPhoto('one'), mockPhoto('two')];
    render(<PhotosScreen />);
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.press(screen.getByText('photos_home_start'));
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
