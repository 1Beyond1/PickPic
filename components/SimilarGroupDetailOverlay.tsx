
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import React, { useEffect, useState } from 'react';
import {
    Alert,
    BackHandler,
    Dimensions,
    FlatList,
    Image,
    Modal,
    Pressable,
    StyleSheet,
    View
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
const ITEM_SIZE = (SCREEN_WIDTH - 24) / COLUMN_COUNT;

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
    groupId,
    memberAssetIds,
    originRect,
    onClose,
    onComplete,
}: SimilarGroupDetailOverlayProps) {
    const insets = useSafeAreaInsets();
    const { colors, isDark } = useThemeColor();
    const { t, language } = useI18n();

    const [photos, setPhotos] = useState<PhotoItem[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [previewPhoto, setPreviewPhoto] = useState<PhotoItem | null>(null);
    const [loading, setLoading] = useState(true);

    // Animation state
    const [isAnimating, setIsAnimating] = useState(false);
    const animProgress = useSharedValue(0); // 0 (Origin) -> 1 (Spread) -> 2 (Grid)
    const overlayOpacity = useSharedValue(0);

    useEffect(() => {
        if (visible && memberAssetIds.length > 0) {
            loadPhotos();
            // Start enter animation
            overlayOpacity.value = withTiming(1, { duration: 300 });

            setIsAnimating(true);
            animProgress.value = 0;
            // 2-step animation: Fan (0.5s) -> Fly (0.5s)
            animProgress.value = withTiming(2, {
                duration: 1000,
                easing: Easing.bezier(0.25, 0.1, 0.25, 1),
            }, (finished) => {
                if (finished) {
                    runOnJS(setIsAnimating)(false);
                }
            });
        } else if (!visible) {
            setPhotos([]); // Clear on close to avoid flash
        }
    }, [visible, memberAssetIds]);

    // Handle Back Button
    useEffect(() => {
        if (!visible) return;

        const onBackPress = () => {
            handleClose();
            return true;
        };

        const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);

        return () => subscription.remove();
    }, [visible]);

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
                // Skip
            }
        }
        setPhotos(items);
        setLoading(false);
    };

    const handleClose = () => {
        // Exit animation
        overlayOpacity.value = withTiming(0, { duration: 250 }, (finished) => {
            if (finished) {
                runOnJS(onClose)();
            }
        });
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
            handleLongPress(photo.assetId);
        } else {
            setPreviewPhoto(photo);
        }
    };

    const handleDeleteSelected = () => {
        if (selectedIds.size === 0) return;
        const count = selectedIds.size;
        Alert.alert(
            language === 'zh' ? '确认删除' : 'Confirm Delete',
            language === 'zh' ? `确定要删除选中的 ${count} 张照片吗？` : `Delete ${count} selected photo(s)?`,
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('confirm'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await MediaLibrary.deleteAssetsAsync(Array.from(selectedIds));
                            setPhotos(prev => prev.filter(p => !selectedIds.has(p.assetId)));
                            setSelectedIds(new Set());

                            // Animate close if all deleted or user done
                            if (photos.length - count <= 1) {
                                onComplete(); // Mark as done effectively
                                handleClose();
                            } else {
                                // Just update list
                            }
                        } catch (error) {
                            Alert.alert(language === 'zh' ? '删除失败' : 'Delete Failed', String(error));
                        }
                    },
                },
            ]
        );
    };

    const handleClosePreview = () => setPreviewPhoto(null);
    const handleDeleteFromPreview = async () => {
        if (!previewPhoto) return;
        try {
            await MediaLibrary.deleteAssetsAsync([previewPhoto.assetId]);
            setPhotos(prev => prev.filter(p => p.assetId !== previewPhoto.assetId));
            setPreviewPhoto(null);

            if (photos.length <= 2) {
                onComplete();
                handleClose();
            }
        } catch (error) {
            Alert.alert(language === 'zh' ? '删除失败' : 'Delete Failed', String(error));
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

    // Animation Item
    const AnimatedPhotoItem = ({ item, index, total }: { item: PhotoItem, index: number, total: number }) => {
        const style = useAnimatedStyle(() => {
            // Target Grid (Phase 2)
            const col = index % COLUMN_COUNT;
            const row = Math.floor(index / COLUMN_COUNT);
            const gridX = col * ITEM_SIZE + 12; // + padding
            const gridY = row * ITEM_SIZE + insets.top + 60; // Header offset approximation

            // Origin (Stack Phase 0)
            const startX = originRect ? originRect.x : (SCREEN_WIDTH - 80) / 2;
            const startY = originRect ? originRect.y : SCREEN_WIDTH / 2;

            // Fan Out (Phase 1)
            // Fan to the right like cards
            const fanGap = 35;
            const maxFanX = SCREEN_WIDTH - ITEM_SIZE - 20;
            // Calculate X with overlap
            const fanXRaw = startX + (index * fanGap);
            const fanX = Math.min(fanXRaw, maxFanX);
            // Slight Y arc or straight? Let's do straight for now as "table spread"
            const fanY = startY;
            // Rotation for fan effect
            const fanRotate = (index * 4); // 4 degrees per item

            const val = animProgress.value;

            let translateX, translateY, rotate, scale;

            if (val <= 1) {
                // Phase 1: Stack -> Fan Right
                translateX = interpolate(val, [0, 1], [startX, fanX], Extrapolation.CLAMP);
                translateY = interpolate(val, [0, 1], [startY, fanY], Extrapolation.CLAMP);
                rotate = interpolate(val, [0, 1], [0, fanRotate], Extrapolation.CLAMP);
                scale = interpolate(val, [0, 1], [0.5, 0.9], Extrapolation.CLAMP); // Grow slightly
            } else {
                // Phase 2: Fan Right -> Grid
                translateX = interpolate(val, [1, 2], [fanX, gridX], Extrapolation.CLAMP);
                translateY = interpolate(val, [1, 2], [fanY, gridY], Extrapolation.CLAMP);
                rotate = interpolate(val, [1, 2], [fanRotate, 0], Extrapolation.CLAMP);
                scale = interpolate(val, [1, 2], [0.9, 1], Extrapolation.CLAMP); // Grow to full
            }

            return {
                position: 'absolute',
                left: 0,
                top: 0,
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

    const containerAnimatedStyle = useAnimatedStyle(() => ({
        opacity: overlayOpacity.value,
    }));

    if (!visible) return null;

    return (
        <Animated.View style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.8)' }, containerAnimatedStyle]}>
            {/* Header - Transparent/Minimal */}
            <View style={[styles.header, { paddingTop: insets.top }]}>
                <Pressable style={styles.closeButton} onPress={handleClose}>
                    <Ionicons name="close" size={28} color={colors.text} />
                </Pressable>
                <View style={{ flex: 1 }} />
                {selectedIds.size > 0 && (
                    <Pressable
                        style={[styles.deleteButton, { backgroundColor: colors.danger }]}
                        onPress={handleDeleteSelected}
                    >
                        <Ionicons name="trash" size={20} color="#FFF" />
                    </Pressable>
                )}
            </View>

            {/* Grid */}
            <View style={{ flex: 1 }}>
                <FlatList
                    data={photos}
                    renderItem={renderPhotoItem}
                    keyExtractor={(item) => item.assetId}
                    numColumns={COLUMN_COUNT}
                    contentContainerStyle={styles.grid}
                    style={{ opacity: isAnimating ? 0 : 1 }}
                />

                {/* Animation Overlay */}
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
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    container: {
        zIndex: 1000,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 12,
        // No border for cleaner look in overlay
    },
    closeButton: {
        padding: 4,
        backgroundColor: 'rgba(0,0,0,0.1)', // Subtle background for visibility
        borderRadius: 20,
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
    grid: {
        paddingHorizontal: 12,
        paddingBottom: 40,
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
