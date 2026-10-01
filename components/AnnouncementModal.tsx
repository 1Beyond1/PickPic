import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { APP_VERSION } from '../stores/useSettingsStore';
import { BottomSheet } from './BottomSheet';

interface AnnouncementModalProps {
    visible: boolean;
    onDismissOnce: () => void;
    onDismissForVersion: () => void;
}

export function AnnouncementModal({ visible, onDismissOnce, onDismissForVersion }: AnnouncementModalProps) {
    const { t } = useI18n();
    const { colors } = useThemeColor();

    return (
        <BottomSheet
            visible={visible}
            title={t('announcement_title')}
            onClose={onDismissOnce}
            closeLabel={t('close')}
            dismissOnBackdrop={false}
            footer={
                <View style={styles.actions}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('announcement_close_once')}
                        style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                        onPress={onDismissOnce}
                    >
                        <Text style={[styles.buttonText, { color: colors.textSecondary }]}>{t('announcement_close_once')}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('announcement_close_version')}
                        style={({ pressed }) => [styles.button, { backgroundColor: colors.actionBackground, opacity: pressed ? 0.8 : 1 }]}
                        onPress={onDismissForVersion}
                    >
                        <Text style={[styles.buttonText, { color: colors.actionForeground }]}>{t('announcement_close_version')}</Text>
                    </Pressable>
                </View>
            }
        >
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
                <Text style={[styles.version, { color: colors.textSecondary }]}>{APP_VERSION}</Text>
                <View style={styles.section}>
                    <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>{t('announcement_notice_title')}</Text>
                    <Text style={[styles.notice, { color: colors.text }]}>{t('announcement_notice_1')}</Text>
                    <Text style={[styles.body, { color: colors.textSecondary }]}>{t('announcement_notice_2')}</Text>
                    <Text style={[styles.body, { color: colors.textSecondary }]}>{t('announcement_notice_3')}</Text>
                </View>
                <View style={[styles.section, styles.divided, { borderColor: colors.divider }]}>
                    <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>{t('announcement_update_title')}</Text>
                    <Text style={[styles.body, { color: colors.textSecondary }]}>{t('update_v030_1')}</Text>
                    <Text style={[styles.body, { color: colors.textSecondary }]}>{t('update_v030_2')}</Text>
                    <Text style={[styles.body, { color: colors.textSecondary }]}>{t('update_v030_3')}</Text>
                </View>
                <View style={[styles.section, styles.divided, { borderColor: colors.divider }]}>
                    <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>{t('announcement_author_title')}</Text>
                    <Text style={[styles.author, { color: colors.text }]}>1Beyond1</Text>
                    <Text style={[styles.version, { color: colors.textSecondary }]}>{t('github_follow')}</Text>
                </View>
            </ScrollView>
        </BottomSheet>
    );
}

const styles = StyleSheet.create({
    scroll: { flexShrink: 1 },
    content: { paddingBottom: 8, gap: 20 },
    section: { gap: 12 },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 20 },
    sectionTitle: { ...TYPOGRAPHY.sectionTitle },
    notice: { ...TYPOGRAPHY.body, fontWeight: '500' },
    body: { ...TYPOGRAPHY.body },
    version: { ...TYPOGRAPHY.secondary },
    author: { ...TYPOGRAPHY.button },
    actions: { gap: 8 },
    button: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 16, paddingVertical: 14, justifyContent: 'center' },
    buttonText: { ...TYPOGRAPHY.button, textAlign: 'center' },
});
