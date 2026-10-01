/**
 * Introduce scanning without starting work until the user explicitly agrees.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { BottomSheet } from './BottomSheet';

interface AIScanGuideModalProps {
    visible: boolean;
    onStartScan: () => void;
    onDismiss: () => void;
}

export function AIScanGuideModal({ visible, onStartScan, onDismiss }: AIScanGuideModalProps) {
    const { colors } = useThemeColor();
    const { t } = useI18n();

    return (
        <BottomSheet
            visible={visible}
            title={t('ai_guide_title')}
            onClose={onDismiss}
            closeLabel={t('ai_guide_close')}
            dismissOnBackdrop={false}
            footer={
                <View style={styles.actions}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('ai_guide_start')}
                        style={({ pressed }) => [styles.button, { backgroundColor: colors.actionBackground, opacity: pressed ? 0.8 : 1 }]}
                        onPress={onStartScan}
                    >
                        <Text style={[styles.buttonText, { color: colors.actionForeground }]}>{t('ai_guide_start')}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('ai_guide_dismiss')}
                        style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                        onPress={onDismiss}
                    >
                        <Text style={[styles.buttonText, { color: colors.textSecondary }]}>{t('ai_guide_dismiss')}</Text>
                    </Pressable>
                </View>
            }
        >
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
                <Text style={[styles.message, { color: colors.textSecondary }]}>{t('ai_guide_message')}</Text>
                <Text style={[styles.message, { color: colors.textSecondary }]}>{t('ai_guide_classification_hint')}</Text>
                <Text style={[styles.privacy, { color: colors.textSecondary }]}>{t('ai_guide_privacy')}</Text>
            </ScrollView>
        </BottomSheet>
    );
}

const styles = StyleSheet.create({
    scroll: { flexShrink: 1 },
    content: { gap: 16, paddingBottom: 8 },
    message: { ...TYPOGRAPHY.body },
    privacy: { ...TYPOGRAPHY.secondary },
    actions: { gap: 8 },
    button: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 16, paddingVertical: 14, justifyContent: 'center' },
    buttonText: { ...TYPOGRAPHY.button, textAlign: 'center' },
});
