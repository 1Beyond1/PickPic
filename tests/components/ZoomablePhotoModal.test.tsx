import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal, StyleSheet } from 'react-native';

const mockHandlers: Record<string, (...args: any[]) => void> = {};
let mockPreviewState = {
  uri: 'file:///blur-1.jpg',
  loading: false,
  failed: false,
  attempt: 0,
  onError: jest.fn(),
  retry: jest.fn(),
};
let mockThemeColors = require('../../constants/theme').COLORS_DARK;
const mockTimingWrites: { value: number }[] = [];

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 16, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: mockThemeColors }) }));
jest.mock('../../hooks/usePhotoPreviewSource', () => ({
  usePhotoPreviewSource: (uri: string) => ({
    ...mockPreviewState,
    uri: mockPreviewState.failed ? '' : uri,
  }),
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useSharedValue: (value: any) => require('react').useRef({ value }).current,
  useAnimatedStyle: (cb: () => unknown) => cb(),
  withTiming: (value: any) => {
    mockTimingWrites.push({ value });
    return value;
  },
  useReducedMotion: () => false,
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children, ...rest }: any) => require('react').createElement(require('react-native').View, rest, children),
  GestureDetector: ({ children }: any) => children,
  Gesture: {
    Pinch: () => {
      const g: any = {
        onStart: (fn: any) => { mockHandlers.pinchStart = fn; return g; },
        onUpdate: (fn: any) => { mockHandlers.pinchUpdate = fn; return g; },
        onEnd: (fn: any) => { mockHandlers.pinchEnd = fn; return g; },
      };
      return g;
    },
    Pan: () => {
      const g: any = {
        minPointers: () => g,
        maxPointers: () => g,
        manualActivation: () => g,
        onTouchesDown: (fn: any) => { mockHandlers.panTouchesDown = fn; return g; },
        onTouchesMove: (fn: any) => { mockHandlers.panTouchesMove = fn; return g; },
        onStart: (fn: any) => { mockHandlers.panStart = fn; return g; },
        onUpdate: (fn: any) => { mockHandlers.panUpdate = fn; return g; },
        onEnd: (fn: any) => { mockHandlers.panEnd = fn; return g; },
      };
      return g;
    },
    Tap: () => {
      const g: any = {
        numberOfTaps: () => g,
        maxDuration: () => g,
        onEnd: (fn: any) => { mockHandlers.doubleTapEnd = fn; return g; },
      };
      return g;
    },
    Simultaneous: () => ({}),
  },
}));

import { COLORS, COLORS_DARK } from '../../constants/theme';
import { ZoomablePhotoModal } from '../../components/ZoomablePhotoModal';

