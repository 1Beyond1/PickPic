import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { Dimensions, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const TAB_BAR_WIDTH = SCREEN_WIDTH * 0.85;
const TAB_COUNT = 3;
const TAB_WIDTH = TAB_BAR_WIDTH / TAB_COUNT;
const BAR_HEIGHT = 72;
const LENS_WIDTH = TAB_WIDTH + 10;
const LENS_HEIGHT = BAR_HEIGHT - 8;

const TABS = [
    { name: 'photos', icon: 'images', labelKey: 'tab_photos', path: '/(tabs)/photos' },
    { name: 'videos', icon: 'videocam', labelKey: 'tab_videos', path: '/(tabs)/videos' },
    { name: 'settings', icon: 'settings-sharp', labelKey: 'tab_settings', path: '/(tabs)/settings' },
];

export const LiquidFloatingTabBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { isDark } = useThemeColor();
    const { t } = useI18n();

    const activeIndex = TABS.findIndex(tab => pathname.includes(tab.name));
    const safeIndex = activeIndex >= 0 ? activeIndex : 0;

    // Animation value - lens X position
    const lensX = useSharedValue(safeIndex * TAB_WIDTH + (TAB_WIDTH - LENS_WIDTH) / 2);
    const startX = useSharedValue(0);

    const lastIndex = useRef(safeIndex);

    useEffect(() => {
        if (lastIndex.current !== safeIndex) {
            lensX.value = withTiming(safeIndex * TAB_WIDTH + (TAB_WIDTH - LENS_WIDTH) / 2, { duration: 250 });
            lastIndex.current = safeIndex;
        }
    }, [safeIndex]);

    const navigateTo = (index: number) => {
        if (index !== safeIndex) {
            router.push(TABS[index].path as any);
        }
    };

    const panGesture = Gesture.Pan()
        .onStart(() => {
            startX.value = lensX.value;
        })
        .onUpdate((e) => {
            const newX = startX.value + e.translationX;
            const minX = (TAB_WIDTH - LENS_WIDTH) / 2;
            const maxX = (TAB_COUNT - 1) * TAB_WIDTH + (TAB_WIDTH - LENS_WIDTH) / 2;
            lensX.value = Math.max(minX, Math.min(maxX, newX));
        })
        .onEnd(() => {
            const centerX = lensX.value + LENS_WIDTH / 2;
            const targetIndex = Math.floor(centerX / TAB_WIDTH);
            const clampedIndex = Math.max(0, Math.min(targetIndex, TABS.length - 1));

            const targetX = clampedIndex * TAB_WIDTH + (TAB_WIDTH - LENS_WIDTH) / 2;
            lensX.value = withTiming(targetX, { duration: 200 });

            if (clampedIndex !== safeIndex) {
                runOnJS(navigateTo)(clampedIndex);
            }
        });

    const lensStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: lensX.value }],
    }));

    return (
        <View style={styles.container}>
            {/* Background Pill */}
            {/* Slightly reduced opacity for cleaner look */}
            <View style={[styles.backgroundPill, { backgroundColor: isDark ? 'rgba(20, 20, 20, 0.3)' : 'rgba(240, 240, 240, 0.3)' }]}>
                <View style={[StyleSheet.absoluteFill, {
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.2)',
                    borderRadius: BAR_HEIGHT / 2
                }]} />

                <BlurView
                    intensity={isDark ? 20 : 40} // Reduced intensity
                    tint={isDark ? 'dark' : 'light'}
                    style={StyleSheet.absoluteFill}
                />

                <View style={styles.tabRow}>
                    {TABS.map((tab, index) => {
                        const isActive = index === safeIndex;
                        return (
                            <Pressable
                                key={tab.name}
                                style={styles.tabItem}
                                onPress={() => navigateTo(index)}
                                hitSlop={10}
                            >
                                <Ionicons
                                    name={tab.icon as any}
                                    size={24}
                                    color={isActive ? (isDark ? '#FFF' : '#000') : (isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)')}
                                />
                                <Text style={[
                                    styles.label,
                                    { color: isActive ? (isDark ? '#FFF' : '#000') : (isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)') }
                                ]}>
                                    {t(tab.labelKey as any)}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
            </View>

            {/* Selection Lens (Refined Glass Look) */}
            <GestureDetector gesture={panGesture}>
                <Animated.View style={[styles.lens, lensStyle]}>
                    {/* Glass Border Gradient - Even more transparent */}
                    <LinearGradient
                        colors={
                            isDark
                                ? ['rgba(255,255,255,0.4)', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.0)', 'rgba(255,255,255,0.2)']
                                : ['rgba(255,255,255,0.8)', 'rgba(255,255,255,0.2)', 'rgba(255,255,255,0.0)', 'rgba(255,255,255,0.5)']
                        }
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.glassBorder}
                    />

                    {/* Inner Lens Body */}
                    <View style={[styles.lensInner, {
                        backgroundColor: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.1)' // More transparent
                    }]}>
                        <BlurView
                            intensity={isDark ? 15 : 30}
                            tint="light"
                            style={StyleSheet.absoluteFill}
                        />

                        {/* Subtle chromatic aberration hint */}
                        <LinearGradient
                            colors={['rgba(0,255,255,0.05)', 'transparent', 'rgba(255,0,255,0.05)']} // Very Faint
                            start={{ x: 0, y: 0.5 }}
                            end={{ x: 1, y: 0.5 }}
                            style={[StyleSheet.absoluteFill, { opacity: 0.3 }]}
                        />

                        {/* Top Curved Highlight (Specularity) */}
                        <View style={styles.specularHighlight} />
                    </View>

                    {/* Interaction Glow / Diffusion Effect - Simple overlay that could pulse but static for now to separate layer */}
                    <View style={[StyleSheet.absoluteFill, { borderRadius: LENS_HEIGHT / 2, overflow: 'hidden' }]}>
                        <View style={{
                            position: 'absolute',
                            top: '20%', left: '20%', right: '20%', bottom: '20%',
                            backgroundColor: 'rgba(255,255,255,0.05)',
                            borderRadius: 50,
                            opacity: 0.5,
                            transform: [{ scale: 1.2 }] // slight bloom
                        }} />
                    </View>

                </Animated.View>
            </GestureDetector>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        bottom: 30, // Lifted slightly
        alignSelf: 'center',
        zIndex: 100,
    },
    backgroundPill: {
        width: TAB_BAR_WIDTH,
        height: BAR_HEIGHT,
        borderRadius: BAR_HEIGHT / 2,
        overflow: 'hidden',
        // Softer shadow for the track
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.1,
                shadowRadius: 10,
            },
            android: { elevation: 4 },
        }),
    },
    tabRow: {
        ...StyleSheet.absoluteFillObject,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
        zIndex: 1,
    },
    tabItem: {
        width: TAB_WIDTH,
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
    },
    label: {
        fontSize: 10,
        marginTop: 4,
        fontWeight: '600',
        letterSpacing: 0.5,
    },
    // Lens Styles
    lens: {
        position: 'absolute',
        width: LENS_WIDTH,
        height: LENS_HEIGHT,
        borderRadius: LENS_HEIGHT / 2,
        top: 4,
        left: 0,
        // Lift the lens visually
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: 0.15, // Slightly lighter shadow
                shadowRadius: 15, // softer
            },
            android: { elevation: 8 },
        }),
    },
    glassBorder: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: LENS_HEIGHT / 2,
        opacity: 0.8,
    },
    lensInner: {
        position: 'absolute',
        top: 1, // thinner border
        left: 1,
        right: 1,
        bottom: 1,
        borderRadius: (LENS_HEIGHT - 2) / 2,
        overflow: 'hidden',
    },
    specularHighlight: {
        position: 'absolute',
        top: 2, // slightly down
        left: '10%',
        width: '80%',
        height: '35%',
        borderRadius: 20,
        backgroundColor: 'rgba(255, 255, 255, 0.2)', // Top sheen
        transform: [{ scaleY: 0.5 }],
    },
});
