import React from 'react';

const mockPlayer = {
  loop: false,
  muted: false,
  play: jest.fn(),
  pause: jest.fn(),
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
jest.mock('../../constants/theme', () => ({ COLORS: { white: '#fff', danger: '#f00' } }));
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
import { Platform } from 'react-native';
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
    const { getAllByTestId } = renderVideo();

    await waitFor(() => expect(mockVideoViewProps.current).not.toBeNull());
    fireEvent(getAllByTestId('scalable-pressable')[0], 'longPress');
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
      const { getAllByTestId } = renderVideo();
      fireEvent(getAllByTestId('scalable-pressable')[0], 'longPress');

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
});
