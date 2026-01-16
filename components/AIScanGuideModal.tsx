/**
 * AIScanGuideModal - Welcome modal to introduce AI scanning feature
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BORDER_RADIUS, SPACING } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface AIScanGuideModalProps {
    visible: boolean;
    onStartScan: () => void;
    onDismiss: () => void;
}

export function AIScanGuideModal({ visible, onStartScan, onDismiss }: AIScanGuideModalProps) {
    const insets = useSafeAreaInsets();
    const { colors, isDark } = useThemeColor();
    const { t } = useI18n();

    return (
        <Modal visible={visible} transparent animationType="fade">
            <View style={styles.overlay}>
                <View style={[styles.modalBackground, { backgroundColor: colors.surface }]}>
                    {/* Header */}
                    <View style={styles.header}>
                        <View style={[styles.iconContainer, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F0F9FF' }]}>
                            <Ionicons name="search" size={32} color={colors.primary} />
                        </View>
                        <Text style={[styles.title, { color: colors.text }]}>{t('ai_guide_title' as any)}</Text>
                    </View>

                    {/* Content */}
                    <View style={styles.content}>
                        <Text style={[styles.message, { color: colors.textSecondary }]}>
                            {t('ai_guide_message' as any)}
                        </Text>

                        {/* Prominent Hint */}
                        <View style={[styles.hintBox, { backgroundColor: isDark ? 'rgba(255, 193, 7, 0.15)' : '#FFF8E1' }]}>
                            <Text style={[styles.hintText, { color: isDark ? '#FFD54F' : '#F57F17' }]}>
                                {t('ai_guide_classification_hint' as any)}
                            </Text>
                        </View>

                        <View style={[styles.privacyBox, { backgroundColor: isDark ? 'rgba(76, 175, 80, 0.1)' : '#E8F5E9' }]}>
                            <Text style={[styles.privacyText, { color: isDark ? '#4CAF50' : '#2E7D32' }]}>
                                {t('ai_guide_privacy' as any)}
                            </Text>
                        </View>
                    </View>

                    {/* Buttons */}
                    <View style={styles.buttonContainer}>
                        <Pressable
                            style={[styles.button, styles.primaryButton, { backgroundColor: colors.primary }]}
                            onPress={onStartScan}
                        >
                            <Text style={styles.primaryButtonText}>{t('ai_guide_start' as any)}</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.button, styles.secondaryButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F5F5F5' }]}
                            onPress={onDismiss}
                        >
                            <Text style={[styles.secondaryButtonText, { color: colors.textSecondary }]}>{t('ai_guide_dismiss' as any)}</Text>
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
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 20,
    },
    modalBackground: {
        width: Math.min(SCREEN_WIDTH - 40, 420),
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.l,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 12,
    },
    header: {
        alignItems: 'center',
        marginBottom: SPACING.l,
    },
    iconContainer: {
        width: 72,
        height: 72,
        borderRadius: 36,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    title: {
        fontSize: 22,
        fontWeight: 'bold',
        textAlign: 'center',
    },
    content: {
        marginBottom: SPACING.l,
    },
    message: {
        fontSize: 15,
        lineHeight: 22,
        textAlign: 'center',
        marginBottom: SPACING.m,
    },
    privacyBox: {
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
    },
    privacyText: {
        fontSize: 14,
        fontWeight: '600',
        textAlign: 'center',
    },
    hintBox: {
        marginBottom: SPACING.m,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: 'rgba(255, 193, 7, 0.3)',
    },
    hintText: {
        fontSize: 13,
        fontWeight: 'bold',
        textAlign: 'center',
        lineHeight: 18,
    },
    buttonContainer: {
        gap: SPACING.s,
    },
    button: {
        paddingVertical: 14,
        borderRadius: BORDER_RADIUS.m,
        alignItems: 'center',
    },
    primaryButton: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    primaryButtonText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: '600',
    },
    secondaryButton: {},
    secondaryButtonText: {
        fontSize: 15,
        fontWeight: '500',
    },
});
