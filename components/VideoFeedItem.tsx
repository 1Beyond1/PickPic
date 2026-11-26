import { Ionicons } from '@expo/vector-icons';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    useWindowDimensions,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';
import { COLORS } from '../constants/theme';
import { PhotoAsset } from '../stores/useMediaStore';
import { VideoTimeline } from './VideoTimeline';

function readSafeCurrentTime(player: { currentTime: number }): number {
    try {
        const value = player.currentTime;
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
        return 0;
    }
}

interface AndroidFullscreenVideoProps {
    uri: string;
    initialTime: number;
    isMuted: boolean;
    t: (key: string) => string;
    onRequestClose: (currentTime: number) => void;
}

/**
 * expo-video's Android exitFullscreen method is not implemented in SDK 54.
 * Keep Android fullscreen in a separate React Native modal while unmounting
 * the underlying feed player so hardware decoders stay within bounds, and
 * carry playback position across enter/exit transitions.
 */
const AndroidFullscreenVideo: React.FC<AndroidFullscreenVideoProps> = ({
    uri,
    initialTime,
    isMuted,
    t,
    onRequestClose,
}) => {
    const insets = useSafeAreaInsets();
    const reducedMotion = useReducedMotion();
    const player = useVideoPlayer(uri, (videoPlayer) => {
        try {
            videoPlayer.loop = true;
            videoPlayer.muted = isMuted;
            if (initialTime > 0) {
                videoPlayer.currentTime = initialTime;
            }
            videoPlayer.play();
        } catch {
            console.warn('[VideoFeedItem] Failed to initialize fullscreen video player.');
        }
    });

    useEffect(() => {
        try {
            player.muted = isMuted;
        } catch {
            console.warn('[VideoFeedItem] Failed to sync fullscreen mute state.');
        }
    }, [isMuted, player]);

    const handleClose = useCallback(() => {
        const exitTime = readSafeCurrentTime(player);
        try {
            player.pause();
        } catch {
            // Player may already be tearing down during modal close.
        }
        onRequestClose(exitTime);
    }, [onRequestClose, player]);

    return (
        <Modal
            visible
            animationType={reducedMotion ? 'none' : 'fade'}
            presentationStyle="fullScreen"
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={handleClose}
        >
            <View style={styles.fullscreenContainer}>
                <VideoView
                    style={styles.fullscreenVideo}
                    player={player}
                    contentFit="contain"
                    nativeControls={false}
                    surfaceType="textureView"
                    fullscreenOptions={{ enable: false }}
                />
                <Pressable
                    style={[styles.fullscreenCloseButton, { top: insets.top + 12 }]}
                    onPress={handleClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('cancel')}
                >
                    <Ionicons name="close" size={28} color={COLORS.white} />
                </Pressable>
            </View>
        </Modal>
    );
};

interface ActiveVideoPlayerHandle {
    enterFullscreen: () => Promise<void>;
    exitFullscreen: () => Promise<void>;
    getCurrentTime: () => number;
    pauseSafely: () => void;
}

interface ActiveVideoPlayerProps {
    videoId: string;
    uri: string;
    initialTime: number;
    isActive: boolean;
    isScreenFocused: boolean;
    isFullscreen: boolean;
    baseShouldPlay: boolean;
    isMuted: boolean;
    isPaused: boolean;
    compact: boolean;
    colors: any;
    t: any;
    onTogglePause: () => void;
    onLongPress: () => void;
    onFullscreenEnter: () => void;
    onFullscreenExit: () => void;
    onScrubbingChange: (scrubbing: boolean) => void;
}

/**
 * Isolated native video player mounted ONLY while this card is inside the
 * active decoder window (and not masked by Android's fullscreen modal).
 * Unmounting outside the window avoids allocating empty ExoPlayer instances
 * via `useVideoPlayer(null)` and prevents offscreen VideoTimeline effects
 * from invoking synchronous Kotlin `runBlocking` getters on the main queue.
 */
