import React from 'react';

const mockPlayer = {
  loop: false,
  muted: false,
  play: jest.fn(),
  pause: jest.fn(),
  currentTime: 0,
  duration: 0,
  timeUpdateEventInterval: 0,
  addListener: jest.fn(() => ({ remove: jest.fn() })),
};
const mockEnterFullscreen = jest.fn().mockResolvedValue(undefined);
const mockExitFullscreen = jest.fn().mockResolvedValue(undefined);
const mockVideoViewProps: { current: Record<string, any> | null } = { current: null };

jest.mock('expo-video', () => {
  const ReactModule = require('react');
  const VideoView = ReactModule.forwardRef((props: Record<string, any>, ref: React.Ref<any>) => {
    mockVideoViewProps.current = props;
    ReactModule.useImperativeHandle(ref, () => ({
      enterFullscreen: mockEnterFullscreen,
      exitFullscreen: mockExitFullscreen,
    }));
    return ReactModule.createElement(require('react-native').View, { testID: 'video-view' });
  });

  return {
    VideoView,
    useVideoPlayer: jest.fn((_source, setup) => {
      setup?.(mockPlayer);
      return mockPlayer;
    }),
  };
});

jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn(),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('../../constants/theme', () => ({ ...jest.requireActual('../../constants/theme'), COLORS: { white: '#fff', danger: '#f00' } }));
jest.mock('../../hooks/useThemeColor', () => ({
  useThemeColor: () => ({ colors: { text: '#fff', danger: '#f00', textSecondary: '#aaa' } }),
}));
jest.mock('../../stores/useMediaStore', () => ({}));
jest.mock('../../components/ScalablePressable', () => ({
  ScalablePressable: ({ children, ...props }: any) => {
    const ReactModule = require('react');
    return ReactModule.createElement(
      require('react-native').Pressable,
      { ...props, testID: 'scalable-pressable' },
      children,
    );
  },
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import * as ReactNative from 'react-native';
import { VideoFeedItem } from '../../components/VideoFeedItem';

const video = {
  id: 'video-1',
  uri: 'file:///video-1.mp4',
  creationTime: 0,
  mediaType: 'video',
  width: 1920,
  height: 1080,
} as any;

function renderVideo(overrides: Partial<React.ComponentProps<typeof VideoFeedItem>> = {}) {
  return render(
    <VideoFeedItem
      video={video}
      isActive
      isScreenFocused
      shouldPlay
      isMuted={false}
      toggleMute={jest.fn()}
      onDelete={jest.fn()}
      onFavorite={jest.fn()}
      t={(key: string) => key}
      colors={{}}
      itemHeight={500}
      {...overrides}
    />,
  );
}

describe('VideoFeedItem with expo-video', () => {
  beforeEach(() => {
    mockPlayer.play.mockClear();
    mockPlayer.pause.mockClear();
    mockEnterFullscreen.mockClear();
    mockExitFullscreen.mockClear();
    mockVideoViewProps.current = null;
  });

  it('uses the existing compact rail when large labels would clip a vertical action', () => {
    const dimensions = jest.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width: 320, height: 640, scale: 2.625, fontScale: 1.5 });
    try {
      const view = renderVideo({ itemHeight: 370 });
      const favorite = view.getByRole('button', { name: 'video_favorite' });
      expect(view.queryByText('video_favorite')).toBeNull();
      expect(StyleSheet.flatten(view.getByRole('button', { name: 'video_pause' }).props.style).marginBottom).toBeGreaterThanOrEqual(100);
      expect(StyleSheet.flatten(favorite.props.style).minHeight).toBeGreaterThanOrEqual(44);
      let rail = favorite.parent;
      while (rail && StyleSheet.flatten(rail.props.style)?.flexDirection !== 'row') rail = rail.parent;
      expect(rail).not.toBeNull();
      const railStyle = StyleSheet.flatten(rail!.props.style);
      const imageStyle = StyleSheet.flatten(view.getByRole('button', { name: 'video_pause' }).props.style);
      expect(imageStyle.marginBottom).toBeGreaterThanOrEqual(railStyle.bottom + StyleSheet.flatten(favorite.props.style).minHeight + 8);
      expect(view.getByRole('button', { name: 'video_queue_delete' })).toBeEnabled();
    } finally { dimensions.mockRestore(); }
  });

  it('keeps player configuration and play/pause behavior', async () => {
    renderVideo();

    await waitFor(() => expect(mockPlayer.play).toHaveBeenCalled());
    expect(mockPlayer.loop).toBe(true);
    expect(mockPlayer.muted).toBe(false);
    expect(mockVideoViewProps.current).toMatchObject({
      contentFit: 'contain',
      nativeControls: false,
      playsInline: true,
      fullscreenOptions: { enable: true },
      player: mockPlayer,
    });
  });

  it('uses the new fullscreen API without pausing the shared native player', async () => {
    const { getByRole } = renderVideo();

    await waitFor(() => expect(mockVideoViewProps.current).not.toBeNull());
    fireEvent(getByRole('button', { name: 'video_pause' }), 'longPress');
    await waitFor(() => expect(mockEnterFullscreen).toHaveBeenCalled());
    expect(mockPlayer.pause).not.toHaveBeenCalled();

    act(() => {
      mockVideoViewProps.current?.onFullscreenEnter();
      mockVideoViewProps.current?.onFullscreenExit();
    });
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  });

  it('keeps the Web fullscreen compatibility flag enabled', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });

    try {
      renderVideo();
      expect(mockVideoViewProps.current).toMatchObject({
        allowsFullscreen: true,
        fullscreenOptions: { enable: true },
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(Platform, 'OS', platformDescriptor);
      }
    }
  });

  it('uses the Android modal fallback because SDK 54 cannot exit native fullscreen', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });

    try {
      const { getByRole } = renderVideo();
      fireEvent(getByRole('button', { name: 'video_pause' }), 'longPress');

      await waitFor(() => expect(mockPlayer.pause).toHaveBeenCalled());
      expect(mockEnterFullscreen).not.toHaveBeenCalled();
      expect(mockVideoViewProps.current).toMatchObject({
        fullscreenOptions: { enable: false },
        player: mockPlayer,
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(Platform, 'OS', platformDescriptor);
      }
    }
  });

  it('exposes readable actions, queues deletion only on explicit action, and does not invent a location', () => {
    const onDelete = jest.fn();
    const onFavorite = jest.fn();
    const toggleMute = jest.fn();
    const screen = renderVideo({ onDelete, onFavorite, toggleMute, isMuted: true });
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText('video_location_unknown')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'video_muted' }));
    fireEvent.press(screen.getByRole('button', { name: 'video_favorite' }));
    fireEvent.press(screen.getByRole('button', { name: 'video_queue_delete' }));
    expect(toggleMute).toHaveBeenCalledTimes(1);
    expect(onFavorite).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('toggles playback on tap and exposes a separate fullscreen action', async () => {
    const screen = renderVideo();
    fireEvent.press(screen.getByRole('button', { name: 'video_pause' }));
    expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByRole('button', { name: 'video_resume' }));
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
    fireEvent.press(screen.getByRole('button', { name: 'video_fullscreen' }));
    await waitFor(() => expect(mockEnterFullscreen).toHaveBeenCalledTimes(1));
  });

  it('does not log a private file path when native sharing rejects', async () => {
    const sharing = require('expo-sharing');
    const privateMarker = 'PRIVATE_VIDEO_PATH_FROM_NATIVE_PROVIDER';
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    sharing.isAvailableAsync.mockResolvedValueOnce(true);
    sharing.shareAsync.mockRejectedValueOnce(new Error(privateMarker));
    const screen = renderVideo();
    fireEvent.press(screen.getByRole('button', { name: 'video_share' }));
    await waitFor(() => expect(log).toHaveBeenCalled());
    expect(sharing.shareAsync).toHaveBeenCalledWith(video.uri);
    const logged = log.mock.calls.flat().map(value => value instanceof Error ? value.message : String(value)).join('\n');
    expect(logged).not.toContain(privateMarker);
  });

  it.each([
    { background: '#F7F8F7', text: '#1B211D', textSecondary: '#626B64', danger: '#A23E35', selectionBackground: '#E2E8E2' },
    { background: '#111212', text: '#F1F2EF', textSecondary: '#B1B8B0', danger: '#EAB0A4', selectionBackground: '#282D29' },
  ])('keeps the action rail unframed and separate from video in palette $background', colors => {
    const screen = renderVideo({ colors });
    const playerStyle = StyleSheet.flatten(screen.getByRole('button', { name: 'video_pause' }).props.style);
    expect(playerStyle.marginRight).toBeGreaterThanOrEqual(64);
    for (const name of ['video_sound', 'video_favorite', 'video_share', 'video_queue_delete']) {
      const buttonStyle = StyleSheet.flatten(screen.getByRole('button', { name }).props.style);
      const labelStyle = StyleSheet.flatten(screen.getByText(name).props.style);
      expect(buttonStyle.minHeight).toBeGreaterThanOrEqual(44);
      expect(buttonStyle.minWidth).toBeGreaterThanOrEqual(44);
      expect(buttonStyle.backgroundColor).toBe('transparent');
      expect(labelStyle.backgroundColor).toBeUndefined();
      expect(labelStyle.color).toBe(name === 'video_queue_delete' ? colors.danger : colors.textSecondary);
    }
  });

  it('retains named touch targets in a short viewport without overlaying the video', () => {
    const screen = renderVideo({ itemHeight: 260 });
    expect(screen.queryByText('video_favorite')).toBeNull();
    const style = StyleSheet.flatten(screen.getByRole('button', { name: 'video_pause' }).props.style);
    expect(style.marginBottom).toBeGreaterThanOrEqual(100);
    expect(screen.getByRole('button', { name: 'video_favorite' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'video_share' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'video_queue_delete' })).toBeTruthy();
  });

  it('releases the native video source and skips media lookup when outside the active decoder window', () => {
    const { useVideoPlayer } = require('expo-video');
    const MediaLibrary = require('expo-media-library');
    (useVideoPlayer as jest.Mock).mockClear();
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockClear();

    const phVideo = { ...video, id: 'video-far', uri: 'ph://video-far' };
    const view = renderVideo({
      video: phVideo,
      isActive: false,
      shouldPlay: false,
      shouldLoadSource: false,
    });

    expect(useVideoPlayer).toHaveBeenCalledWith(null, expect.any(Function));
    expect(view.queryByTestId('video-view')).toBeNull();
    expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
    expect(mockPlayer.play).not.toHaveBeenCalled();

    // Entering the decoder window binds the source; leaving releases it back to null.
    view.rerender(
      <VideoFeedItem
        video={video}
        isActive
        isScreenFocused
        shouldPlay
        shouldLoadSource
        isMuted={false}
        toggleMute={jest.fn()}
        onDelete={jest.fn()}
        onFavorite={jest.fn()}
        t={(key: string) => key}
        colors={{}}
        itemHeight={500}
      />,
    );
    expect(useVideoPlayer).toHaveBeenLastCalledWith(video.uri, expect.any(Function));
    expect(view.getByTestId('video-view')).toBeTruthy();

    view.rerender(
      <VideoFeedItem
        video={video}
        isActive={false}
        isScreenFocused
        shouldPlay={false}
        shouldLoadSource={false}
        isMuted={false}
        toggleMute={jest.fn()}
        onDelete={jest.fn()}
        onFavorite={jest.fn()}
        t={(key: string) => key}
        colors={{}}
        itemHeight={500}
      />,
    );
    expect(useVideoPlayer).toHaveBeenLastCalledWith(null, expect.any(Function));
    expect(view.queryByTestId('video-view')).toBeNull();
  });
});
