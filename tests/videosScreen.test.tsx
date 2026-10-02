import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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
  confirmVideoTrash: jest.fn(),
  restoreFromTrash: jest.fn(),
  isConfirmingVideoTrash: false,
  addAssetToAlbum: jest.fn(),
  hiddenVideoQueuedAssetIds: null,
  mediaLibraryRefreshVersion: 0,
  refreshQueuedAssetVisibility: jest.fn(),
  pruneUnavailableQueuedAssets: jest.fn(),
};

const mockUseMediaStore = jest.fn(() => mockMediaState);
const mockSettingsState = {
  displayOrder: 'random' as const,
  selectedAlbumIds: [] as string[],
  hasHydrated: true,
};
const mockUseSettingsStore = jest.fn(() => mockSettingsState);

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: mockGetPermissionsAsync,
  requestPermissionsAsync: jest.fn(),
  presentPermissionsPickerAsync: jest.fn(),
}));
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
}));
jest.mock('expo-router', () => ({
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
  useI18n: () => ({ language: 'zh', t: (key: string) => key }),
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
  const screen = render(React.createElement(VideosScreen));
  const viewport = await waitFor(() => screen.getByTestId('video-feed-viewport'));
  fireEvent(viewport, 'layout', { nativeEvent: { layout: { height: 600, width: 390 } } });
  return screen;
}

function settlePage(list: any, index: number) {
  list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: index * list.props.snapToInterval } } });
}

