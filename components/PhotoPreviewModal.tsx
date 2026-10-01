import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

interface PhotoPreviewModalProps {
    photo: { uri: string } | null;
    onClose: () => void;
}

/** Preview only: all dismissal paths leave the organizing decision intact. */
export function PhotoPreviewModal({ photo, onClose }: PhotoPreviewModalProps) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const insets = useSafeAreaInsets();

    return (
        <Modal visible={!!photo} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
            <View accessibilityViewIsModal testID="photo-preview" style={[styles.container, {
                backgroundColor: colors.background,
                paddingTop: insets.top + 8,
                paddingBottom: insets.bottom,
                paddingLeft: insets.left,
                paddingRight: insets.right,
            }]}>
                <View style={styles.header}>
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('photo_detail_title')}</Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('close')}
                        onPress={onClose}
                        style={({ pressed }) => [styles.close, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                    >
                        <Ionicons name="close-outline" size={24} color={colors.text} />
                    </Pressable>
                </View>
                <Pressable testID="photo-preview-touch-area" accessible={false} style={styles.media} onPress={onClose}>
                    {photo && <Image source={{ uri: photo.uri }} accessibilityRole="image" accessibilityLabel={t('photo_detail_title')} style={styles.image} resizeMode="contain" />}
                </Pressable>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    header: { paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
    title: { ...TYPOGRAPHY.sectionTitle, flex: 1, minWidth: 0 },
    close: { width: UI_METRICS.touchTarget, height: UI_METRICS.touchTarget, flexShrink: 0, borderRadius: UI_METRICS.buttonRadius, alignItems: 'center', justifyContent: 'center' },
    media: { flex: 1, minHeight: 0 },
    image: { width: '100%', height: '100%' },
});
