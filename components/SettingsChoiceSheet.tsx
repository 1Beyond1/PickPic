import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

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
    const { t } = useI18n();
    const insets = useSafeAreaInsets();
    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={[styles.overlay, { backgroundColor: colors.overlay }]}>
                <View style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: Math.max(24, insets.bottom + 12) }]}>
                    <View style={styles.header}>
                        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('cancel')} onPress={onClose} style={[styles.close, { backgroundColor: colors.surfaceHover }]}>
                            <Feather name="x" size={19} color={colors.textSecondary} />
                        </Pressable>
                    </View>
                    <ScrollView>
                        {options.map(option => {
                            const selected = option.value === value;
                            return <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: selected }} onPress={() => onSelect(option.value)} style={({ pressed }) => [styles.option, { backgroundColor: pressed || selected ? colors.surfaceHover : 'transparent' }]}>
                                <Text style={[styles.optionLabel, { color: colors.text }]}>{option.label}</Text>
                                {selected ? <Feather name="check" size={20} color={colors.text} /> : null}
                            </Pressable>;
                        })}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    sheet: { padding: 24, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '80%' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 16 },
    title: { flex: 1, fontSize: 20, lineHeight: 28, fontWeight: '500' },
    close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    option: { minHeight: 54, padding: 14, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
    optionLabel: { flex: 1, fontSize: 16, lineHeight: 24 },
});
