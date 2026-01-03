import { Image } from 'expo-image';
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
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
import { BORDER_RADIUS } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';
import { PhotoAsset } from '../stores/useMediaStore';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Increased Card Dimensions
const CARD_WIDTH = SCREEN_WIDTH * 0.92; // Was 0.9 or smaller implicitly
const CARD_HEIGHT = SCREEN_HEIGHT * 0.65; // Increase height for bigger view
const CARD_borderRadius = BORDER_RADIUS.xl;
const SWIPE_THRESHOLD = 150;

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

    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);

    // Zone detection threshold - card must be dragged past this Y coordinate to activate zones
    // 80% of screen height means zone area is only at the very bottom
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
            scale.value = withTiming(0.95);

            // Use absoluteY to check if card is in the drop zone area
            if (event.absoluteY > ZONE_ACTIVATION_Y && onHoverZone) {
                const zoneId = checkZone(event.absoluteX);
                runOnJS(onHoverZone)(zoneId);
            } else if (onHoverZone) {
                runOnJS(onHoverZone)(null);
            }
        })
        .onEnd((event) => {
            if (translateY.value < -SWIPE_THRESHOLD) {
                // Swipe Up -> Delete
                translateX.value = withTiming(0);
                translateY.value = withTiming(-SCREEN_HEIGHT, {}, () => {
                    runOnJS(onSwipeUp)();
                });
            } else if (translateY.value > SWIPE_THRESHOLD) {
                // Swipe Down
                const isInZoneArea = event.absoluteY > ZONE_ACTIVATION_Y;
                const matchedZoneId = isInZoneArea ? checkZone(event.absoluteX) : null;

                if (matchedZoneId) {
                    // Hit a zone -> Organize
                    translateX.value = withTiming(0);
                    translateY.value = withTiming(SCREEN_HEIGHT, {}, () => {
                        runOnJS(onSwipeDown)(matchedZoneId);
                    });
                } else {
                    // No zone hit -> ALWAYS Skip (simplified logic)
                    // Whether collections enabled or not, swipe down without zone hit = Skip
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
            [-15, 0, 15],
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
                    backgroundColor: colors.surface,
                    shadowColor: colors.textSecondary // Softer shadow in dark mode?
                }
            ]}>
                <Image
                    source={{ uri: photo.uri }}
                    style={styles.image}
                    contentFit="cover"
                    transition={200}
                />
            </Animated.View>
        </GestureDetector>
    );
};

const styles = StyleSheet.create({
    cardContainer: {
        position: 'absolute',
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        borderRadius: BORDER_RADIUS.l,
        overflow: 'hidden',
        elevation: 5,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },
    image: {
        width: '100%',
        height: '100%',
    },
});
