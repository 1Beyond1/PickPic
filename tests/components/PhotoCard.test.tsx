import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

const mockGestureHandlers: Record<string, (...args: any[]) => void> = {};
const mockSizes: Array<(width: number, height: number) => void> = [];
const mockSizeFailures: Array<(error: Error) => void> = [];
let mockReducedMotion = false;
let mockAnimationFinished = true;

jest.mock('expo-image', () => ({
  Image: (props: object) => {
    const identity = require('react').useRef({}).current;
    return require('react').createElement(require('react-native').View, { ...props, testID: 'card-image', nativeIdentity: identity });
  },
}));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: { background: '#111212', surface: '#1D1E1E', border: '#2B2D2B' } }) }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useSharedValue: (value: number) => require('react').useRef({ value }).current,
  useAnimatedStyle: (callback: () => unknown) => callback(),
  withTiming: (value: number, _options?: unknown, callback?: (finished: boolean) => void) => {
    callback?.(mockAnimationFinished);
    return value;
  },
  withSpring: jest.fn((value: number) => value),
  useReducedMotion: () => mockReducedMotion,
  runOnJS: (callback: unknown) => callback,
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' },
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  Gesture: {
    Pan: () => {
      const pan = {
        enabled: () => pan,
        onUpdate: (handler: (...args: any[]) => void) => { mockGestureHandlers.update = handler; return pan; },
        onEnd: (handler: (...args: any[]) => void) => { mockGestureHandlers.end = handler; return pan; },
        onFinalize: (handler: (...args: any[]) => void) => { mockGestureHandlers.finalize = handler; return pan; },
      };
      return pan;
    },
    Tap: () => {
      const tap = { enabled: () => tap, onEnd: (handler: (...args: any[]) => void) => { mockGestureHandlers.tap = handler; return tap; } };
      return tap;
    },
    Race: () => ({}),
  },
}));

import { PhotoCard } from '../../components/PhotoCard';
import { withSpring } from 'react-native-reanimated';

const callbacks = { onSwipeUp: jest.fn(), onSwipeDown: jest.fn(), onTap: jest.fn() };
const props = {
  photo: { id: 'photo', uri: 'file:///photo.jpg', filename: 'photo.jpg', creationTime: 1 } as any,
  index: 0, total: 2, enableCollections: false, dropZones: [], maxWidth: 280, maxHeight: 360, ...callbacks,
};

function swipe(y: number) {
  const event = { translationX: 0, translationY: y, absoluteX: 100, absoluteY: 300 };
  act(() => {
    mockGestureHandlers.update(event);
    mockGestureHandlers.end(event, true);
  });
}

function cardStyle() {
  // These existing aspect/fit assertions describe the image, not the new
  // opaque shared frame that hides the following photo's different shape.
  return StyleSheet.flatten(screen.getByTestId('photo-card-image-frame').props.style);
}

