import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import React, { useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { useMediaStore } from '../stores/useMediaStore';

interface AlbumSelectorProps {
    visible: boolean;
    onClose: () => void;
    onConfirm: (selectedIds: string[]) => void;
    initialSelection?: string[];
}

export const AlbumSelector: React.FC<AlbumSelectorProps> = ({
    visible,
    onClose,
    onConfirm,
    initialSelection = [],
}) => {
    const { albums, loadAlbums } = useMediaStore();
    const [selectedIds, setSelectedIds] = useState<string[]>(initialSelection);
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();

    useEffect(() => {
        if (visible) {
            loadAlbums();
            setSelectedIds(initialSelection);
        }
    }, [visible]);

    const toggleSelection = (id: string) => {
        if (selectedIds.includes(id)) {
            setSelectedIds(selectedIds.filter((item) => item !== id));
        } else {
            setSelectedIds([...selectedIds, id]);
        }
    };

    return (
        <Modal visible={visible} transparent animationType="slide">
            <View style={styles.modalContainer}>
                {/* Increased intensity and added backgroundColor for better visibility */}
                <BlurView intensity={100} tint={isDark ? 'systemThickMaterialDark' : 'systemThickMaterialLight'} style={[styles.blurContainer, { backgroundColor: isDark ? 'rgba(30,30,30,0.9)' : 'rgba(255,255,255,0.9)' }]}>
                    <View style={styles.header}>
                        <Text style={[styles.title, { color: colors.text }]}>{t('album_select_title')}</Text>
                        <Pressable onPress={onClose}>
                            <Ionicons name="close" size={24} color={colors.textSecondary} />
                        </Pressable>
                    </View>

                    <FlatList
                        data={albums}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={styles.listContent}
                        renderItem={({ item }) => {
                            const isSelected = selectedIds.includes(item.id);
                            return (
                                <Pressable
                                    style={[
                                        styles.item,
                                        { backgroundColor: colors.surface },
                                        isSelected && { borderColor: COLORS.primary, borderWidth: 1, backgroundColor: 'rgba(10, 132, 255, 0.15)' },
                                        selectedIds.length >= 4 && !isSelected && styles.itemDisabled
                                    ]}
                                    onPress={() => toggleSelection(item.id)}
                                >
                                    <Text style={[styles.itemText, { color: colors.textSecondary }, isSelected && { color: colors.text, fontWeight: '500' }]}>
                                        {item.title}
                                    </Text>
                                    <Text style={[styles.itemCount, { color: colors.textSecondary }]}>{item.assetCount}</Text>
                                    {isSelected && (
                                        <Ionicons name="checkmark-circle" size={20} color={COLORS.primary} />
                                    )}
                                </Pressable>
                            );
                        }}
                    />

                    <Pressable
                        style={styles.confirmButton}
                        onPress={() => onConfirm(selectedIds)}
                    >
                        <Text style={styles.confirmButtonText}>{t('confirm')}</Text>
                    </Pressable>
                </BlurView>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    modalContainer: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    blurContainer: {
        height: '70%',
        borderTopLeftRadius: BORDER_RADIUS.xl,
        borderTopRightRadius: BORDER_RADIUS.xl,
        padding: SPACING.m,
        overflow: 'hidden'
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: SPACING.m,
        paddingHorizontal: SPACING.s,
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
    },
    listContent: {
        paddingBottom: SPACING.xl,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderRadius: BORDER_RADIUS.m,
    },
    itemDisabled: {
        opacity: 0.5
    },
    itemText: {
        flex: 1,
        fontSize: 16,
    },
    itemCount: {
        marginRight: SPACING.m,
        fontSize: 14,
    },
    confirmButton: {
        backgroundColor: COLORS.primary,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.full,
        alignItems: 'center',
        marginTop: SPACING.m,
        marginBottom: SPACING.l,
    },
    confirmButtonText: {
        color: COLORS.white,
        fontSize: 16,
        fontWeight: 'bold',
    },
});
