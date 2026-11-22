import React from 'react';
import { act, fireEvent, fireEventAsync, renderAsync, waitFor } from '@testing-library/react-native';
import * as ReactNative from 'react-native';

const mockMarkVideoAsProcessed = jest.fn();
const mockLoadVideos = jest.fn().mockResolvedValue(undefined);
const mockGetPermissionsAsync = jest.fn().mockResolvedValue({
  granted: true,
  accessPrivileges: 'all',
  canAskAgain: true,
});

const videoOne = {
  id: 'video-1',
  uri: 'file:///video-1.mp4',
  creationTime: 1,
  mediaType: 'video',
  width: 1920,
  height: 1080,
};
const videoTwo = {
  ...videoOne,
  id: 'video-2',
  uri: 'file:///video-2.mp4',
  creationTime: 2,
};

const mockMediaState = {
  videos: [videoOne, videoTwo],
  loadVideos: mockLoadVideos,
  isLoading: false,
  videoLoadFailed: false,
  hasHydrated: true,
  videoProcessedIds: [],
  markVideoForTrash: jest.fn(),
  markVideoAsProcessed: mockMarkVideoAsProcessed,
  videoTrashBin: [] as (typeof videoOne)[],
  deleteQueue: [], pendingDeletionInfo: {}, permissionRefreshVersion: 0,
  isConfirmingDeletion: false, keepPendingDeletion: jest.fn(), keepAllPendingDeletion: jest.fn((ids: readonly string[]) => ids.length), confirmPendingDeletion: jest.fn(),
  confirmVideoTrash: jest.fn(),
  restoreFromTrash: jest.fn(),
  isConfirmingVideoTrash: false,
  addAssetToAlbum: jest.fn(),
  hiddenVideoQueuedAssetIds: null,
  mediaLibraryRefreshVersion: 0,
  organizingSessions: { photo: null, video: null }, videoCurrentIndex: 0,
  videoSessionRecoveryStatus: null, videoSessionUnavailableCount: 0,
  moveVideoSession: jest.fn(), deferSessionMedia: jest.fn(), revisitSessionDeferred: jest.fn(),
  refreshQueuedAssetVisibility: jest.fn(),
  pruneUnavailableQueuedAssets: jest.fn(),
};

const mockUseMediaStore = jest.fn((selector?: (state: typeof mockMediaState) => unknown) => (
  selector ? selector(mockMediaState) : mockMediaState
));
const mockSettingsState = {
  displayOrder: 'random' as const,
  selectedAlbumIds: [] as string[],
  hasHydrated: true,
};
const mockUseSettingsStore = jest.fn(() => mockSettingsState);

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: mockGetPermissionsAsync,
  getAssetInfoAsync: jest.fn(async (id: string) => ({ ...videoOne, id })),
  requestPermissionsAsync: jest.fn(),
  presentPermissionsPickerAsync: jest.fn(),
}));
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const ReactModule = require('react');
    ReactModule.useEffect(effect, [effect]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
  Feather: () => null,
}));
jest.mock('../components/AlbumSelector', () => ({
  AlbumSelector: () => null,
}));
jest.mock('../components/GlassContainer', () => ({
  GlassContainer: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../components/VideoFeedItem', () => ({
  VideoFeedItem: () => null,
}));
jest.mock('../hooks/useI18n', () => ({
  useI18n: () => ({ language: 'zh', t: (key: string, params?: { count: number }) => key === 'pending_open' ? `${key} · ${params?.count}` : key }),
}));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => ({
    colors: {
      background: '#fff',
      primary: '#f00',
      text: '#000',
    },
    isDark: false,
  }),
}));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: Object.assign(mockUseMediaStore, {
    getState: () => mockMediaState,
  }),
}));
jest.mock('../stores/useSettingsStore', () => ({
  useSettingsStore: mockUseSettingsStore,
}));

let VideosScreen: React.ComponentType;

async function renderScreen() {
  const screen = await renderAsync(React.createElement(VideosScreen));
  const viewport = await waitFor(() => screen.getByTestId('video-feed-viewport'));
  fireEvent(viewport, 'layout', { nativeEvent: { layout: { height: 600, width: 390 } } });
  return screen;
}

function settlePage(list: any, index: number) {
  list.props.onScrollBeginDrag();
  list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: index * list.props.snapToInterval } } });
}

