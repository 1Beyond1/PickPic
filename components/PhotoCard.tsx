import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { Dimensions, Image as RNImage, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { BORDER_RADIUS, SPACING } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';
import { PhotoAsset } from '../stores/useMediaStore';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Card padding around the image
const CARD_PADDING = SPACING.s;
const MAX_CARD_WIDTH = SCREEN_WIDTH * 0.85;
const MAX_CARD_HEIGHT = SCREEN_HEIGHT * 0.55;
const SWIPE_THRESHOLD = 120;

interface DropZone {
    id: string;
    minX: number;
    maxX: number;
}

interface PhotoCardProps {
    photo: PhotoAsset;
    index: number;
    total: number;
    onSwipeUp: () => void;
    onSwipeDown: (zoneId?: string) => void;
    onTap: () => void;
    onHoverZone?: (zoneId: string | null) => void;
    enableCollections: boolean;
    dropZones: DropZone[];
}

export const PhotoCard: React.FC<PhotoCardProps> = ({
    photo,
    index,
    total,
    onSwipeUp,
    onSwipeDown,
    onTap,
    onHoverZone,
    enableCollections,
    dropZones,
}) => {
    const { colors } = useThemeColor();
    const [cardWidth, setCardWidth] = useState(MAX_CARD_WIDTH);
    const [cardHeight, setCardHeight] = useState(MAX_CARD_HEIGHT * 0.7);

    // Load image dimensions and calculate card size to fit image
    useEffect(() => {
        if (photo.uri) {
            RNImage.getSize(
                photo.uri,
                (imgWidth, imgHeight) => {
                    const ratio = imgWidth / imgHeight;

                    // Calculate dimensions to fit image within max bounds
                    let width = MAX_CARD_WIDTH;
                    let height = width / ratio;

                    // If height exceeds max, scale down
                    if (height > MAX_CARD_HEIGHT) {
                        height = MAX_CARD_HEIGHT;
                        width = height * ratio;
                    }

                    // Add padding for card border
                    setCardWidth(width + CARD_PADDING * 2);
                    setCardHeight(height + CARD_PADDING * 2);
                },
                (error) => {
                    console.log('Failed to get image size:', error);
                    setCardWidth(MAX_CARD_WIDTH);
                    setCardHeight(MAX_CARD_HEIGHT * 0.7);
                }
            );
        }
    }, [photo.uri]);

    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);

    const ZONE_ACTIVATION_Y = SCREEN_HEIGHT * 0.75;

    const checkZone = (absoluteX: number) => {
        'worklet';
        if (!enableCollections) return null;
        for (const zone of dropZones) {
            if (absoluteX >= zone.minX && absoluteX <= zone.maxX) {
                return zone.id;
            }
        }
        return null;
    };

    const pan = Gesture.Pan()
        .onUpdate((event) => {
            translateX.value = event.translationX;
            translateY.value = event.translationY;
            scale.value = withTiming(0.96);

            if (event.absoluteY > ZONE_ACTIVATION_Y && onHoverZone) {
                const zoneId = checkZone(event.absoluteX);
                runOnJS(onHoverZone)(zoneId);
            } else if (onHoverZone) {
                runOnJS(onHoverZone)(null);
            }
        })
        .onEnd((event) => {
            if (translateY.value < -SWIPE_THRESHOLD) {
                translateX.value = withTiming(0);
                translateY.value = withTiming(-SCREEN_HEIGHT, {}, () => {
                    runOnJS(onSwipeUp)();
                });
            } else if (translateY.value > SWIPE_THRESHOLD) {
                const isInZoneArea = event.absoluteY > ZONE_ACTIVATION_Y;
                const matchedZoneId = isInZoneArea ? checkZone(event.absoluteX) : null;

                if (matchedZoneId) {
                    translateX.value = withTiming(0);
                    translateY.value = withTiming(SCREEN_HEIGHT, {}, () => {
                        runOnJS(onSwipeDown)(matchedZoneId);
                    });
                } else {
                    translateX.value = withTiming(0);
                    translateY.value = withTiming(SCREEN_HEIGHT, {}, () => {
                        runOnJS(onSwipeDown)();
                    });
                    if (onHoverZone) runOnJS(onHoverZone)(null);
                }
            } else {
                translateX.value = withSpring(0);
                translateY.value = withSpring(0);
                scale.value = withSpring(1);
                if (onHoverZone) runOnJS(onHoverZone)(null);
            }
        });

    const tap = Gesture.Tap().onEnd(() => {
        runOnJS(onTap)();
    });

    const composed = Gesture.Race(pan, tap);

    const animatedStyle = useAnimatedStyle(() => {
        const rotate = interpolate(
            translateX.value,
            [-SCREEN_WIDTH / 2, 0, SCREEN_WIDTH / 2],
            [-8, 0, 8],
            Extrapolation.CLAMP
        );

        return {
            transform: [
                { translateX: translateX.value },
                { translateY: translateY.value },
                { rotate: `${rotate}deg` },
                { scale: scale.value },
            ],
            zIndex: total - index,
        };
    });

    return (
        <GestureDetector gesture={composed}>
            <Animated.View style={[
                styles.cardContainer,
                animatedStyle,
                {
                    width: cardWidth,
                    height: cardHeight,
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                }
            ]}>
                {/* Image fills card with small padding */}
                <Image
                    source={{ uri: photo.uri }}
                    style={[styles.image, { margin: CARD_PADDING }]}
                    contentFit="contain"
                    transition={150}
                />
            </Animated.View>
        </GestureDetector>
    );
};

const styles = StyleSheet.create({
    cardContainer: {
        position: 'absolute',
        borderRadius: BORDER_RADIUS.l,
        overflow: 'hidden',
        borderWidth: 1,
        // Subtle shadow
        elevation: 3,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 8,
    },
    image: {
        flex: 1,
        borderRadius: BORDER_RADIUS.m,
    },
});
