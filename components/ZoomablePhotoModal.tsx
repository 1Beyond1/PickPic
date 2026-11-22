import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import React, { useEffect } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BORDER_RADIUS, TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { usePhotoPreviewSource } from '../hooks/usePhotoPreviewSource';
import {
    DOUBLE_TAP_ZOOM_SCALE,
    MIN_ZOOM_SCALE,
    clampZoomTranslation,
    computeDoubleTapZoom,
    computePinchZoom,
} from '../services/zoomMath';
import { PhotoReadFeedback } from './PhotoReadFeedback';

const DARK_CHROME = {
    backdrop: '#090A0B',
    bar: 'rgba(18, 19, 22, 0.94)',
    surface: 'rgba(255, 255, 255, 0.12)',
    surfacePressed: 'rgba(255, 255, 255, 0.22)',
    border: 'rgba(255, 255, 255, 0.14)',
    text: '#F6F7F5',
    textSecondary: '#B9BDBA',
    primaryBg: '#F6F7F5',
    primaryFg: '#111212',
    dangerBg: '#D94B4B',
    dangerFg: '#FFFFFF',
    protectedBg: 'rgba(59, 130, 246, 0.24)',
    protectedText: '#BFDBFE',
} as const;

export interface ZoomableImageProps {
    uri: string;
    imageKey?: string | number;
    resetToken?: string | number;
    accessibilityLabel?: string;
    onError?: (error?: unknown) => void;
    testID?: string;
}

export function ZoomableImage({
    uri,
    imageKey,
    resetToken,
    accessibilityLabel,
    onError,
    testID,
}: ZoomableImageProps) {
    const reducedMotion = useReducedMotion();
    const scale = useSharedValue(MIN_ZOOM_SCALE);
    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const viewport = useSharedValue({ width: 0, height: 0 });
    const natural = useSharedValue({ width: 0, height: 0 });
    const pinchStart = useSharedValue({ scale: MIN_ZOOM_SCALE, x: 0, y: 0, focalX: 0, focalY: 0 });
    const panStart = useSharedValue({ x: 0, y: 0 });

    useEffect(() => {
        scale.value = MIN_ZOOM_SCALE;
        translateX.value = 0;
        translateY.value = 0;
        natural.value = { width: 0, height: 0 };
    }, [uri, resetToken, scale, translateX, translateY, natural]);

    const pinch = Gesture.Pinch()
        .onStart(event => {
            pinchStart.value = {
                scale: scale.value,
                x: translateX.value,
                y: translateY.value,
                focalX: event.focalX,
                focalY: event.focalY,
            };
        })
        .onUpdate(event => {
            const next = computePinchZoom(
                pinchStart.value.focalX,
                pinchStart.value.focalY,
                viewport.value.width,
                viewport.value.height,
                pinchStart.value.scale,
                pinchStart.value.x,
                pinchStart.value.y,
                event.scale,
                natural.value.width,
                natural.value.height,
            );
            scale.value = next.scale;
            translateX.value = next.x;
            translateY.value = next.y;
        })
        .onEnd(() => {
            const duration = reducedMotion ? 0 : 180;
            if (scale.value <= MIN_ZOOM_SCALE + 0.02) {
                scale.value = withTiming(MIN_ZOOM_SCALE, { duration });
                translateX.value = withTiming(0, { duration });
                translateY.value = withTiming(0, { duration });
                return;
            }
            const clamped = clampZoomTranslation(
                translateX.value,
                translateY.value,
                viewport.value.width,
                viewport.value.height,
                scale.value,
                natural.value.width,
                natural.value.height,
            );
            translateX.value = withTiming(clamped.x, { duration });
            translateY.value = withTiming(clamped.y, { duration });
        });

    const pan = Gesture.Pan()
        .minPointers(1)
        .maxPointers(1)
        .manualActivation(true)
        .onTouchesMove((event, manager) => {
            if (scale.value > MIN_ZOOM_SCALE + 0.02 && event.numberOfTouches === 1) {
                manager.activate();
            } else {
                manager.fail();
            }
        })
        .onStart(() => {
            panStart.value = { x: translateX.value, y: translateY.value };
        })
        .onUpdate(event => {
            const clamped = clampZoomTranslation(
                panStart.value.x + event.translationX,
                panStart.value.y + event.translationY,
                viewport.value.width,
                viewport.value.height,
                scale.value,
                natural.value.width,
                natural.value.height,
            );
            translateX.value = clamped.x;
            translateY.value = clamped.y;
        })
        .onEnd(() => {
            const duration = reducedMotion ? 0 : 160;
            if (scale.value <= MIN_ZOOM_SCALE + 0.02) {
                scale.value = withTiming(MIN_ZOOM_SCALE, { duration });
                translateX.value = withTiming(0, { duration });
                translateY.value = withTiming(0, { duration });
                return;
            }
            const clamped = clampZoomTranslation(
                translateX.value,
                translateY.value,
                viewport.value.width,
                viewport.value.height,
                scale.value,
                natural.value.width,
                natural.value.height,
            );
            translateX.value = withTiming(clamped.x, { duration });
            translateY.value = withTiming(clamped.y, { duration });
        });

    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(260)
        .onEnd((event, success) => {
            if (!success) return;
            const next = computeDoubleTapZoom(
                event.x,
                event.y,
                viewport.value.width,
                viewport.value.height,
                scale.value,
                DOUBLE_TAP_ZOOM_SCALE,
                natural.value.width,
                natural.value.height,
            );
            const duration = reducedMotion ? 0 : 200;
            scale.value = withTiming(next.scale, { duration });
            translateX.value = withTiming(next.x, { duration });
            translateY.value = withTiming(next.y, { duration });
        });

    const composed = Gesture.Simultaneous(doubleTap, pinch, pan);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
            { scale: scale.value },
        ],
    }));

    return (
        <GestureDetector gesture={composed}>
            <View
                testID={testID ?? 'zoomable-image-viewport'}
                style={styles.zoomViewport}
                onLayout={event => {
                    const { width, height } = event.nativeEvent.layout;
                    viewport.value = { width, height };
                }}
            >
                <Animated.View style={[styles.zoomCanvas, animatedStyle]}>
                    <Image
                        key={imageKey}
                        recyclingKey={resetToken !== undefined ? String(resetToken) : uri}
                        accessible
                        accessibilityRole="image"
                        accessibilityLabel={accessibilityLabel}
                        source={{ uri }}
                        cachePolicy="memory"
                        contentFit="contain"
                        transition={0}
                        style={styles.image}
                        onLoad={event => {
                            const source = event?.source
                                ?? (event as unknown as { nativeEvent?: { source?: { width: number; height: number } } })
                                    ?.nativeEvent?.source;
                            if (source && source.width > 0 && source.height > 0) {
                                natural.value = { width: source.width, height: source.height };
                            }
                        }}
                        onError={onError}
                    />
                </Animated.View>
            </View>
        </GestureDetector>
    );
}