const ActiveVideoPlayer = forwardRef<ActiveVideoPlayerHandle, ActiveVideoPlayerProps>(
    function ActiveVideoPlayer(
        {
            videoId,
            uri,
            initialTime,
            isActive,
            isScreenFocused,
            isFullscreen,
            baseShouldPlay,
            isMuted,
            isPaused,
            compact,
            colors,
            t,
            onTogglePause,
            onLongPress,
            onFullscreenEnter,
            onFullscreenExit,
            onScrubbingChange,
        },
        ref,
    ) {
        const videoRef = useRef<VideoView>(null);
        const player = useVideoPlayer(uri, (videoPlayer) => {
            try {
                videoPlayer.loop = true;
                videoPlayer.muted = isMuted;
                if (initialTime > 0) {
                    videoPlayer.currentTime = initialTime;
                }
            } catch {
                console.warn('[VideoFeedItem] Failed to initialize video player.');
            }
        });

        useImperativeHandle(ref, () => ({
            enterFullscreen: async () => {
                await videoRef.current?.enterFullscreen();
            },
            exitFullscreen: async () => {
                await videoRef.current?.exitFullscreen();
            },
            getCurrentTime: () => readSafeCurrentTime(player),
            pauseSafely: () => {
                try {
                    player.pause();
                } catch {
                    // Ignore transient failure if SharedObject is releasing.
                }
            },
        }), [player]);

        useEffect(() => {
            try {
                player.muted = isMuted;
            } catch {
                console.warn('[VideoFeedItem] Failed to sync mute state.');
            }
        }, [isMuted, player]);

        useEffect(() => {
            try {
                if (baseShouldPlay) {
                    player.play();
                } else {
                    player.pause();
                }
            } catch {
                // The player can reject while a feed item is being recycled or
                // unloaded. Keep that transient failure from escaping the effect.
                console.warn('[VideoFeedItem] Failed to sync playback state.');
            }
        }, [baseShouldPlay, player]);

        return (
            <>
                <Pressable
                    onLongPress={onLongPress}
                    style={[styles.videoWrapper, compact && styles.compactVideoWrapper, { backgroundColor: colors.background }]}
                    accessibilityRole="button"
                    accessibilityLabel={t(isPaused ? 'video_resume' : 'video_pause')}
                    accessibilityHint={t('video_player_hint')}
                    onPress={onTogglePause}
                >
                    <VideoView
                        ref={videoRef}
                        style={styles.video}
                        player={player}
                        contentFit="contain"
                        nativeControls={false}
                        playsInline
                        surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
                        // expo-video 3.0.16's Web implementation checks the
                        // deprecated prop inside enterFullscreen even when
                        // fullscreenOptions.enable is true. Keep the bridge
                        // prop on Web only until that implementation is fixed.
                        allowsFullscreen={Platform.OS === 'web' ? true : undefined}
                        fullscreenOptions={{ enable: true }}
                        onFullscreenEnter={onFullscreenEnter}
                        onFullscreenExit={onFullscreenExit}
                    />
                    {isPaused && (
                        <View pointerEvents="none" style={styles.pauseOverlay}>
                            <View style={styles.pauseIcon}>
                                <Ionicons name="play" size={32} color={COLORS.white} />
                            </View>
                        </View>
                    )}
                </Pressable>
                <View style={styles.timeline}>
                    <VideoTimeline
                        player={player}
                        sourceKey={`${videoId}:${uri}`}
                        active={isActive && isScreenFocused && !isFullscreen}
                        colors={colors}
                        t={t}
                        onScrubbingChange={onScrubbingChange}
                    />
                </View>
            </>
        );
    },
);

interface VideoFeedItemProps {
    video: PhotoAsset;
    isActive: boolean;
    shouldLoadSource?: boolean;
    isScreenFocused: boolean;
    shouldPlay: boolean;
    isMuted: boolean;
    toggleMute: () => void;
    onDelete: (video: PhotoAsset) => void;
    onFavorite: (video: PhotoAsset) => void;
    t: any;
    colors: any;
    itemHeight: number;
    onScrubbingChange?: (scrubbing: boolean) => void;
}

