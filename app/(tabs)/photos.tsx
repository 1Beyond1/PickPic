import { Ionicons } from '@expo/vector-icons';
// import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Dimensions, Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassContainer } from '../../components/GlassContainer';
import { PhotoCard } from '../../components/PhotoCard';
import { BORDER_RADIUS, COLORS, SPACING } from '../../constants/theme';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function PhotosScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();

    const {
        photos, albums, loadPhotos, isLoading,
        markForDeletion, markForCollection, markAsSkipped,
        confirmDeletion, deleteQueue, resetBatch,
        createAlbum, addAssetToAlbum, loadAlbums
    } = useMediaStore();

    const { groupSize, enableRandomDisplay } = useSettingsStore();

    const [removedIds, setRemovedIds] = useState<string[]>([]);
    const [showNewAlbumModal, setShowNewAlbumModal] = useState(false);
    const [newAlbumName, setNewAlbumName] = useState('');
    const [pendingCollectionPhoto, setPendingCollectionPhoto] = useState<any>(null);
    const [activeHoverZone, setActiveHoverZone] = useState<string | null>(null);

    useEffect(() => {
        loadPhotos(groupSize, enableRandomDisplay);
        loadAlbums();
    }, []);

    const visiblePhotos = photos.filter(p => !removedIds.includes(p.id));

    // Drop zones disabled for v0.1.1
    const dropZones: any[] = [];

    const handleSwipeUp = (photo: any) => {
        markForDeletion(photo);
        setRemovedIds(prev => [...prev, photo.id]);
    };

    const [toastMessage, setToastMessage] = useState<string | null>(null);

    const showToast = (message: string) => {
        setToastMessage(message);
        setTimeout(() => setToastMessage(null), 1500);
    };

    const handleSwipeDown = (photo: any, zoneId?: string) => {
        if (zoneId) {
            // Existing Album
            const albumName = albums.find(a => a.id === zoneId)?.title || '相册';
            addAssetToAlbum(zoneId, photo);
            setRemovedIds(prev => [...prev, photo.id]);
            showToast(`已收藏至「${albumName}」`);
        } else {
            // Just Skip / Keep
            markAsSkipped(photo);
            setRemovedIds(prev => [...prev, photo.id]);
        }
        setActiveHoverZone(null);
    };

    const handleCreateAlbum = async () => {
        if (newAlbumName && pendingCollectionPhoto) {
            await createAlbum(newAlbumName, pendingCollectionPhoto);
            setRemovedIds(prev => [...prev, pendingCollectionPhoto.id]);
            setPendingCollectionPhoto(null);
            setNewAlbumName('');
            setShowNewAlbumModal(false);
        }
    };

    const handleTap = (photo: any) => {
        router.push({
            pathname: "/photo-detail",
            params: { uri: photo.uri }
        });
    };

    const handleUndo = (assetId: string) => {
        // useMediaStore undoAction
        useMediaStore.getState().undoAction(assetId);
    };

    const [previewPhoto, setPreviewPhoto] = useState<any>(null);

    const handleBatchFinished = () => {
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                <Text style={[styles.emptyText, { color: colors.text }]}>{t('photos_finished')}</Text>

                <GlassContainer style={styles.statsContainer}>
                    <Text style={[styles.statText, { color: colors.text, marginBottom: 10 }]}>{t('photos_delete_count', { count: deleteQueue.length })}</Text>

                    {/* Thumbnails Grid */}
                    <View style={styles.thumbnailsGrid}>
                        {deleteQueue.slice(0, 9).map((photo) => (
                            <Pressable
                                key={photo.id}
                                onPress={() => handleUndo(photo.id)}
                                onLongPress={() => setPreviewPhoto(photo)}
                                delayLongPress={200}
                            >
                                <Image source={{ uri: photo.uri }} style={styles.thumbnail} />
                                <View style={styles.undoOverlay}>
                                    <Ionicons name="close-circle" size={16} color="white" />
                                </View>
                            </Pressable>
                        ))}
                        {deleteQueue.length > 9 && (
                            <View style={styles.moreCount}>
                                <Text style={{ color: colors.textSecondary }}>+{deleteQueue.length - 9}</Text>
                            </View>
                        )}
                    </View>
                    {deleteQueue.length > 0 && <Text style={{ fontSize: 10, color: colors.textSecondary, marginTop: 5 }}>点击撤销，长按查看</Text>}
                </GlassContainer>

                <Pressable style={styles.actionButton} onPress={async () => {
                    await confirmDeletion(); // Wait for deletion to complete
                    resetBatch();
                    loadPhotos(groupSize, enableRandomDisplay);
                    setRemovedIds([]);
                }}>
                    <Text style={styles.actionButtonText}>{t('photos_confirm')}</Text>
                </Pressable>

                <Pressable style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: 10 }]} onPress={() => {
                    resetBatch();
                    loadPhotos(groupSize, enableRandomDisplay);
                    setRemovedIds([]);
                }}>
                    <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('photos_skip')}</Text>
                </Pressable>
            </View>
        )
    };

    if (isLoading) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                <ActivityIndicator size="large" color={COLORS.primary} />
            </View>
        );
    }

    if (visiblePhotos.length === 0 && photos.length > 0) {
        return (
            <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
                {handleBatchFinished()}

                {/* Preview Modal */}
                <Modal visible={!!previewPhoto} transparent={true} animationType="fade">
                    <View style={styles.previewModalContainer}>
                        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.9)' }]} />
                        <Pressable style={styles.previewCloseArea} onPress={() => setPreviewPhoto(null)}>
                            {previewPhoto && (
                                <Image
                                    source={{ uri: previewPhoto.uri }}
                                    style={styles.previewImage}
                                    resizeMode="contain"
                                />
                            )}
                        </Pressable>
                    </View>
                </Modal>
            </View>
        )
    }

    if (photos.length === 0 && !isLoading) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                <Text style={[styles.emptyText, { color: colors.text }]}>{t('photos_empty')}</Text>
                <Pressable onPress={() => loadPhotos(groupSize, enableRandomDisplay)} style={styles.actionButton}>
                    <Text style={styles.actionButtonText}>{t('photos_reload')}</Text>
                </Pressable>
            </View>
        )
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
            <View style={styles.header}>
                <Text style={[styles.headerTitle, { color: colors.text }]}>{t('photos_header')} ({visiblePhotos.length}/{groupSize})</Text>
            </View>

            <View style={styles.deckContainer}>
                {visiblePhotos.slice(0, 3).reverse().map((photo, index) => {
                    const realIndex = visiblePhotos.indexOf(photo);
                    return (
                        <PhotoCard
                            key={photo.id}
                            photo={photo}
                            index={realIndex}
                            total={visiblePhotos.length}
                            onSwipeUp={() => handleSwipeUp(photo)}
                            onSwipeDown={(zoneId) => handleSwipeDown(photo, zoneId)}
                            onTap={() => handleTap(photo)}
                            onHoverZone={index === 0 ? setActiveHoverZone : undefined}
                            enableCollections={false}
                            dropZones={dropZones}
                        />
                    );
                })}
            </View>

            {/* Footer hints - collections disabled for v0.1.1 */}
            <View style={styles.footerHints}>
                <View style={styles.hintItem}>
                    <Ionicons name="trash-outline" size={24} color={COLORS.danger} />
                    <Text style={[styles.hintText, { color: colors.textSecondary }]}>{t('hint_swipe_up')}</Text>
                </View>
                <View style={styles.hintItem}>
                    <Ionicons name="arrow-undo-outline" size={24} color={colors.textSecondary} />
                    <Text style={[styles.hintText, { color: colors.textSecondary }]}>{t('hint_swipe_down')}</Text>
                </View>
            </View>

            {showNewAlbumModal && (
                <GlassContainer style={styles.modal}>
                    <Text style={[styles.modalTitle, { color: colors.text }]}>{t('album_new_title')}</Text>
                    <TextInput
                        style={[styles.input, { color: colors.text, backgroundColor: colors.surface }]}
                        placeholder="名称"
                        placeholderTextColor={colors.textSecondary}
                        value={newAlbumName}
                        onChangeText={setNewAlbumName}
                    />
                    <Pressable style={styles.actionButton} onPress={handleCreateAlbum}>
                        <Text style={styles.actionButtonText}>{t('album_create_btn')}</Text>
                    </Pressable>
                    <Pressable style={[styles.actionButton, { backgroundColor: 'transparent', marginTop: 10 }]} onPress={() => setShowNewAlbumModal(false)}>
                        <Text style={[styles.actionButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
                    </Pressable>
                </GlassContainer>
            )}

            {/* Toast */}
            {toastMessage && (
                <View style={[styles.toastContainer, { bottom: insets.bottom + 80 }]}>
                    <View style={[styles.toast, { backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)' }]}>
                        <Ionicons name="checkmark-circle" size={20} color={COLORS.success} />
                        <Text style={[styles.toastText, { color: colors.text }]}>{toastMessage}</Text>
                    </View>
                </View>
            )}

        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    header: {
        paddingHorizontal: SPACING.l,
        paddingBottom: SPACING.m,
        alignItems: 'center',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
    },
    deckContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: -50,
    },
    footerHints: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
        paddingBottom: 120,
    },
    dropZoneContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
        paddingBottom: 120,
        paddingHorizontal: SPACING.s
    },
    dropZone: {
        flex: 1,
        alignItems: 'center',
        padding: 2
    },
    dropZoneBlur: {
        width: '100%',
        padding: SPACING.s,
        borderRadius: BORDER_RADIUS.m,
        alignItems: 'center',
        overflow: 'hidden'
    },
    dropZoneLabel: {
        fontSize: 10,
        marginTop: 4,
        textAlign: 'center'
    },
    hintItem: {
        alignItems: 'center',
        opacity: 0.6
    },
    hintText: {
        marginTop: 4,
        fontSize: 12
    },
    emptyText: {
        fontSize: 20,
        marginBottom: 20
    },
    statsContainer: {
        padding: SPACING.l,
        marginBottom: 30,
        alignItems: 'center',
        width: '80%'
    },
    statText: {
        fontSize: 16
    },
    thumbnailsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 8,
        marginTop: 10
    },
    thumbnail: {
        width: 60,
        height: 60,
        borderRadius: 8
    },
    undoOverlay: {
        position: 'absolute',
        top: -6,
        right: -6,
        backgroundColor: 'rgba(0,0,0,0.5)',
        borderRadius: 10
    },
    moreCount: {
        width: 60,
        height: 60,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(128,128,128,0.2)',
        borderRadius: 8
    },
    actionButton: {
        backgroundColor: COLORS.primary,
        paddingHorizontal: 40,
        paddingVertical: 15,
        borderRadius: BORDER_RADIUS.full
    },
    actionButtonText: {
        color: COLORS.white,
        fontWeight: 'bold'
    },
    modal: {
        position: 'absolute',
        bottom: 300,
        left: 20,
        right: 20,
        padding: SPACING.l,
        alignItems: 'center'
    },
    modalTitle: {
        fontSize: 18,
        marginBottom: SPACING.m,
        fontWeight: 'bold'
    },
    input: {
        width: '100%',
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        marginBottom: SPACING.m
    },
    // Preview Modal
    previewModalContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewCloseArea: {
        flex: 1,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewImage: {
        width: '90%',
        height: '70%',
        borderRadius: 20,
    },
    // Toast
    toastContainer: {
        position: 'absolute',
        top: 100,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 1000,
    },
    toast: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.full,
        gap: 8,
        overflow: 'hidden',
    },
    toastText: {
        fontSize: 14,
        fontWeight: '500',
    }
});
