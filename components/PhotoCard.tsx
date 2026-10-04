import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { Image as RNImage, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    useReducedMotion,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { BORDER_RADIUS } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';
import { useI18n } from '../hooks/useI18n';
import { PhotoAsset } from '../stores/useMediaStore';

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
    onSwipeDown: (zoneId?: string) => Promise<boolean>;
    onTap: () => void;
    onHoverZone?: (zoneId: string | null) => void;
    enableCollections: boolean;
    dropZones: DropZone[];
    maxWidth: number;
    maxHeight: number;
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
    maxWidth,
    maxHeight,
}) => {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const reducedMotion = useReducedMotion();
    const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
    const [aspectRatio, setAspectRatio] = useState(1);
    const cardWidth = Math.min(maxWidth, maxHeight * aspectRatio);
    const cardHeight = cardWidth / aspectRatio;

    // The parent measures space left by the header, hints and Dock. Derive the
    // fit on every resize; do not retain a window-sized card inside that space.
    useEffect(() => {
        let active = true;
        setAspectRatio(1);
        if (photo.uri) {
            RNImage.getSize(
                photo.uri,
                (imgWidth, imgHeight) => {
                    if (active && imgWidth > 0 && imgHeight > 0 && Number.isFinite(imgWidth / imgHeight)) {
                        setAspectRatio(imgWidth / imgHeight);
                    }
                },
                () => {
                    console.log('Failed to get image size.');
                    if (active) setAspectRatio(1);
                }
            );
        }
        return () => { active = false; };
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

    const resetCardPosition = () => {
        translateX.value = reducedMotion ? 0 : withSpring(0);
        translateY.value = reducedMotion ? 0 : withSpring(0);
        scale.value = reducedMotion ? 1 : withSpring(1);
        onHoverZone?.(null);
    };

    const completeSwipeDown = (zoneId?: string) => {
        // The card is animated away before an async collection operation can
        // finish. Put it back if that operation fails so the item remains
        // actionable instead of becoming an invisible, unprocessed card.
        void Promise.resolve()
            .then(() => onSwipeDown(zoneId))
            .then((succeeded) => {
                if (succeeded === false) {
                    resetCardPosition();
                }
            })
            .catch(() => {
                resetCardPosition();
            });
    };

    const pan = Gesture.Pan()
        .enabled(index === 0)
        .onUpdate((event) => {
            translateX.value = event.translationX;
            translateY.value = event.translationY;
            scale.value = reducedMotion ? 1 : withTiming(0.96);

            if (event.absoluteY > ZONE_ACTIVATION_Y && onHoverZone) {
                const zoneId = checkZone(event.absoluteX);
                runOnJS(onHoverZone)(zoneId);
            } else if (onHoverZone) {
                runOnJS(onHoverZone)(null);
            }
        })
        .onEnd((event, success) => {
            if (!success) return;
            if (translateY.value < -SWIPE_THRESHOLD) {
                translateX.value = withTiming(0, { duration: reducedMotion ? 0 : 300 });
                translateY.value = withTiming(-SCREEN_HEIGHT, { duration: reducedMotion ? 0 : 300 }, finished => {
                    if (finished) runOnJS(onSwipeUp)();
                });
            } else if (translateY.value > SWIPE_THRESHOLD) {
                const isInZoneArea = event.absoluteY > ZONE_ACTIVATION_Y;
                const matchedZoneId = isInZoneArea ? checkZone(event.absoluteX) : null;

                if (matchedZoneId) {
                    translateX.value = withTiming(0, { duration: reducedMotion ? 0 : 300 });
                    translateY.value = withTiming(SCREEN_HEIGHT, { duration: reducedMotion ? 0 : 300 }, finished => {
                        if (finished) runOnJS(completeSwipeDown)(matchedZoneId);
                    });
                } else {
                    translateX.value = withTiming(0, { duration: reducedMotion ? 0 : 300 });
                    translateY.value = withTiming(SCREEN_HEIGHT, { duration: reducedMotion ? 0 : 300 }, finished => {
                        if (finished) runOnJS(completeSwipeDown)();
                    });
                    if (onHoverZone) runOnJS(onHoverZone)(null);
                }
            } else {
                runOnJS(resetCardPosition)();
            }
        }).onFinalize((_event, success) => {
            if (!success) runOnJS(resetCardPosition)();
        });

    const tap = Gesture.Tap().enabled(index === 0).onEnd((_event, success) => {
        if (success) runOnJS(onTap)();
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
                { rotate: `${reducedMotion ? 0 : rotate}deg` },
                { scale: scale.value },
            ],
            zIndex: total - index,
        };
    });

    return (
        <GestureDetector gesture={composed}>
            <Animated.View style={[
                styles.frame,
                animatedStyle,
                {
                    width: maxWidth,
                    height: maxHeight,
                    backgroundColor: colors.background,
                }
            ]} pointerEvents={index === 0 ? 'auto' : 'none'} accessibilityElementsHidden={index !== 0}
                importantForAccessibility={index === 0 ? 'auto' : 'no-hide-descendants'} accessible={index === 0}
                accessibilityRole="button" accessibilityLabel={t('photo_detail_title')}
                onAccessibilityTap={index === 0 ? onTap : undefined}
                accessibilityActions={index === 0 ? [{ name: 'activate' }] : undefined}
                onAccessibilityAction={event => { if (index === 0 && event.nativeEvent.actionName === 'activate') onTap(); }}>
                <View testID="photo-card-image-frame" style={[styles.cardContainer, {
                    width: cardWidth, height: cardHeight, backgroundColor: colors.surface,
                }]}>
                    <Image
                        key={`${photo.id}:${photo.uri}`}
                        cachePolicy="memory"
                        source={{ uri: photo.uri }}
                        style={styles.image}
                        contentFit="contain"
                        transition={reducedMotion ? 0 : 150}
                    />
                </View>
            </Animated.View>
        </GestureDetector>
    );
};

const styles = StyleSheet.create({
    frame: {
        position: 'absolute',
        alignItems: 'center',
        justifyContent: 'center',
    },
    cardContainer: {
        borderRadius: BORDER_RADIUS.m,
        overflow: 'hidden',
    },
    image: {
        flex: 1,
    },
});
