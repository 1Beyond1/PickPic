import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

export function PhotoReadFeedback({ onRetry }: { onRetry: () => void }) {
    const { t } = useI18n();
    const { colors } = useThemeColor();
    return (
        <ScrollView contentContainerStyle={styles.content}>
            <Text accessibilityRole="alert" style={[styles.message, { color: colors.textSecondary }]}>{t('scan_photo_unavailable')}</Text>
            <Pressable accessibilityRole="button" onPress={onRetry} style={[styles.retry, { backgroundColor: colors.actionBackground }]}>
                <Text style={[styles.retryText, { color: colors.actionForeground }]}>{t('retry')}</Text>
            </Pressable>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    content: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: UI_METRICS.pageInset, gap: 20 },
    message: { ...TYPOGRAPHY.body, textAlign: 'center' },
    retry: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 24, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
    retryText: { ...TYPOGRAPHY.button },
});
