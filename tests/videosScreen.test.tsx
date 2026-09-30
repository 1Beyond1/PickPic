import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
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
  hasHydrated: true,
  videoProcessedIds: [],
  markVideoForTrash: jest.fn(),
  markVideoAsProcessed: mockMarkVideoAsProcessed,
  videoTrashBin: [],
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
  selectedAlbumIds: [],
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

describe('VideosScreen processing behavior', () => {
  beforeAll(() => {
    VideosScreen = require('../app/(tabs)/videos').default;
  });

  beforeEach(() => {
    mockMediaState.videos = [videoOne, videoTwo];
    mockMarkVideoAsProcessed.mockClear();
    mockLoadVideos.mockClear();
    mockGetPermissionsAsync.mockClear();
    mockGetPermissionsAsync.mockResolvedValue({
      granted: true,
      accessPrivileges: 'all',
      canAskAgain: true,
    });
  });

  it('does not mark the current video when leaving the tab', async () => {
    const screen = render(React.createElement(VideosScreen));

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
    const screen = render(React.createElement(VideosScreen));

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

    expect(mockMarkVideoAsProcessed).toHaveBeenCalledWith(videoOne);
  });

  it('keeps the previous video available and does not process again when swiping back', async () => {
    const screen = render(React.createElement(VideosScreen));

    await waitFor(() => expect(mockGetPermissionsAsync).toHaveBeenCalled(), { timeout: 5000 });
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoOne.id }],
      });
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoTwo.id }],
      });
      flatList.props.onViewableItemsChanged({
        viewableItems: [{ key: videoOne.id }],
      });
    });

    expect(flatList.props.data).toEqual([videoOne, videoTwo]);
    expect(mockMarkVideoAsProcessed).toHaveBeenCalledTimes(1);
    expect(mockMarkVideoAsProcessed).toHaveBeenCalledWith(videoOne);
    screen.unmount();
  });

  it('shows a notice when the user advances to the final video', async () => {
    const screen = render(React.createElement(VideosScreen));

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
    const screen = render(React.createElement(VideosScreen));
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    screen.unmount();
  });

  it('shows the notice when the first viewability event is already the final item', async () => {
    const screen = render(React.createElement(VideosScreen));
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalled();
    screen.unmount();
  });

  it('hides the final-video notice when returning to a previous item without processing the last one', async () => {
    const screen = render(React.createElement(VideosScreen));
    const flatList = await waitFor(() => screen.UNSAFE_getByType(ReactNative.FlatList));
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoTwo.id }] });
    });
    expect(screen.getByText('video_last_item')).toBeTruthy();
    act(() => {
      flatList.props.onViewableItemsChanged({ viewableItems: [{ key: videoOne.id }] });
    });
    expect(screen.queryByText('video_last_item')).toBeNull();
    expect(mockMarkVideoAsProcessed).toHaveBeenCalledTimes(1);
    expect(mockMarkVideoAsProcessed).not.toHaveBeenCalledWith(videoTwo);
    screen.unmount();
  });
});
