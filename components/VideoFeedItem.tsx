import { Ionicons } from '@expo/vector-icons';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { PhotoAsset } from '../stores/useMediaStore';

interface AndroidFullscreenVideoProps {
    uri: string;
    isMuted: boolean;
    t: (key: string) => string;
    onRequestClose: () => void;
}

/**
 * expo-video's Android exitFullscreen method is not implemented in SDK 54.
 * Keep Android fullscreen in a separate React Native modal, as the previous
 * implementation did, while still using expo-video for playback.
 */
const AndroidFullscreenVideo: React.FC<AndroidFullscreenVideoProps> = ({
    uri,
    isMuted,
    t,
    onRequestClose,
}) => {
    const insets = useSafeAreaInsets();
    const player = useVideoPlayer(uri, (videoPlayer) => {
        videoPlayer.loop = true;
        videoPlayer.muted = isMuted;
        videoPlayer.play();
    });

    useEffect(() => {
        player.muted = isMuted;
    }, [isMuted, player]);

    return (
        <Modal
            visible
            animationType="fade"
            presentationStyle="fullScreen"
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={onRequestClose}
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
                    onPress={onRequestClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('cancel')}
                >
                    <Ionicons name="close" size={28} color={COLORS.white} />
                </Pressable>
            </View>
        </Modal>
    );
};

interface VideoFeedItemProps {
    video: PhotoAsset;
    isActive: boolean;
    isScreenFocused: boolean;
    shouldPlay: boolean;
    isMuted: boolean;
    toggleMute: () => void;
    onDelete: () => void;
    onFavorite: () => void;
    t: any;
    colors: any;
    itemHeight: number;
}