describe('PhotoCard decisions and fitting', () => {
  beforeEach(() => {
    mockReducedMotion = false;
    mockAnimationFinished = true;
    jest.clearAllMocks();
    mockSizes.length = 0;
    mockSizeFailures.length = 0;
    callbacks.onSwipeDown.mockResolvedValue(true);
    jest.spyOn(require('react-native').Image, 'getSize').mockImplementation((_uri: unknown, success: any, failure: any) => {
      mockSizes.push(success);
      mockSizeFailures.push(failure);
      return Promise.resolve({ width: 400, height: 400 });
    });
  });

  it('covers the shared viewport so a following portrait cannot peek around a landscape', () => {
    render(<PhotoCard {...props} />);
    act(() => mockSizes[0](1600, 400));
    const frame = screen.UNSAFE_getAllByType(View).find(node => StyleSheet.flatten(node.props.style)?.position === 'absolute')!;
    const style = StyleSheet.flatten(frame.props.style);
    expect(style.width).toBe(280);
    expect(style.height).toBe(360);
    expect(style.backgroundColor).toBeTruthy();
  });

  it('does not turn a failed or interrupted gesture into a media decision', () => {
    render(<PhotoCard {...props} />);
    act(() => {
      mockGestureHandlers.update({ translationX: 0, translationY: -150, absoluteX: 100, absoluteY: 300 });
      mockGestureHandlers.end({}, false);
      mockGestureHandlers.tap({}, false);
    });
    expect(callbacks.onSwipeUp).not.toHaveBeenCalled();
    expect(callbacks.onSwipeDown).not.toHaveBeenCalled();
    expect(callbacks.onTap).not.toHaveBeenCalled();
  });

  it('does not commit a decision when the exit animation is cancelled', () => {
    mockAnimationFinished = false;
    render(<PhotoCard {...props} />);
    swipe(-150);
    expect(callbacks.onSwipeUp).not.toHaveBeenCalled();
  });

  it('opens the current photo for accessibility and hides the following photo', () => {
    const view = render(<PhotoCard {...props} />);
    const button = screen.getByRole('button', { name: 'photo_detail_title' });
    act(() => button.props.onAccessibilityTap());
    expect(callbacks.onTap).toHaveBeenCalledTimes(1);
    view.rerender(<PhotoCard {...props} index={1} />);
    expect(screen.queryByRole('button', { name: 'photo_detail_title' })).toBeNull();
  });

  it('honors reduced motion without suppressing an explicit completed decision', () => {
    mockReducedMotion = true;
    render(<PhotoCard {...props} />);
    expect(screen.getByTestId('card-image').props.transition).toBe(0);
    swipe(-150);
    expect(callbacks.onSwipeUp).toHaveBeenCalledTimes(1);
    expect(withSpring).not.toHaveBeenCalled();
  });

  it('opens a preview without organizing the photo', () => {
    render(<PhotoCard {...props} />);
    act(() => mockGestureHandlers.tap({}, true));
    expect(callbacks.onTap).toHaveBeenCalledTimes(1);
    expect(callbacks.onSwipeUp).not.toHaveBeenCalled();
    expect(callbacks.onSwipeDown).not.toHaveBeenCalled();
  });

  it('does not organize a released short drag', () => {
    render(<PhotoCard {...props} />);
    swipe(80);
    expect(callbacks.onSwipeUp).not.toHaveBeenCalled();
    expect(callbacks.onSwipeDown).not.toHaveBeenCalled();
  });

  it('queues only a released upward decision beyond the existing threshold', () => {
    render(<PhotoCard {...props} />);
    swipe(-150);
    expect(callbacks.onSwipeUp).toHaveBeenCalledTimes(1);
    expect(callbacks.onSwipeDown).not.toHaveBeenCalled();
  });

  it('keeps a released downward decision and restores the card if collection fails', async () => {
    callbacks.onSwipeDown.mockResolvedValue(false);
    render(<PhotoCard {...props} />);
    swipe(150);
    await waitFor(() => expect(callbacks.onSwipeDown).toHaveBeenCalledWith(undefined));
    await waitFor(() => expect(withSpring).toHaveBeenCalledWith(1));
    expect(callbacks.onSwipeUp).not.toHaveBeenCalled();
  });

  it('uses complete image containment', () => {
    render(<PhotoCard {...props} />);
    expect(screen.getByTestId('card-image').props.contentFit).toBe('contain');
    act(() => mockSizes[0](1080, 2424));
    expect(cardStyle().height).toBeGreaterThan(cardStyle().width);
  });

  it('keeps cached deck images out of overlapping native crossfades while dimensions settle', () => {
    const view = render(<PhotoCard {...props} />);
    const original = screen.getByTestId('card-image').props.nativeIdentity;
    act(() => mockSizes[0](1600, 900));
    view.rerender(<PhotoCard {...props} maxWidth={240} maxHeight={300} />);
    expect(screen.getByTestId('card-image').props.nativeIdentity).toBe(original);
    expect(screen.getByTestId('card-image').props.transition).toBe(0);
    expect(screen.getByTestId('card-image').props.cachePolicy).toBe('memory');
    expect(callbacks.onSwipeUp).not.toHaveBeenCalled();
    expect(callbacks.onSwipeDown).not.toHaveBeenCalled();
  });

  it('keeps the same image host on promotion but separates different media sources', () => {
    const view = render(<PhotoCard {...props} index={1} />);
    const original = screen.getByTestId('card-image', { includeHiddenElements: true }).props.nativeIdentity;
    view.rerender(<PhotoCard {...props} index={0} />);
    expect(screen.getByTestId('card-image').props.nativeIdentity).toBe(original);
    view.rerender(<PhotoCard {...props} photo={{ ...props.photo, id: 'other', uri: 'file:///other.jpg' }} />);
    expect(screen.getByTestId('card-image').props.nativeIdentity).not.toBe(original);
    expect(callbacks.onSwipeUp).not.toHaveBeenCalled();
    expect(callbacks.onSwipeDown).not.toHaveBeenCalled();
  });

  it('fits a portrait inside the actual deck viewport rather than the whole window', () => {
    render(<PhotoCard {...props} />);
    act(() => mockSizes[0](1080, 2424));
    expect(cardStyle().height).toBeLessThanOrEqual(360);
    expect(cardStyle().width).toBeLessThanOrEqual(280);
  });

  it('refits immediately after the deck shrinks without rereading image dimensions or making a decision', () => {
    const view = render(<PhotoCard {...props} />);
    act(() => mockSizes[0](1080, 2424));
    view.rerender(<PhotoCard {...props} maxWidth={240} maxHeight={200} />);
    expect(cardStyle().height).toBeCloseTo(200);
    expect(cardStyle().width).toBeCloseTo(200 * 1080 / 2424);
    expect(mockSizes).toHaveLength(1);
    expect(callbacks.onSwipeUp).not.toHaveBeenCalled();
    expect(callbacks.onSwipeDown).not.toHaveBeenCalled();
  });

  it('fits wide media by width without stretching the aspect ratio', () => {
    render(<PhotoCard {...props} />);
    act(() => mockSizes[0](1600, 400));
    expect(cardStyle().width).toBe(280);
    expect(cardStyle().height).toBe(70);
  });

  it('ignores an old URI size callback after the displayed source changes', () => {
    const view = render(<PhotoCard {...props} />);
    view.rerender(<PhotoCard {...props} photo={{ ...props.photo, uri: 'file:///new.jpg' }} />);
    act(() => mockSizes[1](400, 800));
    const fitted = cardStyle();
    act(() => mockSizes[0](1600, 400));
    expect(cardStyle().width).toBe(fitted.width);
    expect(cardStyle().height).toBe(fitted.height);
  });

  it('keeps a bounded fallback when dimensions cannot be read', () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    render(<PhotoCard {...props} maxHeight={180} />);
    act(() => mockSizeFailures[0](new Error('Unavailable image')));
    expect(cardStyle().width).toBe(180);
    expect(cardStyle().height).toBe(180);
  });

  it('does not adopt invalid image dimensions', () => {
    render(<PhotoCard {...props} />);
    act(() => mockSizes[0](400, 0));
    expect(Number.isFinite(cardStyle().height)).toBe(true);
    expect(cardStyle().height).toBeLessThanOrEqual(360);
  });
});
