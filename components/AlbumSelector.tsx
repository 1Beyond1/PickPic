import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { hasFullPhotoLibraryAccess, useMediaStore } from '../stores/useMediaStore';

const EMPTY_SELECTION: string[] = [];

interface AlbumSelectorProps {
    visible: boolean;
    onClose: () => void;
    onConfirm: (selectedIds: string[]) => void;
    initialSelection?: string[];
    maxSelection?: number; // Optional max selection limit
    editableOnly?: boolean; // Hide read-only system albums such as iOS smart albums
    titleKey?: string; // Optional custom title key
}

export const AlbumSelector: React.FC<AlbumSelectorProps> = ({
    visible,
    onClose,
    onConfirm,
    initialSelection = EMPTY_SELECTION,
    maxSelection,
    editableOnly = false,
    titleKey = 'album_selector_title',
}) => {
    const { albums, loadAlbums } = useMediaStore();
    const [selectedIds, setSelectedIds] = useState<string[]>(initialSelection);
    const [albumAccess, setAlbumAccess] = useState<'checking' | 'available' | 'unavailable'>('checking');
    const { t } = useI18n();
    const { colors } = useThemeColor();

    useEffect(() => {
        if (!visible) return;

        let active = true;
        setSelectedIds(initialSelection);

        const checkAlbumAccess = async () => {
            setAlbumAccess('checking');
            const canUseAlbums = await hasFullPhotoLibraryAccess();
            if (!active) return;

            if (!canUseAlbums) {
                setAlbumAccess('unavailable');
                return;
            }

            setAlbumAccess('available');
            await loadAlbums();
        };

        void checkAlbumAccess();

        const subscription = Platform.OS === 'ios'
            ? AppState.addEventListener('change', nextState => {
                if (active && nextState === 'active') {
                    void checkAlbumAccess();
                }
            })
            : null;

        return () => {
            active = false;
            subscription?.remove();
        };
    }, [visible, initialSelection, loadAlbums]);

    const handleOpenSettings = async () => {
        try {
            await Linking.openSettings();
        } catch (error) {
            console.error('[AlbumSelector] Failed to open system settings:', error);
        }
    };

    const toggleSelection = (id: string) => {
        setSelectedIds((currentIds) => {
            if (currentIds.includes(id)) {
                return currentIds.filter((item) => item !== id);
            }
            if (maxSelection && currentIds.length >= maxSelection) {
                return currentIds;
            }
            return [...currentIds, id];
        });
    };

    const handleClearAll = () => {
        setSelectedIds([]);
    };

    const visibleAlbums = editableOnly
        ? albums.filter(album => album.type !== 'smartAlbum')
        : albums;

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={onClose}
        >
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

                    {albumAccess === 'checking' ? (
                        <View style={styles.accessState}>
                            <ActivityIndicator color={colors.primary} />
                        </View>
                    ) : albumAccess === 'unavailable' ? (
                        <View style={styles.accessState}>
                            <Ionicons name="lock-closed-outline" size={28} color={colors.textSecondary} />
                            <Text style={[styles.accessMessage, { color: colors.textSecondary }]}>
                                {t('album_full_access_required' as any)}
                            </Text>
                            <Pressable
                                style={[styles.settingsButton, { borderColor: colors.primary }]}
                                onPress={handleOpenSettings}
                            >
                                <Text style={[styles.settingsButtonText, { color: colors.primary }]}>
                                    {t('album_open_settings' as any)}
                                </Text>
                            </Pressable>
                        </View>
                    ) : (
                        <FlatList
                            data={visibleAlbums}
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
                    )}

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
    accessState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: SPACING.l,
        gap: SPACING.m,
    },
    accessMessage: {
        fontSize: 15,
        lineHeight: 22,
        textAlign: 'center',
    },
    settingsButton: {
        borderWidth: 1,
        borderRadius: BORDER_RADIUS.full,
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.s,
    },
    settingsButtonText: {
        fontSize: 14,
        fontWeight: '600',
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
