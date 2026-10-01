import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';
import { BottomSheet } from './BottomSheet';

interface SettingsChoiceSheetProps {
    visible: boolean;
    title: string;
    value: string;
    options: readonly { value: string; label: string }[];
    onSelect: (value: string) => void;
    onClose: () => void;
}

export function SettingsChoiceSheet({ visible, title, value, options, onSelect, onClose }: SettingsChoiceSheetProps) {
    const { colors } = useThemeColor();
    return (
        <BottomSheet visible={visible} title={title} onClose={onClose}>
            <ScrollView style={styles.list}>
                {options.map(option => {
                    const selected = option.value === value;
                    return <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: selected }} onPress={() => onSelect(option.value)} style={({ pressed }) => [styles.option, { backgroundColor: pressed || selected ? colors.surfaceHover : 'transparent' }]}>
                        <Text style={[styles.optionLabel, { color: colors.text, fontWeight: selected ? '500' : '400' }]}>{option.label}</Text>
                        {selected ? <Feather name="check" size={20} color={colors.text} /> : null}
                    </Pressable>;
                })}
            </ScrollView>
        </BottomSheet>
    );
}

const styles = StyleSheet.create({
    list: { flexGrow: 0, flexShrink: 1 },
    option: { minHeight: UI_METRICS.rowHeight, paddingHorizontal: 12, paddingVertical: 14, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
    optionLabel: { ...TYPOGRAPHY.body, flex: 1 },
});
