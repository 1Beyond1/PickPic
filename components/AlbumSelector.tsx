import { Ionicons } from '@expo/vector-icons';
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
    maxSelection?: number; // Optional max selection limit
    titleKey?: string; // Optional custom title key
}

export const AlbumSelector: React.FC<AlbumSelectorProps> = ({
    visible,
    onClose,
    onConfirm,
    initialSelection = [],
    maxSelection,
    titleKey = 'album_selector_title',
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
        } else if (!maxSelection || selectedIds.length < maxSelection) {
            setSelectedIds([...selectedIds, id]);
        }
    };

    const handleClearAll = () => {
        setSelectedIds([]);
    };

    return (
        <Modal visible={visible} transparent animationType="slide">
            <View style={styles.modalContainer}>
                <View style={[styles.contentContainer, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
                    <View style={styles.header}>
                        <Text style={[styles.title, { color: colors.text }]}>{t(titleKey as any)}</Text>
                        <Pressable onPress={onClose}>
                            <Ionicons name="close" size={24} color={colors.textSecondary} />
                        </Pressable>
                    </View>

                    {/* Clear selection button */}
                    {selectedIds.length > 0 && (
                        <Pressable style={styles.clearButton} onPress={handleClearAll}>
                            <Text style={[styles.clearButtonText, { color: colors.textSecondary }]}>
                                {t('album_filter_all' as any)}
                            </Text>
                        </Pressable>
                    )}

                    <FlatList
                        data={albums}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={styles.listContent}
                        renderItem={({ item }) => {
                            const isSelected = selectedIds.includes(item.id);
                            const isDisabled = !!(maxSelection && selectedIds.length >= maxSelection && !isSelected);
                            return (
                                <Pressable
                                    style={[
                                        styles.item,
                                        { backgroundColor: colors.surface },
                                        isSelected && { borderColor: colors.primary, borderWidth: 1, backgroundColor: 'rgba(151, 115, 78, 0.15)' },
                                        isDisabled && styles.itemDisabled
                                    ]}
                                    onPress={() => toggleSelection(item.id)}
                                    disabled={isDisabled ? true : false}
                                >
                                    <Text style={[styles.itemText, { color: colors.textSecondary }, isSelected && { color: colors.text, fontWeight: '500' }]}>
                                        {item.title}
                                    </Text>
                                    <Text style={[styles.itemCount, { color: colors.textSecondary }]}>{item.assetCount}</Text>
                                    {isSelected && (
                                        <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                                    )}
                                </Pressable>
                            );
                        }}
                    />

                    <Pressable
                        style={[styles.confirmButton, { backgroundColor: colors.primary }]}
                        onPress={() => onConfirm(selectedIds)}
                    >
                        <Text style={styles.confirmButtonText}>{t('confirm')}</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    modalContainer: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    contentContainer: {
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
    clearButton: {
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        marginBottom: SPACING.s,
    },
    clearButtonText: {
        fontSize: 14,
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
