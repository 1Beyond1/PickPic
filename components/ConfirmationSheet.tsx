import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { BottomSheet } from './BottomSheet';

interface ConfirmationSheetProps {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
    onCancel: () => void;
    onConfirm: () => void;
    destructive?: boolean;
    confirmDisabled?: boolean;
    hideActions?: boolean;
}

/** Presentation only: the caller owns confirmation, locks and persistence. */
export function ConfirmationSheet({ title, message, confirmLabel, cancelLabel, onCancel, onConfirm, destructive = false, confirmDisabled = false, hideActions = false }: ConfirmationSheetProps) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const cancel = cancelLabel ?? t('cancel');
    return (
        <BottomSheet
            visible
            title={title}
            onClose={onCancel}
            closeLabel={cancel}
            dismissOnBackdrop={false}
            footer={hideActions ? undefined : (
                <View style={styles.actions}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={cancel}
                        onPress={onCancel}
                        style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                    >
                        <Text style={[styles.buttonText, { color: colors.textSecondary }]}>{cancel}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={confirmLabel}
                        accessibilityState={{ disabled: confirmDisabled }}
                        disabled={confirmDisabled}
                        onPress={onConfirm}
                        style={({ pressed }) => [styles.button, {
                            backgroundColor: destructive ? colors.dangerBackground : colors.actionBackground,
                            opacity: confirmDisabled ? 0.5 : pressed ? 0.8 : 1,
                        }]}
                    >
                        <Text style={[styles.buttonText, { color: destructive ? colors.dangerForeground : colors.actionForeground }]}>{confirmLabel}</Text>
                    </Pressable>
                </View>
            )}
        >
            {message ? <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
                <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>
            </ScrollView> : null}
        </BottomSheet>
    );
}

const styles = StyleSheet.create({
    scroll: { flexShrink: 1 },
    content: { paddingBottom: 8 },
    message: { ...TYPOGRAPHY.body },
    actions: { gap: 8 },
    button: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 16, paddingVertical: 14, justifyContent: 'center' },
    buttonText: { ...TYPOGRAPHY.button, textAlign: 'center' },
});