describe('ZoomablePhotoModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTimingWrites.length = 0;
    mockThemeColors = COLORS_DARK;
    mockPreviewState = {
      uri: 'file:///blur-1.jpg',
      loading: false,
      failed: false,
      attempt: 0,
      onError: jest.fn(),
      retry: jest.fn(),
    };
  });

  it('renders dark high-contrast preview, handles double-tap/pinch/pan gestures, and dispatches actions', () => {
    const onClose = jest.fn();
    const onIgnore = jest.fn();
    const onDelete = jest.fn();

    const view = render(
      <ZoomablePhotoModal
        visible
        photo={{ id: 'blur-1', uri: 'file:///blur-1.jpg' }}
        title="photo_detail_title"
        subtitle="blur 12.5"
        isProtected
        actions={[
          { id: 'ignore', label: 'blur_ignore_action', onPress: onIgnore },
          { id: 'delete', label: 'pending_add', tone: 'danger', onPress: onDelete },
        ]}
        onClose={onClose}
      />,
    );

    expect(view.UNSAFE_getByType(Modal).props.visible).toBe(true);
    expect(screen.getByTestId('zoom-modal-protected-badge')).toBeTruthy();
    expect(screen.getByText('zoom_preview_hint')).toBeTruthy();

    // Simulate layout + pinch + pan + double-tap reset without throwing.
    fireEvent(screen.getByTestId('zoomable-image-viewport'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 700 } },
    });
    act(() => {
      mockHandlers.pinchStart({ focalX: 200, focalY: 350 });
      mockHandlers.pinchUpdate({ scale: 2.5 });
      mockHandlers.pinchEnd();
      mockHandlers.panStart();
      mockHandlers.panUpdate({ translationX: 60, translationY: -40 });
      mockHandlers.panEnd();
      mockHandlers.doubleTapEnd({ x: 200, y: 350 }, true);
    });

    fireEvent.press(screen.getByRole('button', { name: 'blur_ignore_action' }));
    fireEvent.press(screen.getByRole('button', { name: 'pending_add' }));
    fireEvent.press(screen.getByRole('button', { name: 'close' }));

    expect(onIgnore).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('P1-3: enforces pan touch slop and prevents pan.onEnd from interrupting double-tap reset to (1, 0, 0)', () => {
    render(
      <ZoomablePhotoModal
        visible
        photo={{ id: 'blur-1', uri: 'file:///blur-1.jpg' }}
        onClose={jest.fn()}
      />,
    );

    fireEvent(screen.getByTestId('zoomable-image-viewport'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 700 } },
    });

    // Zoom in to 2.5x and pan to an off-center offset.
    act(() => {
      mockHandlers.pinchStart({ focalX: 200, focalY: 350 });
      mockHandlers.pinchUpdate({ scale: 2.5 });
      mockHandlers.pinchEnd();
    });

    const manager = { activate: jest.fn(), fail: jest.fn() };
    // Tiny 2px finger jitter during a double-tap must NOT activate pan.
    act(() => {
      mockHandlers.panTouchesDown({ numberOfTouches: 1, allTouches: [{ absoluteX: 200, absoluteY: 350 }] }, manager);
      mockHandlers.panTouchesMove({ numberOfTouches: 1, allTouches: [{ absoluteX: 201, absoluteY: 351 }] }, manager);
    });
    expect(manager.activate).not.toHaveBeenCalled();

    // Real drag (>= 8px) activates pan smoothly.
    act(() => {
      mockHandlers.panTouchesMove({ numberOfTouches: 1, allTouches: [{ absoluteX: 212, absoluteY: 350 }] }, manager);
    });
    expect(manager.activate).toHaveBeenCalledTimes(1);

    // Even if pan activated and doubleTap.onEnd fires right before pan.onEnd on the same frame,
    // pan.onEnd MUST NOT overwrite the reset-to-(1, 0, 0) timing animation!
    act(() => {
      mockHandlers.panStart();
      mockHandlers.panUpdate({ translationX: 120, translationY: 80 });
      mockTimingWrites.length = 0;
      mockHandlers.doubleTapEnd({ x: 200, y: 350 }, true);
      mockHandlers.panEnd();
    });

    // Only doubleTap's (scale=1, translateX=0, translateY=0) writes should occur; pan.onEnd is a no-op.
    expect(mockTimingWrites.map(entry => entry.value)).toEqual([1, 0, 0]);
  });

  it('P2: renders high-contrast dark PhotoReadFeedback on dark modal backdrop even when app theme is light', () => {
    mockThemeColors = COLORS; // Light app theme!
    mockPreviewState = {
      uri: '',
      loading: false,
      failed: true,
      attempt: 0,
      onError: jest.fn(),
      retry: jest.fn(),
    };

    render(
      <ZoomablePhotoModal
        visible
        photo={{ id: 'broken-1', uri: 'file:///broken-1.jpg' }}
        onClose={jest.fn()}
      />,
    );

    const alertText = screen.getByRole('alert');
    const retryBtn = screen.getByRole('button', { name: 'retry' });
    expect(StyleSheet.flatten(alertText.props.style).color).toBe(COLORS_DARK.textSecondary);
    expect(StyleSheet.flatten(retryBtn.props.style).backgroundColor).toBe(COLORS_DARK.actionBackground);
  });
});
