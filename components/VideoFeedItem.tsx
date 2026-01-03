import { Ionicons } from '@expo/vector-icons';
import { ResizeMode, Video } from 'expo-av';
import * as Sharing from 'expo-sharing';
import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { PhotoAsset } from '../stores/useMediaStore';
import { ScalablePressable } from './ScalablePressable'; // Import ScalablePressable

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface VideoFeedItemProps {
    video: PhotoAsset;
    isActive: boolean;
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
    shouldPlay,
    isMuted,
    toggleMute,
    onDelete,
    onFavorite,
    t,
    colors,
    itemHeight
}) => {
    const videoRef = useRef<Video>(null);
    const [status, setStatus] = useState<any>({});
    const [locationName, setLocationName] = useState('Loading...');
    const insets = useSafeAreaInsets(); // Add safe area insets

    useEffect(() => {
        // Mock location loading
        setTimeout(() => {
            setLocationName('Unknown Location');
        }, 1000);
    }, []);

    useEffect(() => {
        if (shouldPlay) {
            videoRef.current?.playAsync();
        } else {
            videoRef.current?.pauseAsync();
        }
    }, [shouldPlay]);

    const handleShare = async () => {
        if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(video.uri);
        }
    };

    const handleLongPress = async () => {
        if (videoRef.current) {
            await videoRef.current.presentFullscreenPlayer();
        }
    };

    const date = new Date(video.creationTime);
    const dateString = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return (
        <View style={[styles.container, { backgroundColor: '#000', height: itemHeight }]}>
            <ScalablePressable
                onLongPress={handleLongPress}
                scaleTo={1}
                style={styles.videoWrapper}
            >
                <Video
                    ref={videoRef}
                    style={styles.video}
                    source={{ uri: video.uri }}
                    resizeMode={ResizeMode.CONTAIN}
                    isLooping
                    isMuted={isMuted}
                    shouldPlay={shouldPlay}
                    onPlaybackStatusUpdate={status => setStatus(() => status)}
                />
            </ScalablePressable>

            <View style={[styles.overlayContainer, { bottom: 100 + insets.bottom }]}>
                <View style={styles.metadata}>
                    <View style={styles.locationTag}>
                        <Ionicons name="location-sharp" size={14} color={COLORS.white} />
                        <Text style={styles.locationText}>{locationName}</Text>
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
