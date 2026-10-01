import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { hasFullPhotoLibraryAccess, useMediaStore } from '../stores/useMediaStore';
import { BottomSheet } from './BottomSheet';

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
    const { height } = useWindowDimensions();

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
        <BottomSheet visible={visible} title={t(titleKey as any)} onClose={onClose} footer={
            <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.confirmButton, { backgroundColor: colors.actionBackground, opacity: pressed ? 0.75 : 1 }]}
                onPress={() => onConfirm(selectedIds)}
            >
                <Text style={[styles.confirmButtonText, { color: colors.actionForeground }]}>{t('confirm')}</Text>
            </Pressable>
        }>

            {/* Clear selection button */}
            {selectedIds.length > 0 && (
                <Pressable accessibilityRole="button" style={styles.clearButton} onPress={handleClearAll}>
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
                        accessibilityRole="button"
                        style={[styles.settingsButton, { backgroundColor: colors.actionBackground }]}
                        onPress={handleOpenSettings}
                    >
                        <Text style={[styles.settingsButtonText, { color: colors.actionForeground }]}>
                            {t('album_open_settings' as any)}
                        </Text>
                    </Pressable>
                </View>
            ) : (
                <FlatList
                    style={[styles.list, { maxHeight: height * 0.55 }]}
                    data={visibleAlbums}
                    keyExtractor={(item) => item.id}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('album_selector_empty')}</Text>}
                    renderItem={({ item }) => {
                        const isSelected = selectedIds.includes(item.id);
                        const isDisabled = !!(maxSelection && selectedIds.length >= maxSelection && !isSelected);
                        return (
                            <Pressable
                                style={({ pressed }) => [
                                    styles.item,
                                    { backgroundColor: pressed || isSelected ? colors.selectionBackground : 'transparent' },
                                    isDisabled && styles.itemDisabled
                                ]}
                                onPress={() => toggleSelection(item.id)}
                                accessibilityRole="checkbox"
                                accessibilityLabel={item.title}
                                accessibilityState={{ checked: isSelected, disabled: isDisabled }}
                                disabled={isDisabled ? true : false}
                            >
                                <Text style={[styles.itemText, { color: colors.text }, isSelected && { fontWeight: '500' }]}>
                                    {item.title}
                                </Text>
                                <Text style={[styles.itemCount, { color: colors.textSecondary }]}>{item.assetCount}</Text>
                                <Ionicons name={isSelected ? 'checkmark' : 'ellipse-outline'} size={20} color={isSelected ? colors.text : colors.textTertiary} />
                            </Pressable>
                        );
                    }}
                />
            )}

        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    clearButton: {
        minHeight: UI_METRICS.touchTarget,
        paddingHorizontal: 12,
        justifyContent: 'center',
        alignSelf: 'flex-start',
        marginBottom: 4,
    },
    clearButtonText: {
        ...TYPOGRAPHY.secondary,
    },
    list: { flexGrow: 0, flexShrink: 1 },
    listContent: { paddingBottom: 4 },
    emptyText: { ...TYPOGRAPHY.body, paddingVertical: 24, paddingHorizontal: 12 },
    accessState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 24,
        paddingHorizontal: 12,
        gap: 16,
    },
    accessMessage: {
        ...TYPOGRAPHY.body,
        textAlign: 'center',
    },
    settingsButton: {
        minHeight: UI_METRICS.touchTarget,
        borderRadius: UI_METRICS.buttonRadius,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    settingsButtonText: {
        ...TYPOGRAPHY.button,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: UI_METRICS.rowHeight,
        paddingVertical: 14,
        paddingHorizontal: 12,
        gap: 12,
        borderRadius: 8,
    },
    itemDisabled: {
        opacity: 0.5
    },
    itemText: {
        flex: 1,
        ...TYPOGRAPHY.body,
        minWidth: 0,
    },
    itemCount: {
        ...TYPOGRAPHY.secondary,
        fontVariant: ['tabular-nums'],
    },
    confirmButton: {
        minHeight: UI_METRICS.buttonHeight,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: UI_METRICS.buttonRadius,
        alignItems: 'center',
    },
    confirmButtonText: {
        ...TYPOGRAPHY.button,
    },
});
