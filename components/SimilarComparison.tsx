import { Image } from 'expo-image';
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { clampComparisonScale, comparisonFocus, comparisonTransform } from '../services/similarComparison';

export interface ComparisonPhoto { assetId: string; uri: string; width: number; height: number }
interface LinkedViewport { scale: SharedValue<number>; x: SharedValue<number>; y: SharedValue<number> }

function Pane({ photo, viewport, label }: { photo: ComparisonPhoto; viewport: LinkedViewport; label: string }) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [dimensions, setDimensions] = useState({ width: photo.width, height: photo.height });
    const size = useSharedValue({ width: 1, height: 1 });
    const start = useSharedValue({ scale: 1, x: 0.5, y: 0.5 });
    const focal = useSharedValue({ x: 0, y: 0 });
    const translation = useSharedValue({ x: 0, y: 0 });
    const pinch = Gesture.Pinch().onStart(event => {
        start.value = { scale: viewport.scale.value, x: viewport.x.value, y: viewport.y.value };
        focal.value = { x: event.focalX - size.value.width / 2, y: event.focalY - size.value.height / 2 };
    }).onUpdate(event => {
        const scale = clampComparisonScale(start.value.scale * event.scale);
        const fit = comparisonTransform(dimensions.width, dimensions.height, size.value.width, size.value.height, start.value.scale, start.value.x, start.value.y);
        if (fit.fittedWidth > 0 && fit.fittedHeight > 0) {
            const focus = comparisonFocus(dimensions.width, dimensions.height, size.value.width, size.value.height, scale,
                start.value.x + focal.value.x / fit.fittedWidth * (1 / start.value.scale - 1 / scale),
                start.value.y + focal.value.y / fit.fittedHeight * (1 / start.value.scale - 1 / scale));
            viewport.x.value = focus.x;
            viewport.y.value = focus.y;
        }
        viewport.scale.value = scale;
        if (scale === 1) { viewport.x.value = 0.5; viewport.y.value = 0.5; }
    });
    const pan = Gesture.Pan().minPointers(1).maxPointers(1).manualActivation(true)
    .onTouchesMove((event, manager) => {
        // At fit-to-screen, vertical drags belong to the surrounding page.
        if (viewport.scale.value > 1 && event.numberOfTouches === 1) manager.activate();
        else manager.fail();
    }).onStart(() => {
        translation.value = { x: 0, y: 0 };
    }).onUpdate(event => {
        const fit = comparisonTransform(dimensions.width, dimensions.height, size.value.width, size.value.height, viewport.scale.value, viewport.x.value, viewport.y.value);
        if (fit.fittedWidth > 0 && fit.fittedHeight > 0) {
            const focus = comparisonFocus(dimensions.width, dimensions.height, size.value.width, size.value.height, viewport.scale.value,
                0.5 - (fit.x + event.translationX - translation.value.x) / (fit.fittedWidth * viewport.scale.value),
                0.5 - (fit.y + event.translationY - translation.value.y) / (fit.fittedHeight * viewport.scale.value));
            viewport.x.value = focus.x;
            viewport.y.value = focus.y;
        }
        translation.value = { x: event.translationX, y: event.translationY };
    });
    const imageStyle = useAnimatedStyle(() => {
        const fit = comparisonTransform(dimensions.width, dimensions.height, size.value.width, size.value.height, viewport.scale.value, viewport.x.value, viewport.y.value);
        return { transform: [{ translateX: fit.x }, { translateY: fit.y }, { scale: viewport.scale.value }] };
    });
    return <GestureDetector gesture={Gesture.Simultaneous(pinch, pan)}>
        <View testID={`compare-pane-${photo.assetId}`} style={[styles.pane, { backgroundColor: colors.surfaceHover }]}
            onLayout={event => { size.value = event.nativeEvent.layout; }}>
            {failed ? <View style={styles.error}>
                <Text accessibilityRole="alert" style={[styles.body, { color: colors.textSecondary }]}>{t('scan_photo_unavailable')}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t('retry')} style={styles.button}
                    onPress={() => { setAttempt(value => value + 1); setFailed(false); }}>
                    <Text style={[styles.buttonText, { color: colors.text }]}>{t('retry')}</Text>
                </Pressable>
            </View> : <Animated.View style={[StyleSheet.absoluteFill, imageStyle]}>
                <Image key={attempt} accessible accessibilityRole="image" accessibilityLabel={label}
                    source={{ uri: photo.uri }} cachePolicy="memory" contentFit="contain" style={styles.image}
                    onLoad={event => {
                        const source = event?.source ?? (event as unknown as { nativeEvent?: { source?: { width: number; height: number } } })?.nativeEvent?.source;
                        if (source && source.width > 0 && source.height > 0) setDimensions({ width: source.width, height: source.height });
                    }}
                    onError={() => setFailed(true)} />
            </Animated.View>}
        </View>
    </GestureDetector>;
}

/** Keep / pending deletion choices stay in the group page so switching panes
 * or zooming never deletes media. Users can explicitly mark the whole group
 * as "Not similar" here to persist the ignore and dismiss false positives. */