export const VideoFeedItem: React.FC<VideoFeedItemProps> = ({
    video,
    isActive,
    isScreenFocused,
    shouldPlay,
    isMuted,
    toggleMute,
    onDelete,
    onFavorite,
    t,
    colors,
    itemHeight
}) => {
    const videoRef = useRef<VideoView>(null);
    const needsLocalUri = /^(ph|assets-library):\/\//.test(video.uri);
    const [playbackSource, setPlaybackSource] = useState<{ assetId: string; uri: string } | null>(() => (
        needsLocalUri ? null : { assetId: video.id, uri: video.uri }
    ));
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    useEffect(() => {
        setIsPaused(false);
    }, [video.id]);
    const player = useVideoPlayer(playbackSource?.uri ?? null, (videoPlayer) => {
        videoPlayer.loop = true;
        videoPlayer.muted = isMuted;
    });

    const resolvePlaybackUri = useCallback(async () => {
        if (!needsLocalUri) return video.uri;

        const info = await MediaLibrary.getAssetInfoAsync(video.id);
        return info?.localUri || info?.uri || video.uri;
    }, [needsLocalUri, video.id, video.uri]);

    useEffect(() => {
        let mounted = true;
        setPlaybackSource(needsLocalUri ? null : { assetId: video.id, uri: video.uri });

        if (!needsLocalUri) {
            return () => {
                mounted = false;
            };
        }

        void resolvePlaybackUri()
            .then((uri) => {
                if (mounted) {
                    setPlaybackSource({ assetId: video.id, uri });
                }
            })
            .catch((error) => {
                // Keep the original URI as a last-resort fallback. If the
                // asset is unavailable, expo-video will report the native error
                // instead of allowing the async lookup to become unhandled.
                if (mounted) {
                    console.warn('[VideoFeedItem] Failed to resolve local video URI:', error);
                    setPlaybackSource({ assetId: video.id, uri: video.uri });
                }
            });

        return () => {
            mounted = false;
        };
    }, [needsLocalUri, resolvePlaybackUri, video.id, video.uri]);

    const playbackUri = playbackSource?.assetId === video.id ? playbackSource.uri : null;
    // Android uses a second player inside the custom fullscreen modal, so the
    // feed player must pause there. iOS and Web fullscreen reuse this player;
    // keep it playing while the native/browser fullscreen surface is visible.
    const baseShouldPlay = shouldPlay && isActive && !isPaused && !(Platform.OS === 'android' && isFullscreen);

    useEffect(() => {
        player.muted = isMuted;
    }, [isMuted, player]);

    // Tab screens stay mounted when blurred. Android's modal is closed by
    // changing state; iOS/Web expose an exitFullscreen method on the native
    // view. Android SDK 54 does not implement that method.
    useEffect(() => {
        if (isScreenFocused || !isFullscreen) return;

        if (Platform.OS === 'android') {
            setIsFullscreen(false);
            return;
        }

        if (videoRef.current) {
            void videoRef.current?.exitFullscreen().catch((error) => {
                console.warn('[VideoFeedItem] Failed to exit fullscreen video:', error);
            });
        }
    }, [isFullscreen, isScreenFocused]);

    useEffect(() => {
        try {
            if (baseShouldPlay) {
                player.play();
            } else {
                player.pause();
            }
        } catch (error) {
            // The player can reject while a feed item is being recycled or
            // unloaded. Keep that transient failure from escaping the effect.
            console.warn('[VideoFeedItem] Failed to sync playback state:', error);
        }
    }, [baseShouldPlay, player, playbackUri]);

    const handleShare = async () => {
        try {
            if (await Sharing.isAvailableAsync()) {
                await Sharing.shareAsync(playbackUri || await resolvePlaybackUri());
            }
        } catch (error) {
            console.error('[VideoFeedItem] Failed to share video:', error);
        }
    };

    const handleLongPress = async () => {
        if (!playbackUri) return;

        try {
            if (Platform.OS === 'android') {
                setIsFullscreen(true);
                return;
            }

            // On iOS and Web, expo-video presents the same player in the
            // platform fullscreen surface. The callbacks update state only
            // after the platform confirms the transition.
            await videoRef.current?.enterFullscreen();
        } catch (error) {
            setIsFullscreen(false);
            console.error('[VideoFeedItem] Failed to open fullscreen video:', error);
        }
    };

    const handleFullscreenEnter = useCallback(() => {
        setIsFullscreen(true);
    }, []);

    const handleFullscreenExit = useCallback(() => {
        setIsFullscreen(false);
    }, []);

    const date = new Date(video.creationTime);
    const dateString = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const duration = Math.max(0, Math.round(video.duration ?? 0));
    const durationString = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
    const compact = itemHeight < 360;
    const actions = [
        { icon: isMuted ? 'volume-mute-outline' : 'volume-high-outline', label: t(isMuted ? 'video_muted' : 'video_sound'), onPress: toggleMute },
        { icon: 'star-outline', label: t('video_favorite'), onPress: onFavorite },
        { icon: 'share-outline', label: t('video_share'), onPress: handleShare },
        { icon: 'trash-outline', label: t('video_queue_delete'), onPress: onDelete, destructive: true },
    ] as const;

    return (
        <View style={[styles.container, { backgroundColor: colors.background, height: itemHeight }]}>
            <Pressable
                onLongPress={handleLongPress}
                style={[styles.videoWrapper, compact && styles.compactVideoWrapper, { backgroundColor: colors.background }]}
                accessibilityRole="button"
                accessibilityLabel={t(isPaused ? 'video_resume' : 'video_pause')}
                accessibilityHint={t('video_player_hint')}
                onPress={() => setIsPaused(prev => !prev)}
                disabled={!playbackUri}
            >
                {playbackUri ? (
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
                        onFullscreenEnter={handleFullscreenEnter}
                        onFullscreenExit={handleFullscreenExit}
                    />
                ) : (
                    <View style={styles.videoPlaceholder}>
                        <ActivityIndicator size="large" color={COLORS.white} />
                    </View>
                )}
                {isPaused && <View pointerEvents="none" style={styles.pauseOverlay}>
                    <View style={styles.pauseIcon}><Ionicons name="play" size={32} color={COLORS.white} /></View>
                </View>}
            </Pressable>
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
                            <Ionicons name={action.icon} size={26} color={'destructive' in action ? colors.danger : colors.text} />
                        </View>
                        {!compact && <Text style={[styles.actionText, { color: 'destructive' in action ? colors.danger : colors.textSecondary }]}>{action.label}</Text>}
                    </Pressable>
                ))}
            </View>

            {Platform.OS === 'android' && isFullscreen && playbackUri && (
                <AndroidFullscreenVideo
                    uri={playbackUri}
                    isMuted={isMuted}
                    t={t}
                    onRequestClose={() => setIsFullscreen(false)}
                />
            )}

        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        width: '100%',
    },
    videoWrapper: {
        flex: 1,
        marginLeft: 16,
        marginRight: 76,
        marginTop: 8,
        marginBottom: 48,
        borderRadius: 12,
        overflow: 'hidden',
    },
    compactVideoWrapper: {
        marginRight: 16,
        marginBottom: 104,
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
        bottom: 14,
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
        bottom: 2,
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
        bottom: 68,
        gap: 10,
    },
    compactActions: {
        flexDirection: 'row',
        bottom: 50,
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
    }
});
