import { Ionicons } from '@expo/vector-icons';
// import { BlurView } from 'expo-blur';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassContainer } from '../../components/GlassContainer';
import { PhotoCard } from '../../components/PhotoCard';
import { BORDER_RADIUS, COLORS, SPACING } from '../../constants/theme';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

export default function PhotosScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();

    const {
        photos, albums, loadPhotos, isLoading, hasHydrated,
        photoProcessedIds,
        markForDeletion, markAsSkipped,
        confirmDeletion, deleteQueue, resetBatch, isConfirmingDeletion,
        createAlbum, addAssetToAlbum, loadAlbums,
        permissionScope, hiddenPhotoQueuedAssetIds, mediaLibraryRefreshVersion,
    } = useMediaStore();

    const {
        groupSize,
        displayOrder,
        selectedAlbumIds,
        hasHydrated: settingsHydrated,
    } = useSettingsStore();

    const [showNewAlbumModal, setShowNewAlbumModal] = useState(false);
    const [newAlbumName, setNewAlbumName] = useState('');
    const [pendingCollectionPhoto, setPendingCollectionPhoto] = useState<any>(null);
    const [previewPhoto, setPreviewPhoto] = useState<any>(null);

    useFocusEffect(useCallback(() => {
        if (!hasHydrated || !settingsHydrated) return;
        void loadPhotos(groupSize, displayOrder, selectedAlbumIds);
        void loadAlbums();
    }, [
        groupSize,
        displayOrder,
        selectedAlbumIds,
        hasHydrated,
        settingsHydrated,
        loadPhotos,
        loadAlbums,
    ]));

    const processedIds = new Set(photoProcessedIds);
    const visiblePhotos = photos.filter(p => !processedIds.has(p.id));
    const hiddenQueueIds = new Set(hiddenPhotoQueuedAssetIds ?? []);
    const visibleDeleteQueue = permissionScope === 'full' && hiddenPhotoQueuedAssetIds === null
        ? deleteQueue
        : permissionScope === 'limited' && hasHydrated && hiddenPhotoQueuedAssetIds !== null
            ? deleteQueue.filter(asset => !hiddenQueueIds.has(asset.id))
            : [];
    const visibleDeleteQueueIds = visibleDeleteQueue.map(photo => photo.id);

    const previousMediaLibraryRefreshVersionRef = useRef(mediaLibraryRefreshVersion);
    useEffect(() => {
        if (mediaLibraryRefreshVersion === previousMediaLibraryRefreshVersionRef.current) return;
        previousMediaLibraryRefreshVersionRef.current = mediaLibraryRefreshVersion;

        // A library or permission change invalidates the local preview and
        // collection dialog, whose route/asset snapshot may no longer be
        // accessible. Persisted review queues are kept for recovery, but are
        // filtered separately by the permission-aware queue projection.
        setPreviewPhoto(null);
        setPendingCollectionPhoto(null);
        setNewAlbumName('');
        setShowNewAlbumModal(false);
    }, [mediaLibraryRefreshVersion]);

    // Drop zones disabled for v0.1.1
    const dropZones: any[] = [];

    const handleSwipeUp = (photo: any) => {
        markForDeletion(photo);
    };

    const [toastMessage, setToastMessage] = useState<string | null>(null);

    const showToast = (message: string) => {
        setToastMessage(message);
        setTimeout(() => setToastMessage(null), 1500);
    };

    const handleSwipeDown = async (photo: any, zoneId?: string): Promise<boolean> => {
        if (zoneId) {
            // Existing Album
            const albumName = albums.find(a => a.id === zoneId)?.title || t('photos_album_fallback');
            try {
                await addAssetToAlbum(zoneId, photo);
                markAsSkipped(photo);
                showToast(t('photos_collected', { album: albumName }));
                return true;
            } catch (error) {
                console.error('Failed to collect photo', error);
                showToast(t('photos_collection_failed'));
                return false;
            }
        } else {
            // Just Skip / Keep
            markAsSkipped(photo);
            return true;
        }
    };

    const handleCreateAlbum = async () => {
        if (newAlbumName && pendingCollectionPhoto) {
            try {
                await createAlbum(newAlbumName, pendingCollectionPhoto);
                markAsSkipped(pendingCollectionPhoto);
                setPendingCollectionPhoto(null);
                setNewAlbumName('');
                setShowNewAlbumModal(false);
            } catch (error) {
                console.error('Failed to create photo album', error);
                showToast(t('photos_create_album_failed'));
            }
        }
    };

    const handleTap = (photo: any) => {
        router.push({
            pathname: "/photo-detail",
            params: { assetId: photo.id, uri: photo.uri }
        });
    };

    const handleUndo = (assetId: string) => {
        // useMediaStore undoAction
        useMediaStore.getState().undoAction(assetId);
        // The queue can be restored after a restart, when its asset is no
        // longer present in the in-memory batch. Reload using the current
        // filter so undo makes the asset actionable again without leaking an
        // item from another album scope into the deck.
        void loadPhotos(groupSize, displayOrder, selectedAlbumIds);
    };

    const handleBatchFinished = () => {
        // If no photos to delete, show message and auto-proceed
        if (visibleDeleteQueue.length === 0) {
            return (
                <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                    <Text style={[styles.emptyText, { color: colors.text }]}>{t('no_delete_this_batch' as any)}</Text>
                    <Pressable
                        style={[styles.actionButton, { backgroundColor: colors.primary }]}
                        onPress={() => {
                            resetBatch(visibleDeleteQueueIds);
                            loadPhotos(groupSize, displayOrder, selectedAlbumIds);
                        }}
                    >
                        <Text style={styles.actionButtonText}>{t('continue_next_batch' as any)}</Text>
                    </Pressable>
                </View>
            );
        }

        return (
            <ScrollView
                style={{ flex: 1, width: '100%' }}
                contentContainerStyle={[styles.centerContainer, { backgroundColor: colors.background, flexGrow: 1, paddingVertical: 40 }]}
            >
                <Text style={[styles.emptyText, { color: colors.text }]}>{t('photos_finished')}</Text>

                <GlassContainer style={styles.statsContainer}>
                    <Text style={[styles.statText, { color: colors.text, marginBottom: 10 }]}>{t('photos_delete_count', { count: visibleDeleteQueue.length })}</Text>

                    {/* Thumbnails Grid */}
                    <View style={styles.thumbnailsGrid}>
                        {visibleDeleteQueue.slice(0, 9).map((photo) => (
                            <Pressable
                                key={photo.id}
                                onPress={() => handleUndo(photo.id)}
                                onLongPress={() => setPreviewPhoto(photo)}
                                delayLongPress={200}
                                disabled={isConfirmingDeletion}
                                style={isConfirmingDeletion && { opacity: 0.5 }}
                            >
                                <Image source={{ uri: photo.uri }} style={styles.thumbnail} />
                                <View style={styles.undoOverlay}>
                                    <Ionicons name="close-circle" size={16} color="white" />
                                </View>
                            </Pressable>
                        ))}
                        {visibleDeleteQueue.length > 9 && (
                            <View style={styles.moreCount}>
                                <Text style={{ color: colors.textSecondary }}>+{visibleDeleteQueue.length - 9}</Text>
                            </View>
                        )}
                    </View>
                    {visibleDeleteQueue.length > 0 && <Text style={{ fontSize: 10, color: colors.textSecondary, marginTop: 5 }}>{t('thumbnail_tap_undo' as any)}</Text>}
                </GlassContainer>

                <Pressable
                    style={[styles.actionButton, { backgroundColor: colors.primary }, isConfirmingDeletion && { opacity: 0.6 }]}
                    onPress={async () => {
                    try {
                        const deletedIds = await confirmDeletion(visibleDeleteQueueIds); // Wait for deletion to complete
                        if (useMediaStore.getState().isConfirmingDeletion) return;
                        // Keep any item that failed the last-moment visibility
                        // check in the persisted queue so it can be retried
                        // after the permission or media-library state recovers.
                        resetBatch(deletedIds);
                        loadPhotos(groupSize, displayOrder, selectedAlbumIds);
                    } catch (error) {
                        console.error('Failed to confirm photo deletion', error);
                        showToast(t('photos_delete_failed'));
                    }
                }}
                    disabled={isConfirmingDeletion}
                >
                    <Text style={styles.actionButtonText}>{t('photos_confirm')}</Text>
                </Pressable>

                <Pressable
                    style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: 10 }, isConfirmingDeletion && { opacity: 0.6 }]}
                    onPress={() => {
                    resetBatch(visibleDeleteQueueIds);
                    loadPhotos(groupSize, displayOrder, selectedAlbumIds);
                }}
                    disabled={isConfirmingDeletion}
                >
                    <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('photos_skip')}</Text>
                </Pressable>
            </ScrollView>
        )
    };

    if (isLoading) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    // A persisted delete queue can outlive the in-memory review batch. Keep
    // the confirmation screen reachable after a restart, even when there
    // are no remaining photos to load.
    if (visiblePhotos.length === 0 && (photos.length > 0 || visibleDeleteQueue.length > 0)) {
        return (
            <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
                {handleBatchFinished()}

                {/* Preview Modal */}
                <Modal
                    visible={!!previewPhoto}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setPreviewPhoto(null)}
                >
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
                <Pressable onPress={() => loadPhotos(groupSize, displayOrder, selectedAlbumIds)} style={[styles.actionButton, { backgroundColor: colors.primary }]}>
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
                {visiblePhotos.slice(0, 2).reverse().map((photo, index) => {
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
                            enableCollections={false}
                            dropZones={dropZones}
                        />
                    );
                })}
            </View>

            {/* Footer hints - collections disabled for v0.1.1 */}
            <View style={styles.footerHints}>
                <View style={styles.hintItem}>
                    <Ionicons name="trash-outline" size={24} color={colors.danger} />
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
                        placeholder={t('album_name_placeholder')}
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
        width: 100,
        height: 100,
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
        width: 100,
        height: 100,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(128,128,128,0.2)',
        borderRadius: 8
    },
    actionButton: {
        backgroundColor: COLORS.primary, // This needs to be dynamic, will be overridden in render
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