const VideoFeedItemComponent: React.FC<VideoFeedItemProps> = ({
    video,
    isActive,
    shouldLoadSource = true,
    isScreenFocused,
    shouldPlay,
    isMuted,
    toggleMute,
    onDelete,
    onFavorite,
    t,
    colors,
    itemHeight,
    onScrubbingChange,
}) => {
    const { fontScale } = useWindowDimensions();
    const activePlayerRef = useRef<ActiveVideoPlayerHandle>(null);
    const resumeTimeRef = useRef(0);
    const needsLocalUri = /^(ph|assets-library):\/\//.test(video.uri);
    const [isFullscreen, setIsFullscreen] = useState(false);
    // Only keep a native decoder/source bound for the active item and its
    // immediate neighbors while the feed is focused (or finishing fullscreen exit).
    const retainPlaybackSource = shouldLoadSource && (isScreenFocused || isFullscreen);
    const [resolvedLocalSource, setResolvedLocalSource] = useState<{ assetId: string; uri: string } | null>(null);
    const [isPaused, setIsPaused] = useState(false);
    const [isScrubbing, setIsScrubbing] = useState(false);

    const handleScrubbing = useCallback((scrubbing: boolean) => {
        setIsScrubbing(scrubbing);
        onScrubbingChange?.(scrubbing);
    }, [onScrubbingChange]);

    useEffect(() => {
        setIsPaused(false);
        setIsFullscreen(false);
        resumeTimeRef.current = 0;
    }, [video.id]);

    const resolvePlaybackUri = useCallback(async () => {
        if (!needsLocalUri) return video.uri;

        const info = await MediaLibrary.getAssetInfoAsync(video.id);
        return info?.localUri || info?.uri || video.uri;
    }, [needsLocalUri, video.id, video.uri]);

    useEffect(() => {
        let mounted = true;
        if (!retainPlaybackSource || !needsLocalUri) {
            setResolvedLocalSource(null);
            return () => {
                mounted = false;
            };
        }

        setResolvedLocalSource(null);
        void resolvePlaybackUri()
            .then((uri) => {
                if (mounted) {
                    setResolvedLocalSource({ assetId: video.id, uri });
                }
            })
            .catch(() => {
                // Keep the original URI as a last-resort fallback. If the
                // asset is unavailable, expo-video will report the native error
                // instead of allowing the async lookup to become unhandled.
                if (mounted) {
                    console.warn('[VideoFeedItem] Failed to resolve local video URI.');
                    setResolvedLocalSource({ assetId: video.id, uri: video.uri });
                }
            });

        return () => {
            mounted = false;
        };
    }, [needsLocalUri, resolvePlaybackUri, retainPlaybackSource, video.id, video.uri]);

    const playbackUri = !retainPlaybackSource
        ? null
        : !needsLocalUri
            ? video.uri
            : (resolvedLocalSource?.assetId === video.id ? resolvedLocalSource.uri : null);

    // On Android fullscreen, unmount the underlying feed player so hardware
    // decoders stay within bounds instead of doubling up with the modal player.
    const shouldMountFeedPlayer = !!playbackUri && !(Platform.OS === 'android' && isFullscreen);

    const baseShouldPlay = shouldPlay && isActive && retainPlaybackSource && !isPaused && !isScrubbing && !(Platform.OS === 'android' && isFullscreen);

    // Tab screens stay mounted when blurred. Android's modal is closed by
    // changing state; iOS/Web expose an exitFullscreen method on the native
    // view. Android SDK 54 does not implement that method.
    useEffect(() => {
        if (isScreenFocused || !isFullscreen) return;

        if (Platform.OS === 'android') {
            setIsFullscreen(false);
            return;
        }

        if (activePlayerRef.current) {
            void activePlayerRef.current.exitFullscreen().catch(() => {
                console.warn('[VideoFeedItem] Failed to exit fullscreen video.');
            });
        }
    }, [isFullscreen, isScreenFocused]);

    const handleShare = useCallback(async () => {
        try {
            if (await Sharing.isAvailableAsync()) {
                await Sharing.shareAsync(playbackUri || await resolvePlaybackUri());
            }
        } catch {
            console.error('[VideoFeedItem] Failed to share video.');
        }
    }, [playbackUri, resolvePlaybackUri]);

    const handleTogglePause = useCallback(() => {
        setIsPaused(prev => !prev);
    }, []);

    const handleLongPress = useCallback(async () => {
        if (!playbackUri) return;

        try {
            if (Platform.OS === 'android') {
                resumeTimeRef.current = activePlayerRef.current?.getCurrentTime() ?? 0;
                activePlayerRef.current?.pauseSafely();
                setIsFullscreen(true);
                return;
            }

            // On iOS and Web, expo-video presents the same player in the
            // platform fullscreen surface. The callbacks update state only
            // after the platform confirms the transition.
            await activePlayerRef.current?.enterFullscreen();
        } catch {
            setIsFullscreen(false);
            console.error('[VideoFeedItem] Failed to open fullscreen video.');
        }
    }, [playbackUri]);

    const handleFullscreenEnter = useCallback(() => {
        setIsFullscreen(true);
    }, []);

    const handleFullscreenExit = useCallback(() => {
        setIsFullscreen(false);
    }, []);

    const handleAndroidFullscreenClose = useCallback((exitTime: number) => {
        resumeTimeRef.current = Number.isFinite(exitTime) && exitTime > 0 ? exitTime : 0;
        setIsFullscreen(false);
    }, []);

    const handleDeletePress = useCallback(() => {
        onDelete(video);
    }, [onDelete, video]);

    const handleFavoritePress = useCallback(() => {
        onFavorite(video);
    }, [onFavorite, video]);

    const dateString = useMemo(() => {
        const date = new Date(video.creationTime);
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }, [video.creationTime]);
    const duration = Math.max(0, Math.round(video.duration ?? 0));
    const durationString = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
    // Four labeled buttons must fit above metadata, even with large text.
    // The existing compact rail is preferable to clipping the first action.
    const railHeight = 4 * (32 + 12 + 4 + Math.ceil(11 * 1.4 * fontScale)) + 3 * 10;
    const compact = itemHeight < Math.max(360, railHeight + 136 + 8);
    const actions = [
        { icon: isMuted ? 'volume-mute-outline' : 'volume-high-outline', label: t(isMuted ? 'video_muted' : 'video_sound'), onPress: toggleMute },
        { icon: 'star-outline', label: t('video_favorite'), onPress: handleFavoritePress },
        { icon: 'share-outline', label: t('video_share'), onPress: handleShare },
        { icon: 'trash-outline', label: t('video_queue_delete'), onPress: handleDeletePress, destructive: true },
    ] as const;

    return (
        <View style={[styles.container, { backgroundColor: colors.background, height: itemHeight }]}>
            {shouldMountFeedPlayer && playbackUri ? (
                <ActiveVideoPlayer
                    key={`${video.id}:${playbackUri}`}
                    ref={activePlayerRef}
                    videoId={video.id}
                    uri={playbackUri}
                    initialTime={resumeTimeRef.current}
                    isActive={isActive}
                    isScreenFocused={isScreenFocused}
                    isFullscreen={isFullscreen}
                    baseShouldPlay={baseShouldPlay}
                    isMuted={isMuted}
                    isPaused={isPaused}
                    compact={compact}
                    colors={colors}
                    t={t}
                    onTogglePause={handleTogglePause}
                    onLongPress={handleLongPress}
                    onFullscreenEnter={handleFullscreenEnter}
                    onFullscreenExit={handleFullscreenExit}
                    onScrubbingChange={handleScrubbing}
                />
            ) : (
                <Pressable
                    style={[styles.videoWrapper, compact && styles.compactVideoWrapper, { backgroundColor: colors.background }]}
                    accessibilityRole="button"
                    accessibilityLabel={t(isPaused ? 'video_resume' : 'video_pause')}
                    accessibilityHint={t('video_player_hint')}
                    disabled
                >
                    <View style={styles.videoPlaceholder}>
                        {retainPlaybackSource && !isFullscreen && <ActivityIndicator size="large" color={COLORS.white} />}
                    </View>
                </Pressable>
            )}
            <Pressable
                style={styles.fullscreenHint}
                accessibilityRole="button"
                accessibilityLabel={t('video_fullscreen')}
                onPress={handleLongPress}
                disabled={!playbackUri}
            >
                <Ionicons name="expand-outline" size={18} color={colors.textSecondary} />
            </Pressable>

            <View pointerEvents="none" style={styles.metadata}>
                <Text style={[styles.timeText, { color: colors.textSecondary }]}>{dateString}</Text>
                {duration > 0 && <Text style={[styles.timeText, { color: colors.textSecondary }]}>{durationString}</Text>}
            </View>

            <View style={[styles.actions, compact && styles.compactActions]}>
                {actions.map(action => (
                    <Pressable
                        key={action.label}
                        accessibilityRole="button"
                        accessibilityLabel={action.label}
                        accessibilityHint={'destructive' in action ? t('video_queue_delete_hint') : undefined}
                        onPress={action.onPress}
                        style={({ pressed }) => [styles.actionButton, {
                            backgroundColor: pressed ? colors.selectionBackground : 'transparent',
                            opacity: pressed ? 0.7 : 1,
                        }]}
                    >
                        <View style={styles.actionIcon}>
                            <Ionicons name={action.icon} size={26} allowFontScaling={false} color={'destructive' in action ? colors.danger : colors.text} />
                        </View>
                        {!compact && <Text style={[styles.actionText, { color: 'destructive' in action ? colors.danger : colors.textSecondary }]}>{action.label}</Text>}
                    </Pressable>
                ))}
            </View>

            {Platform.OS === 'android' && isFullscreen && playbackUri && (
                <AndroidFullscreenVideo
                    uri={playbackUri}
                    initialTime={resumeTimeRef.current}
                    isMuted={isMuted}
                    t={t}
                    onRequestClose={handleAndroidFullscreenClose}
                />
            )}
        </View>
    );
};

