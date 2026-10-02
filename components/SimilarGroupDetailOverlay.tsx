
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    BackHandler,
    FlatList,
    Image,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    View
} from 'react-native';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { AssetRepository } from '../database';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { getCurrentlyVisibleAssetIds, useMediaStore } from '../stores/useMediaStore';
import { deleteAssetsInBatches } from '../services/mediaDeletion';

const COLUMN_COUNT = 3;

interface PhotoItem {
    assetId: string;
    uri: string;
}

interface SimilarGroupDetailOverlayProps {
    visible: boolean;
    groupId: string;
    memberAssetIds: string[];
    originRect: { x: number; y: number; width: number; height: number } | null;
    onClose: () => void;
    onComplete: () => void;
}

export function SimilarGroupDetailOverlay({
    visible,
    memberAssetIds,
    onClose,
    onComplete,
}: SimilarGroupDetailOverlayProps) {
    const insets = useSafeAreaInsets();
    const { colors } = useThemeColor();
    const { t, language } = useI18n();

    const [photos, setPhotos] = useState<PhotoItem[]>([]);
    const [isLoadingPhotos, setIsLoadingPhotos] = useState(false);
    const [unavailableCount, setUnavailableCount] = useState(0);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [previewPhoto, setPreviewPhoto] = useState<PhotoItem | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const isDeletingRef = useRef(false);
    const loadRequestIdRef = useRef(0);

    // Animation state
    const overlayOpacity = useSharedValue(0);

    const loadPhotos = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        setIsLoadingPhotos(true);
        setUnavailableCount(0);
        setPhotos([]);
        const items: PhotoItem[] = [];
        for (const assetId of memberAssetIds) {
            try {
                const info = await MediaLibrary.getAssetInfoAsync(assetId);
                if (info.localUri || info.uri) {
                    items.push({
                        assetId,
                        uri: info.localUri || info.uri,
                    });
                }
            } catch {
                // Skip
            }
        }
        if (requestId === loadRequestIdRef.current) {
            setPhotos(items);
            setUnavailableCount(memberAssetIds.length - items.length);
            setIsLoadingPhotos(false);
        }
    }, [memberAssetIds]);

    const animateClose = useCallback(() => {
        // Exit animation
        overlayOpacity.value = withTiming(0, { duration: 250 }, (finished) => {
            if (finished) {
                runOnJS(onClose)();
            }
        });
    }, [onClose, overlayOpacity]);

    const handleClose = useCallback(() => {
        if (isDeletingRef.current) return;
        animateClose();
    }, [animateClose]);

    useEffect(() => {
        if (visible && memberAssetIds.length > 0) {
            loadPhotos();
            setSelectedIds(new Set());
            setPreviewPhoto(null);
            // Start enter animation
            overlayOpacity.value = withTiming(1, { duration: 180 });
        } else {
            loadRequestIdRef.current += 1;
            setPhotos([]); // Clear on close or an empty group to avoid stale content
            setIsLoadingPhotos(false);
            setUnavailableCount(0);
            setSelectedIds(new Set());
            setPreviewPhoto(null);
        }
        return () => { loadRequestIdRef.current += 1; };
    }, [visible, memberAssetIds, loadPhotos, overlayOpacity]);

    // Handle Back Button
    useEffect(() => {
        if (!visible) return;

        const onBackPress = () => {
            handleClose();
            return true;
        };

        const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);

        return () => subscription.remove();
    }, [visible, handleClose]);

    const handleLongPress = (assetId: string) => {
        if (isDeletingRef.current) return;
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(assetId)) {
                next.delete(assetId);
            } else {
                next.add(assetId);
            }
            return next;
        });
    };

    const handleTap = (photo: PhotoItem) => {
        if (isDeletingRef.current) return;
        if (selectedIds.size > 0) {
            handleLongPress(photo.assetId);
        } else {
            setPreviewPhoto(photo);
        }
    };

    const handleDeleteSelected = () => {
        if (selectedIds.size === 0 || isDeletingRef.current) return;
        const count = selectedIds.size;
        Alert.alert(
            language === 'zh' ? '确认删除' : 'Confirm Delete',
            `${language === 'zh' ? `确定要删除选中的 ${count} 张照片吗？` : `Delete ${count} selected photo(s)?`}\n\n${t('media_delete_warning')}`,
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('confirm'),
                    style: 'destructive',
                    onPress: async () => {
                        if (isDeletingRef.current) return;
                        const assetIds = Array.from(selectedIds);
                        const selectedAssetIds = new Set(assetIds);
                        isDeletingRef.current = true;
                        setIsDeleting(true);
                        try {
                            const visibleIds = await getCurrentlyVisibleAssetIds(assetIds, 'photo');
                            if (visibleIds.size !== selectedAssetIds.size) {
                                throw new Error('One or more selected photos are no longer available');
                            }
                            await deleteAssetsInBatches(assetIds, async (batch) => {
                                const batchIds = new Set(batch);
                                useMediaStore.getState().removeDeletedAssets(batch);
                                setPhotos(prev => prev.filter(p => !batchIds.has(p.assetId)));
                                setSelectedIds(prev => new Set(Array.from(prev).filter(id => !batchIds.has(id))));
                                for (const assetId of batch) {
                                    try {
                                        await AssetRepository.removeAssetAndDerivedData(assetId);
                                    } catch (cleanupError) {
                                        console.error('[SimilarGroupDetailOverlay] Index cleanup failed:', cleanupError);
                                    }
                                }
                            });
                            const remainingCount = photos.filter(photo => !selectedAssetIds.has(photo.assetId)).length;

                            // Animate close if all deleted or user done
                            if (remainingCount <= 1) {
                                onComplete(); // Mark as done effectively
                                animateClose();
                            } else {
                                // Just update list
                            }
                        } catch (error) {
                            Alert.alert(language === 'zh' ? '删除失败' : 'Delete Failed', String(error));
                        } finally {
                            isDeletingRef.current = false;
                            setIsDeleting(false);
                        }
                    },
                },
            ]
        );
    };

    const handleClosePreview = () => {
        if (isDeletingRef.current) return;
        setPreviewPhoto(null);
    };
    const handleDeleteFromPreview = async () => {
        if (!previewPhoto || isDeletingRef.current) return;

        const photoToDelete = previewPhoto;
        isDeletingRef.current = true;
        setIsDeleting(true);

        try {
            const visibleIds = await getCurrentlyVisibleAssetIds([photoToDelete.assetId], 'photo');
            if (!visibleIds.has(photoToDelete.assetId)) {
                throw new Error('Photo is no longer available');
            }
            const deleted = await MediaLibrary.deleteAssetsAsync([photoToDelete.assetId]);
            if (!deleted) {
                throw new Error('Media library did not confirm deletion');
            }
            useMediaStore.getState().removeDeletedAssets([photoToDelete.assetId]);
            try {
                await AssetRepository.removeAssetAndDerivedData(photoToDelete.assetId);
            } catch (cleanupError) {
                console.error('[SimilarGroupDetailOverlay] Index cleanup failed:', cleanupError);
            }
            const remainingCount = photos.filter(photo => photo.assetId !== photoToDelete.assetId).length;
            setPhotos(prev => prev.filter(p => p.assetId !== photoToDelete.assetId));
            setPreviewPhoto(null);

            if (remainingCount <= 1) {
                onComplete();
                animateClose();
            }
        } catch (error) {
            Alert.alert(language === 'zh' ? '删除失败' : 'Delete Failed', String(error));
        } finally {
            isDeletingRef.current = false;
            setIsDeleting(false);
        }
    };

    const renderPhotoItem = ({ item, index }: { item: PhotoItem; index: number }) => {
        const isSelected = selectedIds.has(item.assetId);
        return (
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('similar_photo', { index: index + 1 })}
                accessibilityHint={t(selectedIds.size > 0 ? 'similar_toggle_hint' : 'similar_select_hint')}
                accessibilityState={{ selected: isSelected, disabled: isDeleting }}
                style={[
                    styles.photoItem,
                    isSelected && { borderColor: colors.primary, borderWidth: 3 },
                    isDeleting && { opacity: 0.5 },
                ]}
                onPress={() => handleTap(item)}
                onLongPress={() => handleLongPress(item.assetId)}
                disabled={isDeleting}
            >
                <Image source={{ uri: item.uri }} style={styles.photoImage} />
                {isSelected && (
                    <View style={[styles.checkmark, { backgroundColor: colors.actionBackground }]}>
                        <Ionicons name="checkmark" size={16} color={colors.actionForeground} />
                    </View>
                )}
            </Pressable>
        );
    };

    const containerAnimatedStyle = useAnimatedStyle(() => ({
        opacity: overlayOpacity.value,
    }));

    if (!visible) return null;

    return (
        <Animated.View accessibilityViewIsModal testID="similar-detail" style={[StyleSheet.absoluteFill, styles.container, {
            backgroundColor: colors.background,
            paddingTop: insets.top + 8,
            paddingBottom: UI_METRICS.dockHeight + insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
        }, containerAnimatedStyle]}>
            <View style={styles.header}>
                <View style={styles.heading}>
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('similar_group_detail_title')}</Text>
                    <Text accessibilityLiveRegion="polite" style={[styles.summary, { color: colors.textSecondary }]}>
                        {selectedIds.size > 0 ? t('similar_selected_count', { count: selectedIds.size }) : t('scan_photo_count', { count: isLoadingPhotos || (photos.length === 0 && unavailableCount > 0) ? memberAssetIds.length : photos.length })}
                    </Text>
                </View>
                {selectedIds.size > 0 && (
                    <Pressable
                        style={[styles.deleteButton, { backgroundColor: colors.dangerBackground }, isDeleting && { opacity: 0.5 }]}
                        onPress={handleDeleteSelected}
                        disabled={isDeleting}
                        accessibilityRole="button"
                        accessibilityLabel={t('similar_delete_selected')}
                        accessibilityState={{ disabled: isDeleting, busy: isDeleting }}
                    >
                        <Ionicons name="trash-outline" size={20} color={colors.dangerForeground} />
                    </Pressable>
                )}
                <Pressable
                    style={[styles.closeButton, isDeleting && { opacity: 0.5 }]}
                    onPress={handleClose}
                    disabled={isDeleting}
                    accessibilityRole="button"
                    accessibilityLabel={t('close')}
                    accessibilityState={{ disabled: isDeleting }}
                >
                    <Ionicons name="close-outline" size={24} color={colors.text} />
                </Pressable>
            </View>
            {!isLoadingPhotos && photos.length > 0 && <Text style={[styles.hint, { color: colors.textSecondary }]}>{t(selectedIds.size > 0 ? 'similar_toggle_hint' : 'similar_select_hint')}</Text>}
            {!isLoadingPhotos && photos.length > 0 && unavailableCount > 0 && <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: colors.textSecondary }]}>{t('similar_unavailable_count', { count: unavailableCount })}</Text>}

            {/* Grid */}
            <View style={{ flex: 1 }}>
                <FlatList
                    data={photos}
                    renderItem={renderPhotoItem}
                    keyExtractor={(item) => item.assetId}
                    numColumns={COLUMN_COUNT}
                    contentContainerStyle={styles.grid}
                    ListEmptyComponent={isLoadingPhotos ? (
                        <ActivityIndicator color={colors.primary} style={styles.readState} />
                    ) : unavailableCount > 0 ? (
                        <View style={styles.readState}>
                            <Text accessibilityRole="alert" style={[styles.readMessage, { color: colors.textSecondary }]}>{t('photos_load_failed')}</Text>
                            <Pressable accessibilityRole="button" onPress={() => void loadPhotos()} style={[styles.retryButton, { backgroundColor: colors.actionBackground }]}>
                                <Text style={[styles.retryText, { color: colors.actionForeground }]}>{t('retry')}</Text>
                            </Pressable>
                        </View>
                    ) : null}
                />
            </View>

            {/* Preview Modal */}
            {previewPhoto && (
                <Modal visible={true} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={handleClosePreview}>
                    <View accessibilityViewIsModal testID="similar-preview" style={[styles.previewOverlay, {
                        backgroundColor: colors.background,
                        paddingTop: insets.top + 8,
                        paddingBottom: insets.bottom,
                        paddingLeft: insets.left,
                        paddingRight: insets.right,
                    }]}>
                        <View style={styles.previewHeader}>
                            <Text accessibilityRole="header" style={[styles.previewTitle, { color: colors.text }]}>{t('photo_detail_title')}</Text>
                            <Pressable
                                style={[styles.previewClose, isDeleting && { opacity: 0.5 }]}
                                onPress={handleClosePreview}
                                disabled={isDeleting}
                                accessibilityRole="button"
                                accessibilityLabel={t('close')}
                                accessibilityState={{ disabled: isDeleting }}
                            >
                                <Ionicons name="close-outline" size={24} color={colors.text} />
                            </Pressable>
                            <Pressable
                                style={[styles.previewDeleteButton, { backgroundColor: colors.dangerBackground }, isDeleting && { opacity: 0.5 }]}
                                onPress={handleDeleteFromPreview}
                                disabled={isDeleting}
                                accessibilityRole="button"
                                accessibilityLabel={t('delete')}
                                accessibilityState={{ disabled: isDeleting, busy: isDeleting }}
                            >
                                <Ionicons name="trash-outline" size={20} color={colors.dangerForeground} />
                            </Pressable>
                        </View>
                        <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('media_delete_warning')}</Text>
                        <View style={styles.previewMedia}>
                            <SimilarPhotoPreview key={`${previewPhoto.assetId}:${previewPhoto.uri}`} photo={previewPhoto} />
                        </View>
                    </View>
                </Modal>
            )}
        </Animated.View>
    );
}

