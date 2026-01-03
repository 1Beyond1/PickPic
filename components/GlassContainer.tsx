import { BlurView } from 'expo-blur';
import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { BORDER_RADIUS, GLASS_EFFECT } from '../constants/theme';

interface GlassContainerProps {
    children: React.ReactNode;
    style?: ViewStyle;
    intensity?: number;
    tint?: 'light' | 'dark' | 'default';
    borderRadius?: number;
}

export const GlassContainer: React.FC<GlassContainerProps> = ({
    children,
    style,
    intensity = GLASS_EFFECT.intensity,
    tint = GLASS_EFFECT.tint as any,
    borderRadius = BORDER_RADIUS.l,
}) => {
    // Default background based on tint if not overridden by style
    // Tuned for Light Mode: more opaque white to stand out against off-white background
    const defaultBg = tint === 'light' ? 'rgba(255, 255, 255, 0.6)' : 'rgba(40, 40, 40, 0.3)';

    return (
        <View style={[styles.container, { borderRadius, backgroundColor: defaultBg }, style]}>
            <BlurView
                intensity={intensity}
                tint={tint}
                style={[StyleSheet.absoluteFill, { borderRadius }]}
            />
            <View style={styles.content}>{children}</View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    content: {
        zIndex: 1,
    },
});