export const VideoFeedItem = memo(VideoFeedItemComponent);

const styles = StyleSheet.create({
    container: {
        width: '100%',
    },
    videoWrapper: {
        flex: 1,
        marginLeft: 16,
        marginRight: 76,
        marginTop: 8,
        marginBottom: 116,
        borderRadius: 12,
        overflow: 'hidden',
    },
    compactVideoWrapper: {
        marginRight: 16,
        // 118 bottom + 64 touch target + 8 separation from the picture.
        marginBottom: 190,
    },
    video: {
        width: '100%',
        height: '100%',
    },
    videoPlaceholder: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    fullscreenContainer: {
        flex: 1,
        backgroundColor: '#000',
        justifyContent: 'center',
    },
    fullscreenVideo: {
        width: '100%',
        height: '100%',
    },
    fullscreenCloseButton: {
        position: 'absolute',
        right: 16,
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.55)',
    },
    metadata: {
        position: 'absolute',
        left: 20,
        bottom: 82,
        right: 124,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    timeText: {
        fontSize: 11,
        flexShrink: 1,
        fontVariant: ['tabular-nums'],
    },
    fullscreenHint: {
        position: 'absolute',
        bottom: 70,
        right: 76,
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pauseOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
    pauseIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' },
    actions: {
        position: 'absolute',
        right: 8,
        bottom: 136,
        gap: 10,
    },
    compactActions: {
        flexDirection: 'row',
        bottom: 118,
        gap: 8,
    },
    actionButton: {
        minWidth: 56,
        minHeight: 64,
        paddingHorizontal: 4,
        paddingVertical: 6,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
    },
    actionIcon: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionText: {
        fontSize: 11,
        fontWeight: '400',
        textAlign: 'center',
    },
    timeline: { position: 'absolute', bottom: 8, left: 0, right: 0 },
});
