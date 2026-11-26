import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import type { VideoPlayer } from 'expo-video';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';

const validDuration = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
const clampTime = (value: number, duration: number) => Number.isFinite(value) ? Math.max(0, Math.min(duration, value)) : 0;
function formatTime(value: number) {
    const seconds = Math.max(0, Math.floor(value));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function readPlayerDuration(player: VideoPlayer): number {
    try {
        return validDuration(player.duration);
    } catch {
        return 0;
    }
}

function readPlayerCurrentTime(player: VideoPlayer, duration: number): number {
    try {
        return clampTime(player.currentTime, duration);
    } catch {
        return 0;
    }
}

/** Playback only: moving this control never makes an organizing decision. */
export function VideoTimeline({ player, sourceKey, active, colors, t, onScrubbingChange }: {
    player: VideoPlayer; sourceKey: string; active: boolean; colors: any; t: (key: string) => string;
    onScrubbingChange: (scrubbing: boolean) => void;
}) {
    const [progress, setProgress] = useState({ sourceKey, duration: 0, time: 0 });
    const [failed, setFailed] = useState(false);
    const width = useRef(0);
    const scrubbing = useRef(false);
    const target = useRef(0);
    const callback = useRef(onScrubbingChange);
    callback.current = onScrubbingChange;
    const duration = progress.sourceKey === sourceKey ? progress.duration : 0;
    const time = progress.sourceKey === sourceKey ? progress.time : 0;
    const canSeek = active && duration > 0;

    useEffect(() => {
        let current = true;
        scrubbing.current = false;
        callback.current(false);
        setFailed(false);

        const initialDuration = readPlayerDuration(player);
        const initialTime = readPlayerCurrentTime(player, initialDuration);
        setProgress({ sourceKey, duration: initialDuration, time: initialTime });

        let sourceSub: { remove: () => void } | null = null;
        let updateSub: { remove: () => void } | null = null;
        try {
            player.timeUpdateEventInterval = active ? 0.25 : 0;
            sourceSub = player.addListener('sourceLoad', event => {
                if (!current) return;
                const nextDuration = validDuration(event.duration);
                setProgress({
                    sourceKey,
                    duration: nextDuration,
                    time: readPlayerCurrentTime(player, nextDuration),
                });
            });
            updateSub = player.addListener('timeUpdate', event => {
                if (!current || scrubbing.current) return;
                setProgress(previous => {
                    const length = readPlayerDuration(player) || previous.duration;
                    return {
                        sourceKey,
                        duration: length,
                        time: clampTime(event.currentTime, length || previous.duration),
                    };
                });
            });
        } catch {
            // Native SharedObject may already be releasing during fast-swipe unmount.
        }

        return () => {
            current = false;
            try { sourceSub?.remove(); } catch { /* ignore released listener */ }
            try { updateSub?.remove(); } catch { /* ignore released listener */ }
            scrubbing.current = false;
            callback.current(false);
        };
    }, [player, sourceKey, active]);

    const preview = (event: GestureResponderEvent) => {
        if (!canSeek || width.current <= 0) return;
        target.current = clampTime(event.nativeEvent.locationX / width.current * duration, duration);
        setProgress({ sourceKey, duration, time: target.current });
    };
    const seek = (requested: number) => {
        if (!canSeek) return;
        try {
            const next = clampTime(requested, duration);
            player.currentTime = next;
            setProgress({ sourceKey, duration, time: next });
            setFailed(false);
        } catch {
            // A rejected seek must not leave the preview target presented as
            // the actual playback position, including to accessibility APIs.
            const actual = readPlayerCurrentTime(player, duration);
            setProgress({ sourceKey, duration, time: actual });
            setFailed(true);
        }
    };
    const endScrub = () => { scrubbing.current = false; callback.current(false); };
    const cancelScrub = () => {
        const actual = readPlayerCurrentTime(player, duration);
        setProgress({ sourceKey, duration, time: actual });
        endScrub();
    };

    return <View style={styles.container}>
        <View testID="video-timeline" accessible accessibilityRole="adjustable" accessibilityLabel={t('video_seek')}
            accessibilityHint={t('video_seek_hint')} accessibilityState={{ disabled: !canSeek }}
            accessibilityValue={{ min: 0, max: duration || 1, now: time, text: duration ? `${formatTime(time)} / ${formatTime(duration)}` : t('video_duration_unknown') }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={event => {
                if (event.nativeEvent.actionName === 'increment') seek(time + 10);
                if (event.nativeEvent.actionName === 'decrement') seek(time - 10);
            }}
            style={styles.touchArea} onLayout={event => { width.current = event.nativeEvent.layout.width; }}
            onStartShouldSetResponder={() => canSeek} onMoveShouldSetResponder={() => canSeek}
            onResponderTerminationRequest={() => false}
            onResponderGrant={event => { scrubbing.current = true; callback.current(true); preview(event); }}
            onResponderMove={preview}
            onResponderRelease={event => { preview(event); seek(target.current); endScrub(); }}
            onResponderTerminate={cancelScrub}>
            <View pointerEvents="none" style={[styles.track, { backgroundColor: colors.divider }]}>
                <View style={[styles.fill, { backgroundColor: colors.text, width: `${duration ? Math.min(100, time / duration * 100) : 0}%` }]} />
            </View>
        </View>
        <Text accessibilityRole={failed ? 'alert' : undefined} style={[styles.time, { color: failed ? colors.danger : colors.textSecondary }]}>
            {failed ? t('video_seek_failed') : duration ? `${formatTime(time)} / ${formatTime(duration)}` : t('video_duration_unknown')}
        </Text>
    </View>;
}

const styles = StyleSheet.create({
    container: { paddingHorizontal: UI_METRICS.pageInset },
    touchArea: { minHeight: UI_METRICS.touchTarget, justifyContent: 'center' },
    track: { height: 3, borderRadius: 2, overflow: 'hidden' },
    fill: { height: '100%' },
    time: { ...TYPOGRAPHY.caption, fontVariant: ['tabular-nums'], textAlign: 'right' },
});