/** Keep a failed decoder from looking like an empty, successfully loaded preview. */
function SimilarPhotoPreview({ photo }: { photo: PhotoItem }) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const [attempt, setAttempt] = useState(0);
    const [image, setImage] = useState<{ uri: string; failed: boolean; attempt: number } | null>({ uri: photo.uri, failed: false, attempt: 0 });

    useEffect(() => {
        if (attempt === 0) return;
        let active = true;
        setImage(null);
        void MediaLibrary.getAssetInfoAsync(photo.assetId).then(info => {
            const uri = info?.localUri || info?.uri || '';
            if (active) setImage({ uri, failed: !uri, attempt });
        }).catch(() => {
            if (active) setImage({ uri: '', failed: true, attempt });
        });
        return () => { active = false; };
    }, [photo.assetId, attempt]);

    if (!image) return <ActivityIndicator size="large" color={colors.primary} />;
    if (image.failed) return (
        <View style={styles.readState}>
            <Text accessibilityRole="alert" style={[styles.readMessage, { color: colors.textSecondary }]}>{t('scan_photo_unavailable')}</Text>
            <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={[styles.retryButton, { backgroundColor: colors.actionBackground }]}>
                <Text style={[styles.retryText, { color: colors.actionForeground }]}>{t('retry')}</Text>
            </Pressable>
        </View>
    );
    const uri = image.uri;
    return <Image key={attempt} accessible accessibilityRole="image" accessibilityLabel={t('photo_detail_title')}
        source={{ uri }} style={styles.previewImage} resizeMode="contain"
        onError={() => setImage(previous => previous?.attempt === attempt && previous.uri === uri ? { ...previous, failed: true } : previous)} />;
}

