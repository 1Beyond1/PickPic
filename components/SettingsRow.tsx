import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemeColor } from '../hooks/useThemeColor';

interface SettingsRowProps {
    label: string;
    value?: string;
    detail?: string;
    onPress?: () => void;
    disabled?: boolean;
    danger?: boolean;
}

export function SettingsRow({ label, value, detail, onPress, disabled = false, danger = false }: SettingsRowProps) {
    const { colors } = useThemeColor();
    const content = <>
        <View style={styles.copy}>
            <Text style={[styles.label, { color: danger ? colors.danger : colors.text }]}>{label}</Text>
            {detail ? <Text style={[styles.detail, { color: colors.textSecondary }]}>{detail}</Text> : null}
        </View>
        {value || onPress ? <View style={styles.trailing}>
            {value ? <Text style={[styles.value, { color: colors.textSecondary }]}>{value}</Text> : null}
            {onPress ? <Feather name="chevron-right" size={17} color={colors.textTertiary} /> : null}
        </View> : null}
    </>;
    return onPress ? (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={value ? `${label}, ${value}` : label}
            accessibilityHint={detail}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surfaceHover : 'transparent', opacity: disabled ? 0.5 : 1 }]}
        >{content}</Pressable>
    ) : <View style={styles.row}>{content}</View>;
}

const styles = StyleSheet.create({
    row: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderRadius: 8 },
    copy: { flex: 1, minWidth: 0, gap: 5 },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: '55%', flexShrink: 1 },
    label: { fontSize: 15, lineHeight: 22 },
    detail: { fontSize: 12, lineHeight: 18 },
    value: { fontSize: 13, lineHeight: 20, flexShrink: 1 },
});
