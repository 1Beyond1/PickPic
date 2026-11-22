import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal } from 'react-native';

const mockHandlers: Record<string, (...args: any[]) => void> = {};

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 16, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: require('../../constants/theme').COLORS_DARK }) }));
jest.mock('../../hooks/usePhotoPreviewSource', () => ({
  usePhotoPreviewSource: (uri: string) => ({
    uri,
    loading: false,
    failed: false,
    attempt: 0,
    onError: jest.fn(),
    retry: jest.fn(),
  }),
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useSharedValue: (value: any) => require('react').useRef({ value }).current,
  useAnimatedStyle: (cb: () => unknown) => cb(),
  withTiming: (value: any) => value,
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

import { ZoomablePhotoModal } from '../../components/ZoomablePhotoModal';

describe('ZoomablePhotoModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
