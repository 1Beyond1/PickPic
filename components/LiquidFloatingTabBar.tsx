import { Ionicons } from '@expo/vector-icons';
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

const TAB_BAR_WIDTH = SCREEN_WIDTH * 0.88;
const TAB_COUNT = 3;
const TAB_WIDTH = TAB_BAR_WIDTH / TAB_COUNT;
const BAR_HEIGHT = 60;
const LENS_WIDTH = TAB_WIDTH - 12;
const LENS_HEIGHT = BAR_HEIGHT - 12;

const TABS = [
    { name: 'photos', icon: 'images', labelKey: 'tab_photos', path: '/(tabs)/photos' },
    { name: 'videos', icon: 'videocam', labelKey: 'tab_videos', path: '/(tabs)/videos' },
    { name: 'settings', icon: 'settings-sharp', labelKey: 'tab_settings', path: '/(tabs)/settings' },
];

export const LiquidFloatingTabBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { isDark, colors } = useThemeColor();
    const { t } = useI18n();

    const activeIndex = TABS.findIndex(tab => pathname.includes(tab.name));
    const safeIndex = activeIndex >= 0 ? activeIndex : 0;


    const lensX = useSharedValue(safeIndex * TAB_WIDTH + (TAB_WIDTH - LENS_WIDTH) / 2);
    const startX = useSharedValue(0);
    const lastIndex = useRef(safeIndex);

    useEffect(() => {
        if (lastIndex.current !== safeIndex) {
            lensX.value = withTiming(safeIndex * TAB_WIDTH + (TAB_WIDTH - LENS_WIDTH) / 2, { duration: 200 });
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
            lensX.value = withTiming(targetX, { duration: 180 });

            if (clampedIndex !== safeIndex) {
                runOnJS(navigateTo)(clampedIndex);
            }
        });

    const lensStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: lensX.value }],
    }));

    // Use colors from theme hook (will be orange for Warm Terra, blue for Light/Dark)
    const bgColor = isDark ? colors.surface : colors.white;
    const activeColor = colors.primary;
    const inactiveColor = colors.textTertiary;
    const borderColor = colors.border;

    return (
        <View style={styles.container}>
            {/* Background Pill - Warm Terra clean white/dark */}
            <View style={[styles.backgroundPill, {
                backgroundColor: bgColor,
                borderColor: borderColor,
            }]}>
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
                                    size={22}
                                    color={isActive ? activeColor : inactiveColor}
                                />
                                <Text style={[
                                    styles.label,
                                    {
                                        color: isActive ? activeColor : inactiveColor,
                                        fontWeight: '500',
                                    }
                                ]}>
                                    {t(tab.labelKey as any)}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
            </View>

            {/* Selection Lens - uses theme accent color */}
            <GestureDetector gesture={panGesture}>
                <Animated.View style={[styles.lens, lensStyle, {
                    backgroundColor: `${activeColor}15`,
                    borderColor: activeColor,
                }]} />
            </GestureDetector>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        bottom: 28,
        alignSelf: 'center',
        zIndex: 100,
    },
    backgroundPill: {
        width: TAB_BAR_WIDTH,
        height: BAR_HEIGHT,
        borderRadius: BAR_HEIGHT / 2,
        overflow: 'hidden',
        borderWidth: 1,
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.06,
                shadowRadius: 8,
            },
            android: { elevation: 3 },
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
        fontSize: 11,
        marginTop: 2,
        fontWeight: '500',
        letterSpacing: 0.2,
    },
    lens: {
        position: 'absolute',
        width: LENS_WIDTH,
        height: LENS_HEIGHT,
        borderRadius: LENS_HEIGHT / 2,
        top: 6,
        left: 0,
        borderWidth: 1.5,
    },
});
