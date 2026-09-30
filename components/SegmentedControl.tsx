import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemeColor } from '../hooks/useThemeColor';

interface SegmentedControlProps<T extends string | number> {
    label: string;
    value: T;
    options: readonly { value: T; label: string }[];
    onChange: (value: T) => void;
}

/** One quiet surface, with a distinct selected segment in either theme. */
export function SegmentedControl<T extends string | number>({ label, value, options, onChange }: SegmentedControlProps<T>) {
    const { colors } = useThemeColor();
    return (
        <View accessibilityLabel={label} style={[styles.track, { backgroundColor: colors.surfaceHover }]}>
            {options.map(option => {
                const selected = option.value === value;
                return (
                    <Pressable
                        key={option.value}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{ checked: selected }}
                        onPress={() => onChange(option.value)}
                        style={({ pressed }) => [styles.segment, {
                            backgroundColor: selected ? colors.actionBackground : 'transparent',
                            opacity: pressed ? 0.75 : 1,
                        }]}
                    >
                        <Text style={[styles.label, {
                            color: selected ? colors.actionForeground : colors.textSecondary,
                            fontWeight: selected ? '500' : '400',
                        }]}>{option.label}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    track: { width: '100%', flexDirection: 'row', borderRadius: 14, padding: 3 },
    segment: { flex: 1, minHeight: 44, borderRadius: 11, paddingHorizontal: 8, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
    label: { fontSize: 13, textAlign: 'center' },
});