describe('VideosScreen processing behavior', () => {
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
    fireEvent.press(screen.getByRole('button', { name: 'photos_reload' }));
    expect(mockLoadVideos).toHaveBeenCalledWith(50, 'random', []);
    fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
    expect(screen.getByRole('button', { name: 'video_restore · video-1' })).toBeTruthy();
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

    screen.unmount();

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
    screen.unmount();
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
    screen.unmount();
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
    screen.unmount();
  });

  it('shows the notice when the first viewability event is already the final item', async () => {
    const screen = await renderScreen();
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    screen.unmount();
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
    screen.unmount();
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
    screen.rerender(React.createElement(VideosScreen));
    expect(screen.getByText('video_empty')).toBeTruthy();
    expect(screen.queryByText('video_last_item')).toBeNull();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    screen.unmount();
  });

  it('does not carry a removed video\'s final-item notice onto its replacement before it is visible', async () => {
    mockMediaState.videos = [videoOne];
    const screen = await renderScreen();
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
    });
    mockMediaState.videos = [videoTwo];
    screen.rerender(React.createElement(VideosScreen));
    expect(screen.queryByText('video_last_item')).toBeNull();
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    screen.unmount();
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
    screen.unmount();
  });

  it('does not process a transiently visible next video when the tab is left before settling', async () => {
    const screen = await renderScreen();
    const list = screen.UNSAFE_getByType(ReactNative.FlatList);
    act(() => {
      list.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
      list.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
    });
    screen.unmount();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
  });

  it('uses the measured feed viewport for both snapping and item layout', async () => {
    const screen = await renderScreen();
    const list = screen.UNSAFE_getByType(ReactNative.FlatList);
    expect(list.props.snapToInterval).toBe(600);
    expect(list.props.getItemLayout(null, 1)).toEqual({ length: 600, offset: 600, index: 1 });
    fireEvent(screen.getByTestId('video-feed-viewport'), 'layout', { nativeEvent: { layout: { height: 520, width: 390 } } });
    const resizedList = screen.UNSAFE_getByType(ReactNative.FlatList);
    expect(resizedList.props.snapToInterval).toBe(520);
    expect(resizedList.props.getItemLayout(null, 1)).toEqual({ length: 520, offset: 520, index: 1 });
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    screen.unmount();
  });

  it('keeps large trash counts inside the header and announces the full count', async () => {
    mockMediaState.videoTrashBin = Array.from({ length: 120 }, (_, index) => ({ ...videoOne, id: `trash-${index}` }));
    const screen = await renderScreen();
    const button = screen.getByRole('button', { name: 'video_trash_title · 120' });
    expect(screen.getByText('99+')).toBeTruthy();
    const style = ReactNative.StyleSheet.flatten(button.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.overflow).not.toBe('hidden');
    screen.unmount();
  });

  it('pauses feed playback while trash is open without reviewing or deleting anything', async () => {
    const screen = await renderScreen();
    const list = screen.UNSAFE_getByType(ReactNative.FlatList);
    act(() => list.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] }));
    const itemType = require('../components/VideoFeedItem').VideoFeedItem;
    expect(screen.UNSAFE_getAllByType(itemType).some(item => item.props.shouldPlay)).toBe(true);
    fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 0' }));
    expect(screen.UNSAFE_getAllByType(itemType).every(item => !item.props.shouldPlay)).toBe(true);
    fireEvent.press(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.UNSAFE_getAllByType(itemType).some(item => item.props.shouldPlay)).toBe(true);
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    expect(mockMediaState.confirmVideoTrash).not.toHaveBeenCalled();
    screen.unmount();
  });

  it('explains an album-filtered empty feed without silently widening the album selection', async () => {
    mockMediaState.videos = [];
    mockSettingsState.selectedAlbumIds = ['photos-only-album'];
    const screen = await renderScreen();
    expect(screen.getByText('video_filtered_empty_hint')).toBeTruthy();
    expect(mockSettingsState.selectedAlbumIds).toEqual(['photos-only-album']);
    screen.unmount();
  });

  it('shows deletion and cloud-sync risk next to the final video action, without deleting on open', async () => {
    mockMediaState.videoTrashBin = [videoOne];
    const screen = await renderScreen();
    fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
    expect(screen.getByText('media_delete_warning')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'video_confirm_delete' })).toBeEnabled();
    expect(mockMediaState.confirmVideoTrash).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'cancel' }));
    expect(mockMediaState.videoTrashBin).toEqual([videoOne]);
    screen.unmount();
  });

  it('restores a pending video then re-queries the current album scope without changing review progress', async () => {
    mockMediaState.videoTrashBin = [videoOne];
    mockSettingsState.selectedAlbumIds = ['current-album'];
    const screen = await renderScreen();
    fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
    mockLoadVideos.mockClear();
    fireEvent.press(screen.getByRole('button', { name: 'video_restore · video-1' }));
    expect(mockMediaState.restoreFromTrash).toHaveBeenCalledWith('video-1');
    expect(mockLoadVideos).toHaveBeenCalledWith(50, 'random', ['current-album']);
    expect(mockMediaState.confirmVideoTrash).not.toHaveBeenCalled();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
  });

  it('keeps queued videos and the panel open when permanent deletion fails', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const alert = jest.spyOn(ReactNative.Alert, 'alert').mockImplementation(() => {});
    mockMediaState.videoTrashBin = [videoOne];
    mockMediaState.confirmVideoTrash.mockRejectedValueOnce(new Error('Native cancellation'));
    try {
      const screen = await renderScreen();
      fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
      fireEvent.press(screen.getByRole('button', { name: 'video_confirm_delete' }));
      await waitFor(() => expect(screen.getByText('视频仍保留在废纸篓中，请重试。')).toBeTruthy());
      expect(alert).not.toHaveBeenCalled();
      expect(mockMediaState.confirmVideoTrash).toHaveBeenCalledWith(['video-1']);
      expect(screen.getByRole('button', { name: 'video_restore · video-1' })).toBeTruthy();
      expect(mockMediaState.videoTrashBin).toEqual([videoOne]);
      expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      alert.mockRestore();
    }
  });

  it('does not imply success when visibility preflight leaves a requested video pending', async () => {
    mockMediaState.videoTrashBin = [videoOne];
    mockMediaState.confirmVideoTrash.mockResolvedValueOnce([]);
    const screen = await renderScreen();
    fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
    fireEvent.press(screen.getByRole('button', { name: 'video_confirm_delete' }));
    await act(async () => {});
    expect(mockMediaState.confirmVideoTrash).toHaveBeenCalledWith(['video-1']);
    expect(screen.getByRole('button', { name: 'video_restore · video-1' })).toBeTruthy();
  });

  it('clears old failure feedback when the pending panel is closed and reopened without changing the queue', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockMediaState.videoTrashBin = [videoOne];
    mockMediaState.confirmVideoTrash.mockRejectedValueOnce(new Error('Native failure'));
    try {
      const screen = await renderScreen();
      fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
      fireEvent.press(screen.getByRole('button', { name: 'video_confirm_delete' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      fireEvent(screen.UNSAFE_getByType(ReactNative.Modal), 'requestClose');
      fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(mockMediaState.videoTrashBin).toEqual([videoOne]);
      expect(mockMediaState.confirmVideoTrash).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('allows retry after failure and closes only when all requested videos are gone', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockMediaState.videoTrashBin = [videoOne];
    mockMediaState.confirmVideoTrash.mockRejectedValueOnce(new Error('Native failure'));
    try {
      const screen = await renderScreen();
      fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
      fireEvent.press(screen.getByRole('button', { name: 'video_confirm_delete' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      mockMediaState.confirmVideoTrash.mockImplementationOnce(async () => {
        mockMediaState.videoTrashBin = [];
        return ['video-1'];
      });
      fireEvent.press(screen.getByRole('button', { name: 'video_confirm_delete' }));
      await waitFor(() => expect(screen.queryByText('video_confirm_delete')).toBeNull());
      expect(mockMediaState.confirmVideoTrash).toHaveBeenCalledTimes(2);
      expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('blocks restore and repeated deletion while allowing the pending panel to be closed', async () => {
    mockMediaState.videoTrashBin = [videoOne];
    mockMediaState.isConfirmingVideoTrash = true;
    const screen = await renderScreen();
    fireEvent.press(screen.getByRole('button', { name: 'video_trash_title · 1' }));
    fireEvent.press(screen.getByRole('button', { name: 'video_restore · video-1' }));
    fireEvent.press(screen.getByRole('button', { name: 'video_confirm_delete' }));
    expect(mockMediaState.restoreFromTrash).not.toHaveBeenCalled();
    expect(mockMediaState.confirmVideoTrash).not.toHaveBeenCalled();
    fireEvent(screen.UNSAFE_getByType(ReactNative.Modal), 'requestClose');
    expect(screen.queryByText('video_confirm_delete')).toBeNull();
    expect(mockMediaState.videoTrashBin).toEqual([videoOne]);
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
  });
});
