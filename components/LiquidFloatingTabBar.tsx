import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

const BAR_HEIGHT = 65;
const TABS = [
    { name: 'photos', icon: 'images-outline', labelKey: 'tab_photos', path: '/(tabs)/photos' },
    { name: 'videos', icon: 'videocam-outline', labelKey: 'tab_videos', path: '/(tabs)/videos' },
    { name: 'scanResults', icon: 'scan-outline', labelKey: 'tab_scan_results', path: '/(tabs)/scanResults' },
    { name: 'settings', icon: 'options-outline', labelKey: 'tab_settings', path: '/(tabs)/settings' },
] as const;

export const LiquidFloatingTabBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { width } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const tabWidth = width / TABS.length;
    const lensWidth = Math.min(42, tabWidth - 16);
    const activeIndex = TABS.findIndex(tab => pathname.includes(tab.name));
    const safeIndex = activeIndex >= 0 ? activeIndex : 0;
    const lensX = useSharedValue(safeIndex * tabWidth + (tabWidth - lensWidth) / 2);
    const startX = useSharedValue(0);
    const lastPosition = useRef({ index: safeIndex, tabWidth });

    useEffect(() => {
        if (lastPosition.current.index !== safeIndex || lastPosition.current.tabWidth !== tabWidth) {
            lensX.value = withTiming(safeIndex * tabWidth + (tabWidth - lensWidth) / 2, { duration: 180 });
            lastPosition.current = { index: safeIndex, tabWidth };
        }
    }, [safeIndex, tabWidth, lensWidth, lensX]);

    const navigateTo = (index: number) => {
        if (index !== safeIndex) router.navigate(TABS[index].path as any);
    };

    // Keep the existing gesture for switching tabs while changing only its
    // visual surface from a floating pill to a full-width navigation bar.
    const panGesture = Gesture.Pan()
        .onStart(() => { startX.value = lensX.value; })
        .onUpdate((event) => {
            const minX = (tabWidth - lensWidth) / 2;
            const maxX = (TABS.length - 1) * tabWidth + minX;
            lensX.value = Math.max(minX, Math.min(maxX, startX.value + event.translationX));
        })
        .onEnd(() => {
            const target = Math.max(0, Math.min(
                TABS.length - 1,
                Math.floor((lensX.value + lensWidth / 2) / tabWidth),
            ));
            lensX.value = withTiming(target * tabWidth + (tabWidth - lensWidth) / 2, { duration: 180 });
            if (target !== safeIndex) runOnJS(navigateTo)(target);
        });

    const lensStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: lensX.value }],
    }));

    return (
        <View style={[styles.container, {
            height: BAR_HEIGHT + insets.bottom,
            paddingBottom: insets.bottom,
            backgroundColor: colors.background,
            borderTopColor: colors.divider,
        }]}>
            <GestureDetector gesture={panGesture}>
                <View style={styles.row}>
                    {TABS.map((tab, index) => {
                        const selected = index === safeIndex;
                        return (
                            <Pressable
                                key={tab.name}
                                accessibilityRole="tab"
                                accessibilityState={{ selected }}
                                style={[styles.tab, { width: tabWidth }]}
                                onPress={() => navigateTo(index)}
                            >
                                <Ionicons
                                    name={tab.icon}
                                    size={21}
                                    color={selected ? colors.text : colors.textTertiary}
                                />
                                <Text style={[styles.label, {
                                    color: selected ? colors.text : colors.textSecondary,
                                    fontWeight: selected ? '600' : '400',
                                }]}>
                                    {t(tab.labelKey)}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </GestureDetector>
            <Animated.View pointerEvents="none" style={[styles.lens, lensStyle, {
                width: lensWidth,
                backgroundColor: colors.selectionBackground,
            }]} />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 100,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    row: {
        height: BAR_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        zIndex: 1,
    },
    tab: {
        height: BAR_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        zIndex: 1,
    },
    label: {
        fontSize: 11,
    },
    lens: {
        position: 'absolute',
        top: 7,
        left: 0,
        height: 29,
        borderRadius: 11,
        zIndex: 0,
    },
});