export function SimilarComparison({
    photos,
    recommendedId,
    onClose,
    onMarkNotSimilar,
    isMarkingNotSimilar = false,
}: {
    photos: ComparisonPhoto[];
    recommendedId: string | null;
    onClose: () => void;
    onMarkNotSimilar?: () => void;
    isMarkingNotSimilar?: boolean;
}) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const insets = useSafeAreaInsets();
    const [a, setA] = useState(Math.max(0, photos.findIndex(photo => photo.assetId === recommendedId)));
    const [b, setB] = useState(a === 0 ? 1 : 0);
    const [focus, setFocus] = useState<'pair' | 'a' | 'b'>('pair');
    const scale = useSharedValue(1), x = useSharedValue(0.5), y = useSharedValue(0.5);
    const viewport = { scale, x, y };
    const reset = () => { scale.value = 1; x.value = 0.5; y.value = 0.5; };
    const change = (slot: 'a' | 'b') => {
        const other = slot === 'a' ? b : a;
        let next = ((slot === 'a' ? a : b) + 1) % photos.length;
        if (next === other) next = (next + 1) % photos.length;
        if (slot === 'a') setA(next); else setB(next);
        reset();
    };
    if (photos.length < 2) return null;
    const button = (label: string, onPress: () => void, selected = false) => <Pressable key={label}
        accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress}
        style={[styles.button, { backgroundColor: selected ? colors.selectionBackground : colors.surface }]}>
        <Text style={[styles.buttonText, { color: colors.text }]}>{label}</Text>
    </Pressable>;
    return <Modal visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
        <GestureHandlerRootView accessibilityViewIsModal testID="similar-comparison" style={[styles.container, {
            backgroundColor: colors.background, paddingTop: insets.top + 8, paddingBottom: insets.bottom,
            paddingLeft: insets.left, paddingRight: insets.right,
        }]}>
            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.header}>
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('similar_compare')}</Text>
                    {button(t('close'), onClose)}
                </View>
                <View style={styles.controls}>
                    {button(t('similar_side_by_side'), () => setFocus('pair'), focus === 'pair')}
                    {button('A', () => setFocus('a'), focus === 'a')}
                    {button('B', () => setFocus('b'), focus === 'b')}
                </View>
                <View style={[styles.panes, focus !== 'pair' && styles.single]}>
                    {focus !== 'b' && <Pane key={`a-${photos[a].assetId}`} photo={photos[a]} viewport={viewport} label={`A · ${t('similar_photo', { index: a + 1 })}`} />}
                    {focus !== 'a' && <Pane key={`b-${photos[b].assetId}`} photo={photos[b]} viewport={viewport} label={`B · ${t('similar_photo', { index: b + 1 })}`} />}
                </View>
                <View style={styles.controls}>
                    {button(t('similar_change_a', { index: a + 1 }), () => change('a'))}
                    {button(t('similar_change_b', { index: b + 1 }), () => change('b'))}
                </View>
                <View style={styles.controls}>
                    {button(t('similar_zoom_out'), () => { scale.value = clampComparisonScale(scale.value / 1.5); if (scale.value === 1) reset(); })}
                    {button(t('similar_zoom_in'), () => { scale.value = clampComparisonScale(scale.value * 1.5); })}
                    {button(t('similar_zoom_reset'), reset)}
                </View>
                {onMarkNotSimilar && (
                    <View style={styles.controls}>
                        <Pressable
                            testID="similar-comparison-not-similar"
                            accessibilityRole="button"
                            accessibilityLabel={t('similar_not_similar_action')}
                            accessibilityState={{ disabled: isMarkingNotSimilar, busy: isMarkingNotSimilar }}
                            disabled={isMarkingNotSimilar}
                            onPress={onMarkNotSimilar}
                            style={[
                                styles.button,
                                { backgroundColor: colors.surface, opacity: isMarkingNotSimilar ? 0.5 : 1 },
                            ]}
                        >
                            <Text style={[styles.buttonText, { color: colors.textSecondary }]}>
                                {t('similar_not_similar_action')}
                            </Text>
                        </Pressable>
                    </View>
                )}
                <Text style={[styles.body, { color: colors.textSecondary }]}>{t('similar_linked_zoom_hint')}</Text>
            </ScrollView>
        </GestureHandlerRootView>
    </Modal>;
}
const styles = StyleSheet.create({
    container: { flex: 1 },
    content: { paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 24, gap: 12 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    title: { ...TYPOGRAPHY.sheetTitle, flex: 1, minWidth: 0 },
    controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    button: { minWidth: UI_METRICS.touchTarget, minHeight: UI_METRICS.touchTarget, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center' },
    buttonText: { ...TYPOGRAPHY.button },
    panes: { flexDirection: 'row', height: 320, gap: 4 },
    single: { height: 380 },
    pane: { flex: 1, overflow: 'hidden', borderRadius: 8 },
    image: { width: '100%', height: '100%' },
    body: { ...TYPOGRAPHY.secondary },
    error: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8, gap: 8 },
});
