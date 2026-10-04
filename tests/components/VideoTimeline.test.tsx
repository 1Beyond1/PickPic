import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { VideoTimeline } from '../../components/VideoTimeline';

let handlers: Record<string, (event: any) => void>;
let removed: jest.Mock[];
let player: any;
const onScrubbingChange = jest.fn();
const props = { sourceKey: 'video-a', active: true, colors: {}, t: (key: string) => key, onScrubbingChange };
beforeEach(() => {
    handlers = {}; removed = [];
    player = { duration: 0, currentTime: 0, timeUpdateEventInterval: 0,
        addListener: jest.fn((event: string, listener: (event: any) => void) => {
            handlers[event] = listener;
            const remove = jest.fn(); removed.push(remove); return { remove };
        }),
    };
    onScrubbingChange.mockClear();
});
const event = (x: number) => ({ nativeEvent: { locationX: x } });
function ready() {
    player.duration = 120;
    act(() => handlers.sourceLoad({ duration: 120 }));
    fireEvent(screen.getByTestId('video-timeline'), 'layout', { nativeEvent: { layout: { width: 200 } } });
}

it('does not invent duration or allow seeking until native duration is available', () => {
    render(<VideoTimeline {...props} player={player} />);
    const bar = screen.getByRole('adjustable', { name: 'video_seek' });
    expect(bar).toBeDisabled();
    expect(screen.getByText('video_duration_unknown')).toBeTruthy();
    expect(bar.props.onStartShouldSetResponder()).toBe(false);
    fireEvent(bar, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(player.currentTime).toBe(0);
});
it('previews drag time, ignores playback ticks during drag and commits only on release', () => {
    render(<VideoTimeline {...props} player={player} />); ready();
    const bar = screen.getByTestId('video-timeline');
    expect(bar.props.onStartShouldSetResponder()).toBe(true);
    fireEvent(bar, 'responderGrant', event(50));
    fireEvent(bar, 'responderMove', event(100));
    expect(onScrubbingChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('1:00 / 2:00')).toBeTruthy();
    expect(player.currentTime).toBe(0);
    act(() => handlers.timeUpdate({ currentTime: 3 }));
    expect(screen.getByText('1:00 / 2:00')).toBeTruthy();
    fireEvent(bar, 'responderRelease', event(150));
    expect(player.currentTime).toBe(90);
    expect(onScrubbingChange).toHaveBeenLastCalledWith(false);
    act(() => handlers.timeUpdate({ currentTime: 92 }));
    expect(screen.getByText('1:32 / 2:00')).toBeTruthy();
});
it('clamps boundary seeks and supports ten-second accessibility adjustments', () => {
    render(<VideoTimeline {...props} player={player} />); ready();
    const bar = screen.getByTestId('video-timeline');
    fireEvent(bar, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(player.currentTime).toBe(10);
    fireEvent(bar, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(player.currentTime).toBe(0);
    fireEvent(bar, 'responderGrant', event(500));
    fireEvent(bar, 'responderRelease', event(500));
    expect(player.currentTime).toBe(120);
});
it('cancels an interrupted scrub and releases the paging lock without seeking', () => {
    render(<VideoTimeline {...props} player={player} />); ready();
    const bar = screen.getByTestId('video-timeline');
    fireEvent(bar, 'responderGrant', event(100));
    fireEvent(bar, 'responderTerminate');
    expect(player.currentTime).toBe(0);
    expect(screen.getByText('0:00 / 2:00')).toBeTruthy();
    expect(onScrubbingChange).toHaveBeenLastCalledWith(false);
});
it('disables offscreen progress events and rejects late callbacks from an old source', () => {
    const view = render(<VideoTimeline {...props} player={player} />); ready();
    const oldUpdate = handlers.timeUpdate;
    const oldSource = handlers.sourceLoad;
    player.duration = 0; player.currentTime = 0;
    view.rerender(<VideoTimeline {...props} sourceKey="video-b" active={false} player={player} />);
    expect(removed.slice(0, 2).every(remove => remove.mock.calls.length === 1)).toBe(true);
    expect(player.timeUpdateEventInterval).toBe(0);
    act(() => { oldUpdate({ currentTime: 90 }); oldSource({ duration: 120 }); });
    expect(screen.getByText('video_duration_unknown')).toBeTruthy();
    expect(screen.getByTestId('video-timeline')).toBeDisabled();
});
it('reports seek failure without leaving the playback/paging lock held', () => {
    render(<VideoTimeline {...props} player={player} />); ready();
    Object.defineProperty(player, 'currentTime', { get: () => 0, set: () => { throw new Error('Native seek failed'); } });
    const bar = screen.getByTestId('video-timeline');
    fireEvent(bar, 'responderGrant', event(100));
    fireEvent(bar, 'responderRelease', event(100));
    expect(screen.getByText('video_seek_failed')).toBeTruthy();
    expect(screen.getByTestId('video-timeline').props.accessibilityValue.now).toBe(0);
    expect(onScrubbingChange).toHaveBeenLastCalledWith(false);
});