export interface ZoomablePhotoAction {
    id: string;
    label: string;
    icon?: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
    tone?: 'default' | 'danger' | 'primary';
    disabled?: boolean;
    testID?: string;
}

export interface ZoomablePhotoModalProps {
    visible: boolean;
    photo: { uri: string; id?: string } | null;
    title?: string;
    subtitle?: string;
    isProtected?: boolean;
    feedback?: string | null;
    actions?: readonly ZoomablePhotoAction[];
    onClose: () => void;
    testID?: string;
}

export function ZoomablePhotoModal({
    visible,
    photo,
    title,
    subtitle,
    isProtected = false,
    feedback,
    actions = [],
    onClose,
    testID = 'zoomable-photo-modal',
}: ZoomablePhotoModalProps) {
    const insets = useSafeAreaInsets();
    const { t } = useI18n();
    const reducedMotion = useReducedMotion();

    return (
        <Modal
            visible={visible && !!photo}
            transparent
            animationType={reducedMotion ? 'none' : 'fade'}
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={onClose}
        >
            <GestureHandlerRootView
                accessibilityViewIsModal
                testID={testID}
                style={[styles.root, { backgroundColor: DARK_CHROME.backdrop }]}
            >
                <View
                    style={[
                        styles.topBar,
                        {
                            paddingTop: insets.top + 8,
                            paddingLeft: insets.left + UI_METRICS.pageInset,
                            paddingRight: insets.right + UI_METRICS.pageInset,
                        },
                    ]}
                >
                    <View style={styles.titleWrap}>
                        <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
                            {title ?? t('photo_detail_title')}
                        </Text>
                        {!!subtitle && (
                            <Text style={styles.subtitle} numberOfLines={2}>
                                {subtitle}
                            </Text>
                        )}
                    </View>
                    {isProtected && (
                        <View testID="zoom-modal-protected-badge" style={styles.protectedPill}>
                            <Ionicons name="shield-checkmark" size={14} color={DARK_CHROME.protectedText} />
                            <Text style={styles.protectedPillText}>{t('protected_badge')}</Text>
                        </View>
                    )}
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('close')}
                        onPress={onClose}
                        style={({ pressed }) => [
                            styles.closeButton,
                            { backgroundColor: pressed ? DARK_CHROME.surfacePressed : DARK_CHROME.surface },
                        ]}
                    >
                        <Ionicons name="close-outline" size={24} color={DARK_CHROME.text} />
                    </Pressable>
                </View>

                <View style={styles.mediaArea}>
                    {photo && (
                        <ZoomablePhotoModalContent
                            key={`${photo.id ?? ''}:${photo.uri}`}
                            photo={photo}
                        />
                    )}
                </View>

                <View
                    style={[
                        styles.bottomBar,
                        {
                            paddingBottom: insets.bottom + 14,
                            paddingLeft: insets.left + UI_METRICS.pageInset,
                            paddingRight: insets.right + UI_METRICS.pageInset,
                        },
                    ]}
                >
                    <Text style={styles.hintText}>{t('zoom_preview_hint')}</Text>
                    {!!feedback && (
                        <Text accessibilityLiveRegion="polite" style={styles.feedbackText}>
                            {feedback}
                        </Text>
                    )}
                    {actions.length > 0 && (
                        <View style={styles.actionsRow}>
                            {actions.map(action => {
                                const backgroundColor = action.tone === 'danger'
                                    ? DARK_CHROME.dangerBg
                                    : action.tone === 'primary'
                                        ? DARK_CHROME.primaryBg
                                        : DARK_CHROME.surface;
                                const foregroundColor = action.tone === 'danger'
                                    ? DARK_CHROME.dangerFg
                                    : action.tone === 'primary'
                                        ? DARK_CHROME.primaryFg
                                        : DARK_CHROME.text;
                                return (
                                    <Pressable
                                        key={action.id}
                                        testID={action.testID}
                                        accessibilityRole="button"
                                        accessibilityLabel={action.label}
                                        accessibilityState={{ disabled: !!action.disabled }}
                                        disabled={action.disabled}
                                        onPress={action.onPress}
                                        style={({ pressed }) => [
                                            styles.actionButton,
                                            {
                                                backgroundColor,
                                                opacity: action.disabled ? 0.45 : pressed ? 0.8 : 1,
                                            },
                                        ]}
                                    >
                                        {action.icon && (
                                            <Ionicons name={action.icon} size={18} color={foregroundColor} />
                                        )}
                                        <Text style={[styles.actionButtonText, { color: foregroundColor }]}>
                                            {action.label}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    )}
                </View>
            </GestureHandlerRootView>
        </Modal>
    );
}

function ZoomablePhotoModalContent({ photo }: { photo: { uri: string; id?: string } }) {
    const image = usePhotoPreviewSource(photo.uri, photo.id);
    const { t } = useI18n();

    if (image.failed) {
        return (
            <View style={styles.centered}>
                <PhotoReadFeedback onRetry={image.retry} />
            </View>
        );
    }

    if (image.loading || !image.uri) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color={DARK_CHROME.text} />
            </View>
        );
    }

    return (
        <ZoomableImage
            uri={image.uri}
            imageKey={image.attempt}
            resetToken={`${photo.id ?? ''}:${image.uri}:${image.attempt}`}
            accessibilityLabel={t('photo_detail_title')}
            onError={image.onError}
        />
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingBottom: 12,
        backgroundColor: DARK_CHROME.bar,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: DARK_CHROME.border,
    },
    titleWrap: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    title: {
        ...TYPOGRAPHY.sectionTitle,
        color: DARK_CHROME.text,
    },
    subtitle: {
        ...TYPOGRAPHY.caption,
        color: DARK_CHROME.textSecondary,
    },
    protectedPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: BORDER_RADIUS.full,
        backgroundColor: DARK_CHROME.protectedBg,
    },
    protectedPillText: {
        ...TYPOGRAPHY.caption,
        color: DARK_CHROME.protectedText,
        fontWeight: '600',
    },
    closeButton: {
        width: UI_METRICS.touchTarget,
        height: UI_METRICS.touchTarget,
        borderRadius: UI_METRICS.buttonRadius,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    mediaArea: {
        flex: 1,
        minHeight: 0,
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    zoomViewport: {
        flex: 1,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
    },
    zoomCanvas: {
        flex: 1,
        width: '100%',
        height: '100%',
    },
    image: {
        width: '100%',
        height: '100%',
    },
    bottomBar: {
        paddingTop: 12,
        gap: 10,
        backgroundColor: DARK_CHROME.bar,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: DARK_CHROME.border,
    },
    hintText: {
        ...TYPOGRAPHY.caption,
        color: DARK_CHROME.textSecondary,
        textAlign: 'center',
    },
    feedbackText: {
        ...TYPOGRAPHY.secondary,
        color: DARK_CHROME.text,
        textAlign: 'center',
    },
    actionsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
    },
    actionButton: {
        flex: 1,
        minWidth: 132,
        minHeight: UI_METRICS.buttonHeight,
        borderRadius: UI_METRICS.buttonRadius,
        paddingHorizontal: 14,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    actionButtonText: {
        ...TYPOGRAPHY.button,
        textAlign: 'center',
    },
});
