import React from 'react';
import { act, fireEvent, fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Image, ScrollView, StyleSheet } from 'react-native';

let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
const mockCardSizes = new Map<string, { maxWidth: number; maxHeight: number }>();

const mockLoadPhotos = jest.fn().mockResolvedValue(undefined);
const mockLoadAlbums = jest.fn().mockResolvedValue(undefined);
const mockPhoto = (id: string) => ({ id, uri: `file:///${id}.jpg`, filename: `${id}.jpg`, creationTime: 1, mediaType: 'photo' as const });
const mockMediaState = {
  photos: [mockPhoto('one'), mockPhoto('two'), mockPhoto('three')],
  albums: [],
  loadPhotos: mockLoadPhotos,
  loadAlbums: mockLoadAlbums,
  isLoading: false,
  photoLoadFailed: false,
  hasHydrated: true,
  photoProcessedIds: [] as string[],
  organizingSessions: { photo: null, video: null },
  startOrganizingSession: jest.fn().mockReturnValue({ sessionId: 'synthetic' }),
  resumeOrganizingSession: jest.fn().mockResolvedValue({ status: 'ready' }),
  deferSessionMedia: jest.fn(), revisitSessionDeferred: jest.fn(),
  photoSessionRecoveryStatus: null, photoSessionUnavailableCount: 0,
  markForDeletion: jest.fn(),
  markAsSkipped: jest.fn(),
  undoAction: jest.fn(),
  keepPhotoFromDeleteQueue: jest.fn(),
  confirmDeletion: jest.fn(),
  deleteQueue: [] as ReturnType<typeof mockPhoto>[],
  videoTrashBin: [], pendingDeletionInfo: {}, permissionRefreshVersion: 0,
  isConfirmingVideoTrash: false,
  keepPendingDeletion: jest.fn(), keepAllPendingDeletion: jest.fn((ids: readonly string[]) => ids.length), confirmPendingDeletion: jest.fn(),
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
  getAssetInfoAsync: jest.fn(async (id: string) => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg` })),
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
  afterEach(async () => { await act(async () => {}); jest.useRealTimers(); });

  beforeEach(() => {
    mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    mockMediaState.photos = [mockPhoto('one'), mockPhoto('two'), mockPhoto('three')];
    mockMediaState.photoLoadFailed = false;
    mockMediaState.photoProcessedIds = [];
    mockMediaState.deleteQueue = [];
    mockMediaState.permissionScope = 'full';
    mockMediaState.isConfirmingDeletion = false;
    mockMediaState.hiddenPhotoQueuedAssetIds = null;
    mockMediaState.mediaLibraryRefreshVersion = 0;
    jest.clearAllMocks();
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    mockMediaState.keepPendingDeletion.mockImplementation((id: string) => mockMediaState.keepPhotoFromDeleteQueue(id));
    mockMediaState.resetBatch.mockImplementation(() => { mockMediaState.photos = []; });
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => mockPhoto(id));
    mockMediaState.undoAction.mockImplementation((id: string) => {
      mockMediaState.deleteQueue = mockMediaState.deleteQueue.filter(photo => photo.id !== id);
      mockMediaState.photoProcessedIds = mockMediaState.photoProcessedIds.filter(processed => processed !== id);
    });
    mockMediaState.keepPhotoFromDeleteQueue.mockImplementation((id: string) => {
      if (mockMediaState.isConfirmingDeletion || !mockMediaState.deleteQueue.some(photo => photo.id === id)) return false;
      mockMediaState.deleteQueue = mockMediaState.deleteQueue.filter(photo => photo.id !== id);
      if (!mockMediaState.photoProcessedIds.includes(id)) mockMediaState.photoProcessedIds.push(id);
      return true;
    });
    mockCardSizes.clear();
  });

  it('distinguishes a failed photo read from an empty library and retries without changing decisions', async () => {
    mockMediaState.photos = [];
    mockMediaState.photoLoadFailed = true;
    await renderAsync(<PhotosScreen />);
    expect(screen.getByRole('alert').props.children).toBe('photos_load_failed');
    expect(screen.queryByText('photos_empty')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy(); // The pending-entry count is independent of a failed feed read.
    mockLoadPhotos.mockClear();
    await fireEventAsync.press(screen.getByRole('button', { name: 'photos_reload' }));
    expect(mockLoadPhotos).toHaveBeenCalledWith(10, 'random', [], 'new');
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.resetBatch).not.toHaveBeenCalled();
  });

  it('keeps a restored deletion queue reachable even if reading the next photo batch failed', async () => {
    mockMediaState.photos = [];
    mockMediaState.photoLoadFailed = true;
    mockMediaState.deleteQueue = [mockPhoto('pending')];
    mockMediaState.photoProcessedIds = ['pending'];
    await renderAsync(<PhotosScreen />);
    expect(screen.getByTestId('photo-review')).toBeTruthy();
    expect(screen.getByText('photos_review_title')).toBeTruthy();
    expect(mockMediaState.resetBatch).not.toHaveBeenCalled();
    expect(mockMediaState.confirmDeletion).not.toHaveBeenCalled();
  });

  it('shows the real current batch count, then opens the existing photo deck', async () => {
    mockMediaState.photos = [mockPhoto('one'), mockPhoto('two')];
    await renderAsync(<PhotosScreen />);
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.press(screen.getByText('photos_home_start'));
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 390, height: 500 } } });
    expect(screen.getByText('card:one')).toBeTruthy();
  });

  it('does not duplicate the dock settings entry in the home header', async () => {
    await renderAsync(<PhotosScreen />);
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(screen.queryByLabelText('tab_settings')).toBeNull();
    expect(screen.getByRole('button', { name: 'scope_title' })).toBeTruthy();
    expect(screen.queryByText('photos_manage_access')).toBeNull();
  });

  it('keeps system insets and the Dock outside the scrollable home without changing the batch or filter', async () => {
    mockInsets = { top: 32, bottom: 24, left: 4, right: 8 };
    const view = await renderAsync(<PhotosScreen />);
    expect(screen.getByTestId('photos-home')).toHaveStyle({ paddingTop: 32, paddingBottom: 89, paddingLeft: 4, paddingRight: 8 });
    const scrollContent = StyleSheet.flatten(view.UNSAFE_getByType(ScrollView).props.contentContainerStyle);
    expect(scrollContent.paddingTop).toBe(16);
    expect(scrollContent.paddingBottom).toBe(24);
    expect(screen.getByText('3')).toBeTruthy();
    expect(mockSettingsState.setSelectedAlbums).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
  });

  it.each([1, 3])('places the primary organizing action before optional previews for a %s-photo batch', async count => {
    mockMediaState.photos = Array.from({ length: count }, (_, index) => mockPhoto(`priority-${index}`));
    const view = await renderAsync(<PhotosScreen />);
    // Host traversal validates reading/layout order, not native pixel geometry.
    // Small-screen position and hit targets still require the emulator check.
    const nodes: any[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      nodes.push(node); node.children?.forEach(visit);
    };
    visit(view.toJSON());
    const actionIndex = nodes.findIndex(node => node.props?.accessibilityRole === 'button'
      && JSON.stringify(node.children).includes('photos_home_start'));
    const previewIndex = nodes.findIndex(node => node.type === 'Image' && node.props.source?.uri === 'file:///priority-0.jpg');
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    expect(previewIndex).toBeGreaterThan(actionIndex);
    expect(mockMediaState.startOrganizingSession).not.toHaveBeenCalled();
    await fireEventAsync.press(screen.getByRole('button', { name: 'photos_home_start' }));
    expect(mockMediaState.startOrganizingSession).toHaveBeenCalledWith('photo', { albumIds: [], order: 'random' }, mockMediaState.photos.map(photo => photo.id));
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
  });

  it('reserves the Dock and safe areas before measuring space for media', async () => {
    mockInsets = { top: 32, bottom: 24, left: 4, right: 8 };
    await renderAsync(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    expect(screen.getByTestId('photos-deck')).toHaveStyle({ paddingTop: 32, paddingBottom: 89, paddingLeft: 4, paddingRight: 8 });
    expect(screen.queryByText('card:one')).toBeNull();
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 308, height: 400 } } });
    expect(mockCardSizes.get('one')).toEqual({ maxWidth: 268, maxHeight: 384 });
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
  });

  it('updates all card bounds when the viewport changes without changing batch or filters', async () => {
    await renderAsync(<PhotosScreen />);
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

  it('keeps readable, wrapping gesture directions distinct from the later deletion review', async () => {
    await renderAsync(<PhotosScreen />);
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
    await renderAsync(<PhotosScreen />);
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
    await renderAsync(<PhotosScreen />);
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
    await renderAsync(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'photos_manage_access' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'photos_manage_access' }).props.accessibilityState.disabled).toBe(false));
    expect(mockMediaState.notifyPermissionRefresh).not.toHaveBeenCalled();
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
    expect(mockMediaState.resetBatch).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 30])('previews at most three real photos from a %s-photo batch without reordering it', async count => {
    mockMediaState.photos = Array.from({ length: count }, (_, index) => mockPhoto(`photo-${index}`));
    const originalIds = mockMediaState.photos.map(photo => photo.id);
    await renderAsync(<PhotosScreen />);
    expect(screen.getByText(String(count))).toBeTruthy();
    expect(screen.UNSAFE_getAllByType(Image).map(image => image.props.source.uri))
      .toEqual(mockMediaState.photos.slice(0, 3).map(photo => photo.uri));
    expect(mockMediaState.photos.map(photo => photo.id)).toEqual(originalIds);
    expect(mockMediaState.markAsSkipped).not.toHaveBeenCalled();
    expect(mockMediaState.markForDeletion).not.toHaveBeenCalled();
  });

  it('keeps the deck open as an in-memory batch is processed', async () => {
    const view = await renderAsync(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 390, height: 500 } } });
    mockMediaState.photoProcessedIds = ['one'];
    await view.rerenderAsync(<PhotosScreen />);
    expect(screen.queryByText('photos_home_start')).toBeNull();
    expect(screen.getByText('card:two')).toBeTruthy();
  });

  it('keeps the deletion review reachable when the batch is finished', async () => {
    mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    await renderAsync(<PhotosScreen />);
    expect(screen.getByText('pending_confirm')).toBeTruthy();
  });

  it('returns to an empty home after the final batch without reopening processed photos', async () => {
    const view = await renderAsync(<PhotosScreen />);
    fireEvent.press(screen.getByText('photos_home_start'));
    mockMediaState.photos = [];
    mockMediaState.photoProcessedIds = ['one', 'two', 'three'];
    await view.rerenderAsync(<PhotosScreen />);

    fireEvent.press(screen.getByText('photos_back_home'));
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(screen.getByText('scope_title')).toBeTruthy();
    expect(screen.queryByText('photos_home_start')).toBeNull();
    expect(mockMediaState.photoProcessedIds).toEqual(['one', 'two', 'three']);
    expect(screen.queryByText('card:one')).toBeNull();
  });

  it('opens an empty home safely when there are no photos at launch', async () => {
    mockMediaState.photos = [];
    await renderAsync(<PhotosScreen />);
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(screen.getByText('photos_empty')).toBeTruthy();
    expect(screen.getByText('photos_reload')).toBeTruthy();
  });

  it('keeps a restored delete queue in review even when no photos remain', async () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('one')];
    await renderAsync(<PhotosScreen />);
    expect(screen.getByText('pending_confirm')).toBeTruthy();
    expect(screen.queryByText('PickPic')).toBeNull();
  });

  it('keeps permission management available from the empty home', async () => {
    mockMediaState.photos = [];
    mockMediaState.permissionScope = 'limited';
    await renderAsync(<PhotosScreen />);
    expect(screen.getByText('photos_manage_access')).toBeTruthy();
    expect(screen.getByText('photos_limited_access_desc')).toBeTruthy();
  });

  // Shared paging, preview, permission, keep/undo, partial deletion and busy
  // invariants now live in PendingDeletionReview.test.tsx using the real store.
  it('keeps the last restored photo organized and stays until explicitly continued', async () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('restored')];
    mockMediaState.photoProcessedIds = ['restored'];
    await renderAsync(<PhotosScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'pending_confirm' })).toBeEnabled());
    mockLoadPhotos.mockClear();
    fireEvent.press(screen.getByRole('button', { name: 'pending_keep' }));
    expect(screen.getByTestId('photo-review')).toBeTruthy();
    expect(screen.getByText('pending_empty')).toBeTruthy();
    expect(mockMediaState.photoProcessedIds).toEqual(['restored']);
    expect(mockLoadPhotos).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'pending_continue' }));
    expect(mockMediaState.resetBatch).toHaveBeenCalledWith([]);
    expect(mockLoadPhotos).toHaveBeenCalledTimes(1);
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(mockMediaState.confirmPendingDeletion).not.toHaveBeenCalled();
  });

  it('returns home without losing a pending queue or widening the album filter', async () => {
    mockMediaState.photos = [];
    mockMediaState.deleteQueue = [mockPhoto('pending')];
    await renderAsync(<PhotosScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'pending_confirm' })).toBeEnabled());
    mockLoadPhotos.mockClear();
    fireEvent.press(screen.getByRole('button', { name: 'pending_continue' }));
    expect(screen.getByText('PickPic')).toBeTruthy();
    expect(mockMediaState.deleteQueue).toEqual([mockPhoto('pending')]);
    expect(mockMediaState.resetBatch).toHaveBeenCalledWith([]);
    expect(mockLoadPhotos).toHaveBeenCalledWith(10, 'random', []);
    expect(mockMediaState.confirmPendingDeletion).not.toHaveBeenCalled();
  });

  it('keeps a hidden limited-access decision while returning home after keeping a readable one', async () => {
    mockMediaState.photos = [];
    mockMediaState.permissionScope = 'limited';
    mockMediaState.deleteQueue = [mockPhoto('visible'), mockPhoto('hidden')];
    mockMediaState.photoProcessedIds = ['visible', 'hidden'];
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => id === 'hidden' ? null : mockPhoto(id));
    await renderAsync(<PhotosScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'pending_confirm' })).toBeEnabled());
    fireEvent.press(screen.getAllByRole('button', { name: 'pending_keep' })[0]);
    fireEvent.press(screen.getByRole('button', { name: 'pending_continue' }));
    expect(mockMediaState.deleteQueue.map(photo => photo.id)).toEqual(['hidden']);
    expect(mockMediaState.photoProcessedIds).toEqual(['visible', 'hidden']);
    expect(mockMediaState.resetBatch).toHaveBeenCalledWith([]);
    expect(mockMediaState.confirmPendingDeletion).not.toHaveBeenCalled();
  });

  it('offers the same pending queue from the home and the organizing deck', async () => {
    const view = await renderAsync(<PhotosScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'pending_open' }));
    expect(screen.getByTestId('pending-deletion-review')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'close' }));
    fireEvent.press(screen.getByText('photos_home_start'));
    expect(screen.getByRole('button', { name: 'pending_open' })).toBeTruthy();
    await view.unmountAsync();
  });
});
