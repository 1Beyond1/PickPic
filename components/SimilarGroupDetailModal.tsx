/**
 * SimilarGroupDetailModal - Modal for viewing and managing similar photo group
 */

import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import React, { useEffect, useState } from 'react';
import {
    Alert,
    Dimensions,
    FlatList,
    Image,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLUMN_COUNT = 3;
const ITEM_SIZE = (SCREEN_WIDTH - 48) / COLUMN_COUNT;

interface PhotoItem {
    assetId: string;
    uri: string;
}

interface SimilarGroupDetailModalProps {
    visible: boolean;
    groupId: string;
    memberAssetIds: string[];
    onClose: () => void;
    onComplete: () => void; // Called when user finishes processing group
}

export function SimilarGroupDetailModal({
    visible,
    groupId,
    memberAssetIds,
    onClose,
    onComplete,
}: SimilarGroupDetailModalProps) {
    const insets = useSafeAreaInsets();
    const { colors, isDark } = useThemeColor();
    const { t, language } = useI18n();

    const [photos, setPhotos] = useState<PhotoItem[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [previewPhoto, setPreviewPhoto] = useState<PhotoItem | null>(null);
    const [loading, setLoading] = useState(true);

    // Animation state
    const [isAnimating, setIsAnimating] = useState(false);
    const animProgress = useSharedValue(0);

    useEffect(() => {
        if (visible && memberAssetIds.length > 0) {
            loadPhotos();
        }
    }, [visible, memberAssetIds]);

    const loadPhotos = async () => {
        setLoading(true);
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
                // Skip failed loads
            }
        }
        setPhotos(items);
        setLoading(false);

        if (items.length > 0) {
            setIsAnimating(true);
            animProgress.value = 0;
            animProgress.value = withTiming(2, {
                duration: 800,
                easing: Easing.inOut(Easing.quad),
            }, (finished) => {
                if (finished) {
                    runOnJS(setIsAnimating)(false);
                }
            });
        }
    };

    const handleLongPress = (assetId: string) => {
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
        if (selectedIds.size > 0) {
            // In selection mode, toggle selection
            handleLongPress(photo.assetId);
        } else {
            // Show preview
            setPreviewPhoto(photo);
        }
    };

    const handleDeleteSelected = () => {
        if (selectedIds.size === 0) return;

        const count = selectedIds.size;
        Alert.alert(
            language === 'zh' ? '确认删除' : 'Confirm Delete',
            language === 'zh'
                ? `确定要删除选中的 ${count} 张照片吗？`
                : `Delete ${count} selected photo(s)?`,
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('confirm'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await MediaLibrary.deleteAssetsAsync(Array.from(selectedIds));
                            setPhotos((prev) =>
                                prev.filter((p) => !selectedIds.has(p.assetId))
                            );
                            setSelectedIds(new Set());

                            // Mark group as processed and close
                            onComplete();
                            onClose();
                        } catch (error) {
                            Alert.alert(
                                language === 'zh' ? '删除失败' : 'Delete Failed',
                                String(error)
                            );
                        }
                    },
                },
            ]
        );
    };

    const handleClosePreview = () => {
        setPreviewPhoto(null);
    };

    const handleDeleteFromPreview = async () => {
        if (!previewPhoto) return;

        try {
            await MediaLibrary.deleteAssetsAsync([previewPhoto.assetId]);
            setPhotos((prev) =>
                prev.filter((p) => p.assetId !== previewPhoto.assetId)
            );
            setPreviewPhoto(null);
        } catch (error) {
            Alert.alert(
                language === 'zh' ? '删除失败' : 'Delete Failed',
                String(error)
            );
        }
    };

    const renderPhotoItem = ({ item }: { item: PhotoItem }) => {
        const isSelected = selectedIds.has(item.assetId);
        return (
            <Pressable
                style={[
                    styles.photoItem,
                    isSelected && { borderColor: colors.primary, borderWidth: 3 },
                ]}
                onPress={() => handleTap(item)}
                onLongPress={() => handleLongPress(item.assetId)}
            >
                <Image source={{ uri: item.uri }} style={styles.photoImage} />
                {isSelected && (
                    <View style={[styles.checkmark, { backgroundColor: colors.primary }]}>
                        <Ionicons name="checkmark" size={16} color="#FFF" />
                    </View>
                )}
            </Pressable>
        );
    };

    // Animation Item Component
    const AnimatedPhotoItem = ({ item, index, total }: { item: PhotoItem, index: number, total: number }) => {
        const style = useAnimatedStyle(() => {
            // Target Grid Position
            const col = index % COLUMN_COUNT;
            const row = Math.floor(index / COLUMN_COUNT);
            const gridX = col * ITEM_SIZE;
            const gridY = row * ITEM_SIZE;

            // Stack Position (Center Top)
            const stackX = (SCREEN_WIDTH - ITEM_SIZE) / 2 - 12;
            const stackY = 50;

            // Spread Position (Fan out)
            const spreadWidth = SCREEN_WIDTH * 0.8;
            const centerIdx = (Math.min(photos.length, 12) - 1) / 2;
            const spreadX = stackX + (index - centerIdx) * (spreadWidth / Math.min(photos.length, 12)) * 0.6; // 0.6 spread factor

            const val = animProgress.value;
            const translateX = interpolate(val, [0, 1, 2], [stackX, spreadX, gridX], Extrapolation.CLAMP);
            const translateY = interpolate(val, [0, 1, 2], [stackY, stackY, gridY], Extrapolation.CLAMP);
            const rotate = interpolate(val, [0, 1, 2], [(index - centerIdx) * 5, (index - centerIdx) * 15, 0], Extrapolation.CLAMP);
            const scale = interpolate(val, [0, 1, 2], [0.8, 0.9, 1], Extrapolation.CLAMP);

            return {
                position: 'absolute',
                left: 12,
                top: 12,
                width: ITEM_SIZE,
                height: ITEM_SIZE,
                transform: [
                    { translateX },
                    { translateY },
                    { rotate: `${rotate}deg` },
                    { scale },
                ],
                zIndex: total - index,
            };
        });

        return (
            <Animated.View style={[styles.photoItem, style]}>
                <Image source={{ uri: item.uri }} style={styles.photoImage} />
            </Animated.View>
        );
    };

    if (!visible) return null;

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
                {/* Header */}
                <View style={styles.header}>
                    <Pressable style={styles.closeButton} onPress={onClose}>
                        <Ionicons name="close" size={28} color={colors.text} />
                    </Pressable>
                    <Text style={[styles.title, { color: colors.text }]}>
                        {t('similar_group_detail_title' as any)} ({photos.length})
                    </Text>
                    {selectedIds.size > 0 && (
                        <Pressable
                            style={[styles.deleteButton, { backgroundColor: colors.danger }]}
                            onPress={handleDeleteSelected}
                        >
                            <Ionicons name="trash" size={20} color="#FFF" />
                        </Pressable>
                    )}
                </View>

                {/* Hint */}
                <Text style={[styles.hint, { color: colors.textSecondary }]}>
                    {t('similar_select_hint' as any)}
                </Text>

                {/* Photo Grid & Animation */}
                <View style={{ flex: 1, position: 'relative' }}>
                    <FlatList
                        data={photos}
                        renderItem={renderPhotoItem}
                        keyExtractor={(item) => item.assetId}
                        numColumns={COLUMN_COUNT}
                        contentContainerStyle={styles.grid}
                        style={{ opacity: isAnimating ? 0 : 1 }}
                    />
                    {isAnimating && (
                        <View style={StyleSheet.absoluteFill}>
                            {photos.slice(0, 15).map((photo, index) => (
                                <AnimatedPhotoItem
                                    key={photo.assetId}
                                    item={photo}
                                    index={index}
                                    total={Math.min(photos.length, 15)}
                                />
                            ))}
                        </View>
                    )}
                </View>

                {/* Preview Modal */}
                {previewPhoto && (
                    <Modal visible={true} transparent animationType="fade" onRequestClose={handleClosePreview}>
                        <View style={styles.previewOverlay}>
                            <Pressable style={styles.previewClose} onPress={handleClosePreview}>
                                <Ionicons name="close" size={32} color="#FFF" />
                            </Pressable>
                            <Pressable
                                style={[styles.previewDeleteButton, { backgroundColor: colors.danger }]}
                                onPress={handleDeleteFromPreview}
                            >
                                <Ionicons name="trash" size={24} color="#FFF" />
                            </Pressable>
                            <Image
                                source={{ uri: previewPhoto.uri }}
                                style={styles.previewImage}
                                resizeMode="contain"
                            />
                        </View>
                    </Modal>
                )}
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(0,0,0,0.1)',
    },
    closeButton: {
        padding: 4,
    },
    title: {
        flex: 1,
        fontSize: 18,
        fontWeight: 'bold',
        marginLeft: 12,
    },
    deleteButton: {
        padding: 10,
        borderRadius: 12,
    },
    hint: {
        textAlign: 'center',
        fontSize: 13,
        paddingVertical: 8,
    },
    grid: {
        padding: 12,
    },
    photoItem: {
        width: ITEM_SIZE,
        height: ITEM_SIZE,
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
        backgroundColor: 'rgba(0,0,0,0.95)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewClose: {
        position: 'absolute',
        top: 50,
        left: 20,
        zIndex: 10,
    },
    previewDeleteButton: {
        position: 'absolute',
        top: 50,
        right: 20,
        padding: 12,
        borderRadius: 25,
        zIndex: 10,
    },
    previewImage: {
        width: '90%',
        height: '70%',
    },
});
