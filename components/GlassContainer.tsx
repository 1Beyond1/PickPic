import React from 'react';
import { Platform, StyleSheet, View, ViewStyle } from 'react-native';
import { BORDER_RADIUS, COLORS, COLORS_DARK } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';

interface CardContainerProps {
    children: React.ReactNode;
    style?: ViewStyle;
    borderRadius?: number;
    elevated?: boolean; // Warm Terra subtle elevation
}

// Warm Terra clean card container
export const GlassContainer: React.FC<CardContainerProps> = ({
    children,
    style,
    borderRadius = BORDER_RADIUS.l,
    elevated = true,
}) => {
    const { isDark } = useThemeColor();

    const backgroundColor = isDark ? COLORS_DARK.surface : COLORS.surface;
    const borderColor = isDark ? COLORS_DARK.border : COLORS.border;

    return (
        <View style={[
            styles.container,
            elevated && (isDark ? styles.shadowDark : styles.shadowLight),
            {
                borderRadius,
                backgroundColor,
                borderColor,
            },
            style
        ]}>
            {children}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        overflow: 'hidden',
        borderWidth: 1,
        padding: 16,
    },
    // Warm Terra subtle shadow for light mode
    shadowLight: {
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.04,
                shadowRadius: 3,
            },
            android: { elevation: 1 },
        }),
    },
    // Darker shadow for dark mode
    shadowDark: {
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.2,
                shadowRadius: 4,
            },
            android: { elevation: 2 },
        }),
    },
});