describe('VideosScreen processing behavior', () => {
  afterEach(async () => { await act(async () => {}); });
  beforeAll(() => {
    VideosScreen = require('../app/(tabs)/videos').default;
  });

  beforeEach(() => {
    mockMediaState.videos = [videoOne, videoTwo];
    mockMediaState.videoLoadFailed = false;
    mockMediaState.videoTrashBin = [];
    mockMediaState.isConfirmingVideoTrash = false;
    mockMediaState.hiddenVideoQueuedAssetIds = null;
    mockMediaState.confirmVideoTrash.mockReset();
    mockMediaState.restoreFromTrash.mockClear();
    mockMediaState.keepPendingDeletion.mockClear();
    mockMediaState.confirmPendingDeletion.mockClear();
    mockSettingsState.selectedAlbumIds = [];
    mockMarkVideoAsProcessed.mockClear();
    mockLoadVideos.mockClear();
    mockGetPermissionsAsync.mockClear();
    mockGetPermissionsAsync.mockResolvedValue({
      granted: true,
      accessPrivileges: 'all',
      canAskAgain: true,
    });
  });

  it('distinguishes a failed video read from no videos and retains the pending review entry', async () => {
    mockMediaState.videos = [];
    mockMediaState.videoLoadFailed = true;
    mockMediaState.videoTrashBin = [videoOne];
    const screen = await renderScreen();
    expect(screen.getByRole('alert').props.children).toBe('video_load_failed');
    expect(screen.queryByText('video_empty')).toBeNull();
    mockLoadVideos.mockClear();
    await fireEventAsync.press(screen.getByRole('button', { name: 'photos_reload' }));
    expect(mockLoadVideos).toHaveBeenCalledWith(50, 'random', []);
    await fireEventAsync.press(screen.getByRole('button', { name: 'pending_open · 1' }));
    expect(screen.getByRole('button', { name: 'pending_keep' })).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    expect(mockMediaState.confirmVideoTrash).not.toHaveBeenCalled();
  });

  it('does not mark the current video when leaving the tab', async () => {
    const screen = await renderScreen();

    await waitFor(() => expect(mockGetPermissionsAsync).toHaveBeenCalled(), { timeout: 5000 });
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoOne.id }],
      });
    });

    await screen.unmountAsync();

    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
  });

  it('still marks the previous video when the user advances to the next one', async () => {
    const screen = await renderScreen();

    await waitFor(() => expect(mockGetPermissionsAsync).toHaveBeenCalled(), { timeout: 5000 });
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoOne.id }],
      });
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoTwo.id }],
      });
      settlePage(flatList, 1);
    });

    expect(mockMarkVideoAsProcessed).toHaveBeenCalledWith(videoOne);
  });

  it('keeps the previous video available and does not process again when swiping back', async () => {
    const screen = await renderScreen();

    await waitFor(() => expect(mockGetPermissionsAsync).toHaveBeenCalled(), { timeout: 5000 });
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoOne.id }],
      });
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoTwo.id }],
      });
      settlePage(flatList, 1);
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoOne.id }],
      });
      settlePage(flatList, 0);
    });

    expect(flatList.props.data).toEqual([videoOne, videoTwo]);
    expect(mockMarkVideoAsProcessed).toHaveBeenCalledTimes(1);
    expect(mockMarkVideoAsProcessed).toHaveBeenCalledWith(videoOne);
    await screen.unmountAsync();
  });

  it('shows a notice when the user advances to the final video', async () => {
    const screen = await renderScreen();

    await waitFor(() => expect(mockGetPermissionsAsync).toHaveBeenCalled(), { timeout: 5000 });
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoOne.id }],
      });
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoTwo.id }],
      });
    });

    expect(screen.getByText('video_last_item')).toBeTruthy();
    await screen.unmountAsync();
  });

  it('shows the final-video notice for a single-item feed without processing it', async () => {
    mockMediaState.videos = [videoOne];
    const screen = await renderScreen();
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    await screen.unmountAsync();
  });

  it('shows the notice when the first viewability event is already the final item', async () => {
    const screen = await renderScreen();
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    await screen.unmountAsync();
  });

  it('hides the final-video notice when returning to a previous item without processing the last one', async () => {
    const screen = await renderScreen();
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
      settlePage(flatList, 1);
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
      settlePage(flatList, 0);
    });
    expect(screen.queryByText('video_last_item')).toBeNull();
    expect(mockMarkVideoAsProcessed).toHaveBeenCalledTimes(1);
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalledWith(videoTwo);
    await screen.unmountAsync();
  });

  it('removes the final-item notice when the final video leaves the feed without a loading cycle', async () => {
    mockMediaState.videos = [videoOne];
    const screen = await renderScreen();
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    mockMediaState.videos = [];
    await screen.rerenderAsync(React.createElement(VideosScreen));
    expect(screen.getByText('video_empty')).toBeTruthy();
    expect(screen.queryByText('video_last_item')).toBeNull();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    await screen.unmountAsync();
  });

  it('does not carry a removed video\'s final-item notice onto its replacement before it is visible', async () => {
    mockMediaState.videos = [videoOne];
    const screen = await renderScreen();
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
    });
    mockMediaState.videos = [videoTwo];
    await screen.rerenderAsync(React.createElement(VideosScreen));
    expect(screen.queryByText('video_last_item')).toBeNull();
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    await screen.unmountAsync();
  });

  it('does not process a video when a partial drag reveals the next item but snaps back', async () => {
    const screen = await renderScreen();
    const list = screen.UNSAFE_getByType(ReactNative.FlatList);
    act(() => {
      list.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
      list.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
      list.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
      settlePage(list, 0);
    });
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    await screen.unmountAsync();
  });

  it('does not process a transiently visible next video when the tab is left before settling', async () => {
    const screen = await renderScreen();
    const list = screen.UNSAFE_getByType(ReactNative.FlatList);
    act(() => {
      list.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
      list.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
    });
    await screen.unmountAsync();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
  });

  it('does not process a video when native momentum is emitted by a restore rather than a finger drag', async () => {
    const view = await renderScreen();
    const list = view.UNSAFE_getByType(ReactNative.FlatList);
    act(() => list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 600 } } }));
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    await view.unmountAsync();
  });

  it('uses the measured feed viewport for both snapping and item layout', async () => {
    const screen = await renderScreen();
    const list = screen.UNSAFE_getByType(ReactNative.FlatList);
    act(() => list.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] }));
    expect(list.props.snapToInterval).toBe(600);
    expect(list.props.getItemLayout(null, 1)).toEqual({ length: 600, offset: 600, index: 1 });
    fireEvent(screen.getByTestId('video-feed-viewport'), 'layout', { nativeEvent: { layout: { height: 520, width: 390 } } });
    const resizedList = screen.UNSAFE_getByType(ReactNative.FlatList);
    expect(resizedList).not.toBe(list);
    expect(resizedList.props.snapToInterval).toBe(520);
    expect(resizedList.props.getItemLayout(null, 1)).toEqual({ length: 520, offset: 520, index: 1 });
    // Layout changes need not emit another viewability callback.
    expect(screen.getByRole('button', { name: 'video_keep' })).toBeEnabled();
    expect(screen.getByText('video_last_item')).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    await screen.unmountAsync();
  });

  it('keeps large trash counts inside the header and announces the full count', async () => {
    mockMediaState.videoTrashBin = Array.from({ length: 120 }, (_, index) => ({ ...videoOne, id: `trash-${index}` }));
    const screen = await renderScreen();
    const button = screen.getByRole('button', { name: 'pending_open · 120' });
    expect(screen.getByText('99+')).toBeTruthy();
    const style = ReactNative.StyleSheet.flatten(button.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.overflow).not.toBe('hidden');
    await screen.unmountAsync();
  });

  it('locks paging during progress scrubbing and does not treat residual momentum as organizing', async () => {
    const screen = await renderScreen();
    let list = screen.UNSAFE_getByType(ReactNative.FlatList);
    act(() => list.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] }));
    const itemType = require('../components/VideoFeedItem').VideoFeedItem;
    const first = screen.UNSAFE_getAllByType(itemType).find(item => item.props.video.id === videoOne.id)!;
    act(() => {
      list.props.onScrollBeginDrag();
      first.props.onScrubbingChange(true);
    });
    list = screen.UNSAFE_getByType(ReactNative.FlatList);
    expect(list.props.scrollEnabled).toBe(false);
    act(() => list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: list.props.snapToInterval } } }));
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    act(() => first.props.onScrubbingChange(false));
    expect(screen.UNSAFE_getByType(ReactNative.FlatList).props.scrollEnabled).toBe(true);
    expect(mockMediaState.markVideoForTrash).not.toHaveBeenCalled();
    await screen.unmountAsync();
  });

  it('pauses feed playback while trash is open without reviewing or deleting anything', async () => {
    const screen = await renderScreen();
    const list = screen.UNSAFE_getByType(ReactNative.FlatList);
    act(() => list.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] }));
    const itemType = require('../components/VideoFeedItem').VideoFeedItem;
    expect(screen.UNSAFE_getAllByType(itemType).some(item => item.props.shouldPlay)).toBe(true);
    await fireEventAsync.press(screen.getByRole('button', { name: 'pending_open · 0' }));
    expect(screen.UNSAFE_getAllByType(itemType).every(item => !item.props.shouldPlay)).toBe(true);
    await fireEventAsync.press(screen.getByRole('button', { name: 'close' }));
    expect(screen.UNSAFE_getAllByType(itemType).some(item => item.props.shouldPlay)).toBe(true);
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    expect(mockMediaState.confirmVideoTrash).not.toHaveBeenCalled();
    await screen.unmountAsync();
  });

  it('explains an album-filtered empty feed without silently widening the album selection', async () => {
    mockMediaState.videos = [];
    mockSettingsState.selectedAlbumIds = ['photos-only-album'];
    const screen = await renderScreen();
    expect(screen.getByText('video_filtered_empty_hint')).toBeTruthy();
    expect(mockSettingsState.selectedAlbumIds).toEqual(['photos-only-album']);
    await screen.unmountAsync();
  });

  // System cancellation, partial success, retry, safe-area and keep semantics
  // are shared and tested through the real store in PendingDeletionReview tests.
  it('opens the common mixed-media review without physically deleting on entry', async () => {
    mockMediaState.videoTrashBin = [videoOne];
    const screen = await renderScreen();
    await fireEventAsync.press(screen.getByRole('button', { name: 'pending_open · 1' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'pending_confirm' })).toBeEnabled());
    expect(screen.getByTestId('pending-deletion-review')).toBeTruthy();
    expect(screen.getByText('photos_review_warning')).toBeTruthy();
    expect(mockMediaState.confirmPendingDeletion).not.toHaveBeenCalled();
    await fireEventAsync.press(screen.getByRole('button', { name: 'close' }));
    expect(mockMediaState.videoTrashBin).toEqual([videoOne]);
  });

  it('keeps a pending video through the shared API without reinserting it or reloading the feed', async () => {
    mockMediaState.videoTrashBin = [videoOne];
    const screen = await renderScreen();
    await fireEventAsync.press(screen.getByRole('button', { name: 'pending_open · 1' }));
    mockLoadVideos.mockClear();
    await fireEventAsync.press(screen.getByRole('button', { name: 'pending_keep' }));
    expect(mockMediaState.keepPendingDeletion).toHaveBeenCalledWith('video-1');
    expect(mockLoadVideos).not.toHaveBeenCalled();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    expect(mockMediaState.confirmPendingDeletion).not.toHaveBeenCalled();
  });

  it('bounds FlatList virtualization and limits active video playback sources to current and adjacent items', async () => {
    const fiveVideos = Array.from({ length: 5 }, (_, index) => ({
      ...videoOne,
      id: `video-${index}`,
      uri: `file:///video-${index}.mp4`,
      creationTime: index + 1,
    }));
    mockMediaState.videos = fiveVideos;
    const screen = await renderScreen();
    const list = screen.UNSAFE_getByType(ReactNative.FlatList);

    expect(list.props.windowSize).toBe(3);
    expect(list.props.maxToRenderPerBatch).toBe(2);
    expect(list.props.initialNumToRender).toBe(2);
    expect(list.props.removeClippedSubviews).toBe(true);

    act(() => {
      list.props.onViewableItemsChanged({ viewableItems: [{ key: 'video-2' }] });
    });

    const updatedList = screen.UNSAFE_getByType(ReactNative.FlatList);
    const renderedProps = fiveVideos.map((item, index) => {
      const element = updatedList.props.renderItem({ item, index, separators: {} });
      return { id: item.id, shouldLoadSource: element.props.shouldLoadSource, isActive: element.props.isActive };
    });

    expect(renderedProps).toEqual([
      { id: 'video-0', shouldLoadSource: false, isActive: false },
      { id: 'video-1', shouldLoadSource: true, isActive: false },
      { id: 'video-2', shouldLoadSource: true, isActive: true },
      { id: 'video-3', shouldLoadSource: true, isActive: false },
      { id: 'video-4', shouldLoadSource: false, isActive: false },
    ]);
    await screen.unmountAsync();
  });
});
