import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { APP_VERSION } from '../stores/useSettingsStore';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface AnnouncementModalProps {
    visible: boolean;
    onDismissOnce: () => void;
    onDismissForVersion: () => void;
}

export function AnnouncementModal({ visible, onDismissOnce, onDismissForVersion }: AnnouncementModalProps) {
    const insets = useSafeAreaInsets();
    const { t } = useI18n();

    return (
        <Modal visible={visible} transparent animationType="fade">
            <View style={styles.overlay}>
                <View style={styles.modalBackground}>
                    <ScrollView
                        style={styles.scrollView}
                        contentContainerStyle={styles.scrollContent}
                        showsVerticalScrollIndicator={false}
                    >
                        {/* Header */}
                        <View style={styles.header}>
                            <Ionicons name="information-circle" size={48} color={COLORS.primary} />
                            <Text style={styles.title}>{t('announcement_title')}</Text>
                            <Text style={styles.version}>{APP_VERSION}</Text>
                        </View>

                        {/* Content */}
                        <View style={styles.content}>
                            <Text style={styles.sectionTitle}>📢 {t('announcement_notice_title')}</Text>

                            <View style={styles.noticeItem}>
                                <Ionicons name="alert-circle" size={20} color={COLORS.warning} />
                                <Text style={styles.noticeText}>{t('announcement_notice_1')}</Text>
                            </View>

                            <View style={styles.noticeItem}>
                                <Ionicons name="cloud-outline" size={20} color={COLORS.primary} />
                                <Text style={styles.noticeText}>{t('announcement_notice_2')}</Text>
                            </View>

                            <View style={styles.noticeItem}>
                                <Ionicons name="construct-outline" size={20} color={COLORS.textSecondary} />
                                <Text style={styles.noticeText}>{t('announcement_notice_3')}</Text>
                            </View>

                            <View style={styles.divider} />

                            <Text style={styles.sectionTitle}>👨‍💻 {t('announcement_author_title')}</Text>
                            <View style={styles.authorRow}>
                                <Ionicons name="logo-github" size={24} color="#FFF" />
                                <Text style={styles.authorText}>1Beyond1</Text>
                            </View>
                            <Text style={styles.followHint}>{t('github_follow')}</Text>
                        </View>
                    </ScrollView>

                    {/* Buttons */}
                    <View style={styles.buttonContainer}>
                        <Pressable
                            style={[styles.button, styles.secondaryButton]}
                            onPress={onDismissOnce}
                        >
                            <Text style={styles.secondaryButtonText}>{t('announcement_close_once')}</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.button, styles.primaryButton]}
                            onPress={onDismissForVersion}
                        >
                            <Text style={styles.primaryButtonText}>{t('announcement_close_version')}</Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)',
    },
    modalBackground: {
        width: SCREEN_WIDTH - 40,
        maxHeight: SCREEN_HEIGHT * 0.75,
        backgroundColor: '#1E1E1E', // Solid dark background since we can't use BlurView safely without native rebuild
        borderRadius: BORDER_RADIUS.xl,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    scrollView: {
        // flex: 1, // Removed to allow content to determine height (fixed empty modal issue)
        width: '100%',
    },
    scrollContent: {
        padding: SPACING.l,
    },
    header: {
        alignItems: 'center',
        marginBottom: SPACING.l,
    },
    title: {
        fontSize: 22,
        fontWeight: 'bold',
        color: '#FFF',
        marginTop: SPACING.m,
    },
    version: {
        fontSize: 14,
        color: COLORS.primary,
        marginTop: 4,
        fontWeight: '600',
    },
    content: {
        marginBottom: SPACING.m,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#FFF',
        marginBottom: SPACING.m,
    },
    noticeItem: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: SPACING.m,
        gap: 10,
    },
    noticeText: {
        flex: 1,
        fontSize: 14,
        color: 'rgba(255,255,255,0.8)',
        lineHeight: 20,
    },
    highlight: {
        color: COLORS.warning,
        fontWeight: '600',
    },
    divider: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.1)',
        marginVertical: SPACING.l,
    },
    authorRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginBottom: 8,
    },
    authorText: {
        fontSize: 16,
        color: '#FFF',
        fontWeight: '600',
    },
    followHint: {
        fontSize: 12,
        color: 'rgba(255,255,255,0.5)',
    },
    buttonContainer: {
        flexDirection: 'row',
        gap: 12,
        padding: SPACING.m,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
    },
    button: {
        flex: 1,
        paddingVertical: 14,
        borderRadius: BORDER_RADIUS.m,
        alignItems: 'center',
    },
    secondaryButton: {
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    secondaryButtonText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 14,
        fontWeight: '500',
    },
    primaryButton: {
        backgroundColor: COLORS.primary,
    },
    primaryButtonText: {
        color: '#FFF',
        fontSize: 14,
        fontWeight: '600',
    },
});