const styles = StyleSheet.create({
    readState: { alignItems: 'center', paddingHorizontal: UI_METRICS.pageInset, paddingVertical: 24, gap: 20 },
    readMessage: { ...TYPOGRAPHY.body, textAlign: 'center' },
    retryButton: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 24, paddingVertical: 14, justifyContent: 'center', alignItems: 'center' },
    retryText: { ...TYPOGRAPHY.button },
    container: {
        zIndex: 1000,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: UI_METRICS.pageInset,
        paddingBottom: 12,
        gap: 12,
    },
    heading: { flex: 1, minWidth: 0, gap: 4 },
    closeButton: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 4,
        flexShrink: 0,
        borderRadius: UI_METRICS.buttonRadius,
    },
    title: {
        ...TYPOGRAPHY.pageTitle,
    },
    summary: { ...TYPOGRAPHY.secondary },
    hint: { ...TYPOGRAPHY.secondary, paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 16 },
    deleteButton: {
        minWidth: 44,
        minHeight: 44,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 10,
        borderRadius: 12,
    },
    grid: {
        paddingHorizontal: 12,
        paddingBottom: 20,
    },
    photoItem: {
        width: '33.333333%',
        aspectRatio: 1,
        padding: 4,
    },
    photoImage: {
        width: '100%',
        height: '100%',
        borderRadius: 8,
    },
    checkmark: {
        position: 'absolute',
        top: 8,
        right: 8,
        width: 24,
        height: 24,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewOverlay: {
        flex: 1,
    },
    previewHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 12 },
    previewTitle: { ...TYPOGRAPHY.sectionTitle, flex: 1, minWidth: 0 },
    previewMedia: { flex: 1, minHeight: 0 },
    previewClose: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        borderRadius: UI_METRICS.buttonRadius,
    },
    previewDeleteButton: {
        minWidth: 44,
        minHeight: 44,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 10,
        borderRadius: UI_METRICS.buttonRadius,
    },
    previewImage: {
        width: '100%',
        height: '100%',
    },
});
