import { Ionicons } from '@expo/vector-icons';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
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
import { ScalablePressable } from './ScalablePressable'; // Import ScalablePressable

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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
    const insets = useSafeAreaInsets(); // Add safe area insets
    const needsLocalUri = /^(ph|assets-library):\/\//.test(video.uri);
    const [playbackSource, setPlaybackSource] = useState<{ assetId: string; uri: string } | null>(() => (
        needsLocalUri ? null : { assetId: video.id, uri: video.uri }
    ));
    const [isFullscreen, setIsFullscreen] = useState(false);
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
    const baseShouldPlay = shouldPlay && !(Platform.OS === 'android' && isFullscreen);

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

    return (
        <View style={[styles.container, { backgroundColor: '#000', height: itemHeight }]}>
            <ScalablePressable
                onLongPress={handleLongPress}
                scaleTo={1}
                style={styles.videoWrapper}
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
            </ScalablePressable>

            <View style={[styles.overlayContainer, { bottom: 100 + insets.bottom }]}>
                <View style={styles.metadata}>
                    <View style={styles.locationTag}>
                        <Ionicons name="location-sharp" size={14} color={COLORS.white} />
                        <Text style={styles.locationText}>{t('video_location_unknown')}</Text>
                    </View>
                    <Text style={styles.timeText}>{dateString}</Text>
                </View>
            </View>

            <View style={[styles.sidebar, { bottom: 130 + insets.bottom }]}>
                {/* Mute Button Moved Here */}
                <ScalablePressable style={styles.actionButton} onPress={toggleMute}>
                    <View style={styles.blurCircle}>
                        <Ionicons
                            name={isMuted ? "volume-mute" : "volume-high"}
                            size={24}
                            color={isMuted ? COLORS.danger : COLORS.white}
                        />
                    </View>
                    <Text style={styles.actionText}>{isMuted ? t('video_muted') : t('video_sound')}</Text>
                </ScalablePressable>

                <ScalablePressable style={styles.actionButton} onPress={onFavorite}>
                    <View style={styles.blurCircle}>
                        <Ionicons name="star" size={28} color={COLORS.white} />
                    </View>
                    <Text style={styles.actionText}>{t('video_favorite')}</Text>
                </ScalablePressable>

                <ScalablePressable style={styles.actionButton} onPress={handleShare}>
                    <View style={styles.blurCircle}>
                        <Ionicons name="share-social" size={28} color={COLORS.white} />
                    </View>
                    <Text style={styles.actionText}>{t('video_share')}</Text>
                </ScalablePressable>

                <ScalablePressable style={styles.actionButton} onPress={onDelete}>
                    <View style={styles.blurCircle}>
                        <Ionicons name="trash" size={28} color={COLORS.white} />
                    </View>
                    <Text style={styles.actionText}>{t('video_delete')}</Text>
                </ScalablePressable>
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
        width: SCREEN_WIDTH,
        // height: FEED_HEIGHT, // Removed hardcoded height
        backgroundColor: '#000', // Ensure black background
        justifyContent: 'center',
    },
    videoWrapper: {
        width: '100%',
        height: '100%',
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
    overlayContainer: {
        position: 'absolute',
        left: 20,
        right: 80,
    },
    metadata: {
        marginBottom: 10
    },
    locationTag: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        alignSelf: 'flex-start',
        marginBottom: 4
    },
    locationText: {
        color: COLORS.white,
        fontSize: 12,
        marginLeft: 4
    },
    timeText: {
        color: COLORS.white,
        fontSize: 12,
        textShadowColor: 'rgba(0,0,0,0.5)',
        textShadowRadius: 2
    },
    blurCircle: {
        width: 50,
        height: 50,
        borderRadius: 25,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: 'rgba(0,0,0,0.4)', // Added background since BlurView is removed
    },
    sidebar: {
        position: 'absolute',
        right: 10,
        // bottom set dynamically
        alignItems: 'center',
        gap: 10 // Space between buttons
    },
    actionButton: {
        marginBottom: 15, // Gap handled by gap prop but marginBottom works for safety
        alignItems: 'center'
    },
    actionText: {
        color: COLORS.white,
        fontSize: 10,
        marginTop: 4,
        fontWeight: '600',
        textShadowColor: 'rgba(0,0,0,0.7)',
        textShadowRadius: 3
    }
});
