import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

interface BottomSheetProps {
    visible: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
    closeLabel?: string;
    dismissOnBackdrop?: boolean;
}

/** A bounded native sheet. Callers own scrolling and all confirm/cancel semantics. */
export function BottomSheet({ visible, title, onClose, children, footer, closeLabel, dismissOnBackdrop = true }: BottomSheetProps) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={[styles.overlay, { backgroundColor: colors.overlay, paddingTop: insets.top + 16 }]}>
                {dismissOnBackdrop ? (
                    <Pressable
                        testID="sheet-backdrop"
                        accessibilityRole="button"
                        accessibilityLabel={t('cancel')}
                        onPress={onClose}
                        style={StyleSheet.absoluteFill}
                    />
                ) : <View testID="sheet-backdrop" style={StyleSheet.absoluteFill} />}
                <View accessibilityViewIsModal style={[styles.sheet, {
                    backgroundColor: colors.surface,
                    maxHeight: Math.max(0, height - insets.top - 16),
                    paddingLeft: UI_METRICS.pageInset + insets.left,
                    paddingRight: UI_METRICS.pageInset + insets.right,
                    paddingBottom: Math.max(20, insets.bottom + 12),
                }]}>
                    <View style={styles.header}>
                        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={closeLabel ?? t('cancel')}
                            onPress={onClose}
                            style={({ pressed }) => [styles.close, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                        >
                            <Feather name="x" size={20} color={colors.textSecondary} />
                        </Pressable>
                    </View>
                    {children}
                    {footer ? <View style={styles.footer}>{footer}</View> : null}
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    sheet: { flexShrink: 1, paddingTop: 16, borderTopLeftRadius: UI_METRICS.sheetRadius, borderTopRightRadius: UI_METRICS.sheetRadius },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
    title: { ...TYPOGRAPHY.sheetTitle, flex: 1, minWidth: 0 },
    close: { width: UI_METRICS.touchTarget, height: UI_METRICS.touchTarget, flexShrink: 0, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    footer: { paddingTop: 16 },
});
