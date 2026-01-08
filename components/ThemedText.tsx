import React from 'react';
import { Text as RNText, StyleSheet, TextProps } from 'react-native';
import { useThemeColor } from '../hooks/useThemeColor';

interface ThemedTextProps extends TextProps {
    /**
     * Whether to use theme text color. Default: true
     */
    themed?: boolean;
}

/**
 * A Text component that automatically applies theme colors.
 */
export function ThemedText({
    themed = true,
    style,
    ...props
}: ThemedTextProps) {
    const { colors } = useThemeColor();

    return (
        <RNText
            style={[
                themed && { color: colors.text },
                style,
            ]}
            {...props}
        />
    );
}

/**
 * Preset text styles for common use cases
 */
export const ThemedTextStyles = StyleSheet.create({
    pageTitle: {
        fontSize: 28,
        fontWeight: 'bold',
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
    },
    label: {
        fontSize: 16,
        fontWeight: '500',
    },
    body: {
        fontSize: 15,
        lineHeight: 22,
    },
    caption: {
        fontSize: 12,
    },
    button: {
        fontSize: 16,
        fontWeight: '600',
    },
});
