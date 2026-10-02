import { Feather, Ionicons } from '@expo/vector-icons';
// import { BlurView } from 'expo-blur';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassContainer } from '../../components/GlassContainer';
import { AlbumSelector } from '../../components/AlbumSelector';
import { PhotoCard } from '../../components/PhotoCard';
import { PhotoPreviewModal } from '../../components/PhotoPreviewModal';
import { BORDER_RADIUS, SPACING, TYPOGRAPHY, UI_METRICS } from '../../constants/theme';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

const REVIEW_PAGE_SIZE = 9;

export default function PhotosScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { width, height } = useWindowDimensions();
    const previewHeight = Math.min(334, Math.max(230, Math.min(width - 48, (height - insets.top - insets.bottom - 65) * 0.4)));
    const reviewThumbnailSize = Math.max(44, Math.floor((width - insets.left - insets.right - UI_METRICS.pageInset * 2 - 16) / 3));
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();

    const {
        photos, albums, loadPhotos, isLoading, photoLoadFailed, hasHydrated,
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
        setSelectedAlbums,
        hasHydrated: settingsHydrated,
    } = useSettingsStore();

    const [showNewAlbumModal, setShowNewAlbumModal] = useState(false);
    const [newAlbumName, setNewAlbumName] = useState('');
    const [pendingCollectionPhoto, setPendingCollectionPhoto] = useState<any>(null);
    const [previewPhoto, setPreviewPhoto] = useState<any>(null);
    const [managingPhotoAccess, setManagingPhotoAccess] = useState(false);
    const [showHome, setShowHome] = useState(true);
    const [showAlbumSelector, setShowAlbumSelector] = useState(false);
    const [reviewPage, setReviewPage] = useState(0);
    const [keptAllReviewPhotos, setKeptAllReviewPhotos] = useState(false);
    const [deckSize, setDeckSize] = useState({ width: 0, height: 0 });

    useFocusEffect(useCallback(() => {
        if (!hasHydrated || !settingsHydrated) return;
        setKeptAllReviewPhotos(false);
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

    const handleManagePhotoAccess = useCallback(async () => {
        if (managingPhotoAccess) return;

        setManagingPhotoAccess(true);
        try {
            // Android 14 can report a global limited grant even when the
            // requested media type has no selected assets. The picker lets
            // the user add photos without repeatedly showing a permission
            // prompt for users who already selected some media.
            await MediaLibrary.presentPermissionsPickerAsync(['photo']);
            const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
            const scope = !permission.granted
                ? 'none'
                : permission.accessPrivileges === 'limited'
                    ? 'limited'
                    : 'full';
            const mediaStore = useMediaStore.getState();
            mediaStore.setPermissionScope(scope);
            mediaStore.refreshQueuedAssetVisibility(scope, 'photo');
            mediaStore.pruneUnavailableQueuedAssets(scope, 'photo');
            mediaStore.notifyPermissionRefresh();
            if (!permission.granted) {
                router.replace('/');
                return;
            }
            await Promise.all([
                loadPhotos(groupSize, displayOrder, selectedAlbumIds),
                loadAlbums(),
            ]);
        } catch (error) {
            console.error('[Photos] Failed to manage photo access:', error);
        } finally {
            setManagingPhotoAccess(false);
        }
    }, [displayOrder, groupSize, loadAlbums, loadPhotos, managingPhotoAccess, router, selectedAlbumIds]);

    const processedIds = new Set(photoProcessedIds);
    const visiblePhotos = photos.filter(p => !processedIds.has(p.id));
    const hiddenQueueIds = new Set(hiddenPhotoQueuedAssetIds ?? []);
    const visibleDeleteQueue = permissionScope === 'full' && hiddenPhotoQueuedAssetIds === null
        ? deleteQueue
        : permissionScope === 'limited' && hasHydrated && hiddenPhotoQueuedAssetIds !== null
            ? deleteQueue.filter(asset => !hiddenQueueIds.has(asset.id))
            : [];
    const visibleDeleteQueueIds = visibleDeleteQueue.map(photo => photo.id);
    const reviewPageCount = Math.ceil(visibleDeleteQueue.length / REVIEW_PAGE_SIZE);
    const currentReviewPage = Math.min(reviewPage, Math.max(0, reviewPageCount - 1));
    const reviewPhotos = visibleDeleteQueue.slice(currentReviewPage * REVIEW_PAGE_SIZE, (currentReviewPage + 1) * REVIEW_PAGE_SIZE);

    useEffect(() => {
        if (visiblePhotos.length > 0) {
            setReviewPage(0);
            setKeptAllReviewPhotos(false);
        }
    }, [visiblePhotos.length]);

    const previousMediaLibraryRefreshVersionRef = useRef(mediaLibraryRefreshVersion);
    useEffect(() => {
        if (mediaLibraryRefreshVersion === previousMediaLibraryRefreshVersionRef.current) return;
        previousMediaLibraryRefreshVersionRef.current = mediaLibraryRefreshVersion;

        // A library or permission change invalidates the local preview and
        // collection dialog, whose route/asset snapshot may no longer be
        // accessible. Persisted review queues are kept for recovery, but are
        // filtered separately by the permission-aware queue projection.
        setPreviewPhoto(null);
        setReviewPage(0);
        setKeptAllReviewPhotos(false);
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

    // Batch review returns before the deck; feedback must exist in both.
    // Text-only feedback also avoids showing a success icon for failures.
    const toast = toastMessage && (
        <View pointerEvents="none" style={styles.toastContainer}>
            <View style={[styles.toast, { backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)' }]}>
                <Text accessibilityLiveRegion="polite" style={[styles.toastText, { color: colors.text }]}>{toastMessage}</Text>
            </View>
        </View>
    );

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

    const handleKeepReviewPhoto = (assetId: string) => {
        if (!visibleDeleteQueueIds.includes(assetId)) return;
        if (!useMediaStore.getState().keepPhotoFromDeleteQueue(assetId)) return;
        // A restored queue may have no in-memory batch. Keep its last-item
        // completion visible until Continue, without reloading processed media.
        setKeptAllReviewPhotos(visibleDeleteQueue.length === 1);
        setReviewPage(Math.min(currentReviewPage, Math.max(0, Math.ceil((visibleDeleteQueue.length - 1) / REVIEW_PAGE_SIZE) - 1)));
    };

    const handleBatchFinished = () => {
        // Keep the completed batch visible until the user chooses to continue.
        if (visibleDeleteQueue.length === 0) {
            return (
                <ScrollView style={styles.reviewScroll} contentContainerStyle={styles.completedContent}>
                    <Text accessibilityRole="header" style={[styles.reviewTitle, { color: colors.text }]}>{t('photos_finished')}</Text>
                    <Text style={[styles.completedDescription, { color: colors.textSecondary }]}>{t('no_delete_this_batch')}</Text>
                    <Pressable
                        accessibilityRole="button"
                        style={[styles.reviewButton, { backgroundColor: colors.actionBackground }]}
                        onPress={() => {
                            setKeptAllReviewPhotos(false);
                            resetBatch(visibleDeleteQueueIds);
                            loadPhotos(groupSize, displayOrder, selectedAlbumIds);
                        }}
                    >
                        <Text style={[styles.reviewButtonText, { color: colors.actionForeground }]}>{t('continue_next_batch')}</Text>
                    </Pressable>
                </ScrollView>
            );
        }

        return (
            <View style={styles.reviewLayout}>
                <ScrollView style={styles.reviewScroll} contentContainerStyle={styles.reviewContent}>
                    <Text accessibilityRole="header" style={[styles.reviewTitle, { color: colors.text }]}>{t('photos_review_title')}</Text>
                    <Text style={[styles.reviewCount, { color: colors.textSecondary }]}>{t('photos_review_pending', { count: visibleDeleteQueue.length })}</Text>
                    <Text style={[styles.reviewHint, { color: colors.textSecondary }]}>{t('thumbnail_tap_undo')}</Text>

                    {/* Thumbnails Grid */}
                    <View style={styles.thumbnailsGrid}>
                        {reviewPhotos.map((photo, index) => (
                            <Pressable
                                key={photo.id}
                                accessibilityRole="button"
                                accessibilityLabel={t('photos_review_undo', { number: currentReviewPage * REVIEW_PAGE_SIZE + index + 1 })}
                                accessibilityHint={t('photos_review_preview_hint')}
                                accessibilityState={{ disabled: isConfirmingDeletion }}
                                onPress={() => handleKeepReviewPhoto(photo.id)}
                                onLongPress={() => setPreviewPhoto(photo)}
                                delayLongPress={200}
                                disabled={isConfirmingDeletion}
                                style={isConfirmingDeletion && { opacity: 0.5 }}
                            >
                                <Image source={{ uri: photo.uri }} style={[styles.thumbnail, { width: reviewThumbnailSize, height: reviewThumbnailSize }]} />
                                <View style={styles.undoOverlay}>
                                    <Ionicons name="arrow-undo-outline" size={16} color="white" />
                                </View>
                            </Pressable>
                        ))}
                    </View>
                    {reviewPageCount > 1 && (
                        <View style={styles.reviewPagination}>
                            <Pressable
                                accessibilityRole="button"
                                disabled={isConfirmingDeletion || currentReviewPage === 0}
                                onPress={() => setReviewPage(currentReviewPage - 1)}
                                style={[styles.reviewPageButton, { opacity: isConfirmingDeletion || currentReviewPage === 0 ? 0.4 : 1 }]}
                            >
                                <Text style={[styles.reviewPageText, { color: colors.text }]}>{t('photos_review_previous')}</Text>
                            </Pressable>
                            <Text style={[styles.reviewPageText, { color: colors.textSecondary }]}>{t('photos_review_page', { current: currentReviewPage + 1, total: reviewPageCount })}</Text>
                            <Pressable
                                accessibilityRole="button"
                                disabled={isConfirmingDeletion || currentReviewPage === reviewPageCount - 1}
                                onPress={() => setReviewPage(currentReviewPage + 1)}
                                style={[styles.reviewPageButton, { opacity: isConfirmingDeletion || currentReviewPage === reviewPageCount - 1 ? 0.4 : 1 }]}
                            >
                                <Text style={[styles.reviewPageText, { color: colors.text }]}>{t('photos_review_next')}</Text>
                            </Pressable>
                        </View>
                    )}
                </ScrollView>

                <View testID="photo-review-actions" style={[styles.reviewActions, { borderTopColor: colors.divider }]}>
                    <Text style={[styles.reviewWarning, { color: colors.textSecondary }]}>{t('photos_review_warning')}</Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: isConfirmingDeletion, busy: isConfirmingDeletion }}
                        style={[styles.reviewButton, { backgroundColor: colors.dangerBackground }, isConfirmingDeletion && { opacity: 0.6 }]}
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
                        <Text style={[styles.reviewButtonText, { color: colors.dangerForeground }]}>{t('photos_confirm')}</Text>
                    </Pressable>

                    <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: isConfirmingDeletion }}
                        style={({ pressed }) => [styles.reviewButton, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }, isConfirmingDeletion && { opacity: 0.6 }]}
                        onPress={() => {
                            resetBatch(visibleDeleteQueueIds);
                            loadPhotos(groupSize, displayOrder, selectedAlbumIds);
                        }}
                        disabled={isConfirmingDeletion}
                    >
                        <Text style={[styles.reviewButtonText, { color: colors.text }]}>{t('photos_skip')}</Text>
                    </Pressable>
                </View>
            </View>
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
    if (visiblePhotos.length === 0 && (photos.length > 0 || visibleDeleteQueue.length > 0 || (keptAllReviewPhotos && permissionScope !== 'none'))) {
        return (
            <View testID="photo-review" style={[styles.container, {
                paddingTop: insets.top,
                paddingBottom: UI_METRICS.dockHeight + insets.bottom,
                paddingLeft: insets.left,
                paddingRight: insets.right,
                backgroundColor: colors.background,
            }]}>
                {handleBatchFinished()}
                {toast}

                <PhotoPreviewModal photo={previewPhoto} onClose={() => setPreviewPhoto(null)} />
            </View>
        )
    }

    if (photos.length === 0 && !showHome) {
        const hasLimitedPhotoAccess = permissionScope === 'limited';
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                <Text accessibilityRole={photoLoadFailed ? 'alert' : undefined} style={[styles.emptyText, { color: colors.text }]}>
                    {photoLoadFailed ? t('photos_load_failed') : hasLimitedPhotoAccess ? t('photos_limited_access_desc') : t('photos_empty')}
                </Text>
                {photoLoadFailed && <Text style={[styles.readErrorDescription, { color: colors.textSecondary }]}>{t('media_load_retry_desc')}</Text>}
                {hasLimitedPhotoAccess && (
                    <Pressable
                        onPress={handleManagePhotoAccess}
                        disabled={managingPhotoAccess}
                        style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: managingPhotoAccess ? 0.6 : 1 }]}
                    >
                        <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>
                            {managingPhotoAccess ? t('permission_requesting') : t('photos_manage_access')}
                        </Text>
                    </Pressable>
                )}
                <Pressable
                    accessibilityRole="button"
                    onPress={() => loadPhotos(groupSize, displayOrder, selectedAlbumIds)}
                    disabled={managingPhotoAccess}
                    style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: managingPhotoAccess ? 0.6 : 1, marginTop: hasLimitedPhotoAccess ? 10 : 0 }]}
                >
                    <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>{t('photos_reload')}</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowHome(true)}
                    style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: SPACING.m }]}
                >
                    <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('photos_back_home')}</Text>
                </Pressable>
            </View>
        )
    }

    // Only offer the visual entry for an untouched in-memory batch. The
    // already-open deck stays open as items are processed.
    if (showHome && visiblePhotos.length === photos.length) {
        const previewPhotos = visiblePhotos.slice(0, 3);
        return (
            <View testID="photos-home" style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
                <ScrollView
                    contentContainerStyle={[styles.homeContent, { paddingTop: 16, paddingBottom: insets.bottom + UI_METRICS.dockHeight + 24 }]}
                    showsVerticalScrollIndicator={false}
                >
                    <View style={styles.homeBrandRow}>
                        <View style={styles.homeBrand}>
                            <Text style={[styles.homeBrandText, { color: colors.text }]}>PickPic</Text>
                        </View>
                    </View>

                    <View style={styles.homeHero}>
                        <Text accessibilityRole="header" style={[styles.homeTitle, { color: colors.text }]}>{t('photos_home_title')}</Text>
                        <View style={styles.homeCountRow}>
                            <Text style={[styles.homeScope, { color: colors.textSecondary }]}>{t('photos_home_scope')}</Text>
                            <View style={styles.homeCountSummary}>
                                <Text style={[styles.homeCount, { color: colors.text }]}>{photoLoadFailed ? '—' : visiblePhotos.length}</Text>
                                <Text style={[styles.homeCountLabel, { color: colors.textSecondary }]}>{t('photos_home_pending')}</Text>
                            </View>
                        </View>
                    </View>

                    <View style={styles.homePreviewSection}>
                        {previewPhotos.length > 0 ? <View accessibilityLabel={t('photos_home_preview')} style={[styles.homeMosaic, { height: previewHeight }]}>
                            <Image source={{ uri: previewPhotos[0].uri }} style={[styles.homeMosaicLarge, { backgroundColor: colors.surfaceHover }]} resizeMode="cover" />
                            {previewPhotos.length > 1 && (
                                <View style={styles.homeMosaicSide}>
                                    {previewPhotos.slice(1).map(photo => (
                                        <Image key={photo.id} source={{ uri: photo.uri }} style={[styles.homeMosaicSmall, { backgroundColor: colors.surfaceHover }]} resizeMode="cover" />
                                    ))}
                                </View>
                            )}
                        </View> : <View style={styles.homeEmpty}>
                            <Text accessibilityRole={photoLoadFailed ? 'alert' : undefined} style={[{ color: colors.textSecondary, textAlign: 'center', fontSize: 15, lineHeight: 22 }, photoLoadFailed && styles.readErrorTitle]}>
                                {t(photoLoadFailed ? 'photos_load_failed' : permissionScope === 'limited' ? 'photos_limited_access_desc' : 'photos_empty')}
                            </Text>
                            {photoLoadFailed && <Text style={[styles.readErrorDescription, { color: colors.textSecondary }]}>{t('media_load_retry_desc')}</Text>}
                            {permissionScope === 'limited' && (
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={handleManagePhotoAccess}
                                    disabled={managingPhotoAccess}
                                    style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: SPACING.m, opacity: managingPhotoAccess ? 0.6 : 1 }]}
                                >
                                    <Text style={[styles.actionButtonText, { color: colors.text }]}>
                                        {t(managingPhotoAccess ? 'permission_requesting' : 'photos_manage_access')}
                                    </Text>
                                </Pressable>
                            )}
                        </View>}
                    </View>

                    <Pressable
                        onPress={() => {
                            if (visiblePhotos.length > 0) setShowHome(false);
                            else void loadPhotos(groupSize, displayOrder, selectedAlbumIds);
                        }}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.homeStart, {
                            backgroundColor: colors.actionBackground,
                            opacity: pressed ? 0.8 : 1,
                            transform: [{ scale: pressed ? 0.985 : 1 }],
                        }]}
                    >
                        <Text style={[styles.homeStartLabel, { color: colors.actionForeground }]}>{t(visiblePhotos.length > 0 ? 'photos_home_start' : 'photos_reload')}</Text>
                        <Feather name={visiblePhotos.length > 0 ? 'arrow-right' : 'refresh-cw'} size={19} color={colors.actionForeground} />
                    </Pressable>

                    {permissionScope === 'limited' && previewPhotos.length > 0 && (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ disabled: managingPhotoAccess, busy: managingPhotoAccess }}
                            onPress={handleManagePhotoAccess}
                            disabled={managingPhotoAccess}
                            style={[styles.homeAccessButton, { opacity: managingPhotoAccess ? 0.6 : 1 }]}
                        >
                            <Text style={{ color: colors.textSecondary, fontSize: 15 }}>
                                {t(managingPhotoAccess ? 'permission_requesting' : 'photos_manage_access')}
                            </Text>
                        </Pressable>
                    )}

                    <Pressable
                        onPress={() => setShowAlbumSelector(true)}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.homeAlbumRow, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                    >
                        <View style={styles.homeAlbumIcon}>
                            <Feather name="folder" size={20} color={colors.textSecondary} />
                        </View>
                        <View style={styles.homeAlbumCopy}>
                            <Text style={[styles.homeAlbumTitle, { color: colors.text }]}>{t('photos_home_album')}</Text>
                            <Text style={[styles.homeAlbumHint, { color: colors.textSecondary }]}>{t('photos_home_album_hint')}</Text>
                        </View>
                        <Feather name="chevron-right" size={18} color={colors.textSecondary} />
                    </Pressable>
                </ScrollView>
                <AlbumSelector
                    visible={showAlbumSelector}
                    onClose={() => setShowAlbumSelector(false)}
                    initialSelection={selectedAlbumIds}
                    onConfirm={(ids) => {
                        setSelectedAlbums(ids);
                        setShowAlbumSelector(false);
                    }}
                />
            </View>
        );
    }

    return (
        <View testID="photos-deck" style={[styles.container, {
            paddingTop: insets.top,
            paddingBottom: UI_METRICS.dockHeight + insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
            backgroundColor: colors.background,
        }]}>
            <View style={styles.header}>
                <View style={styles.deckHeaderRow}>
                    <Text style={[styles.headerTitle, { color: colors.text }]}>{t('photos_header')}</Text>
                    <Text style={[styles.deckCounter, { color: colors.textSecondary }]}>
                        {photos.length - visiblePhotos.length + 1} / {photos.length}
                    </Text>
                </View>
                <View style={[styles.deckProgressTrack, { backgroundColor: colors.divider }]}>
                    <View style={[styles.deckProgressFill, {
                        backgroundColor: colors.text,
                        width: `${((photos.length - visiblePhotos.length + 1) / photos.length) * 100}%`,
                    }]} />
                </View>
            </View>

            <View testID="photos-deck-viewport" style={styles.deckContainer} onLayout={({ nativeEvent }) => {
                const { width: measuredWidth, height: measuredHeight } = nativeEvent.layout;
                setDeckSize(current => current.width === measuredWidth && current.height === measuredHeight
                    ? current : { width: measuredWidth, height: measuredHeight });
            }}>
                {deckSize.width > 40 && deckSize.height > 16 && visiblePhotos.slice(0, 2).reverse().map((photo, index) => {
                    const realIndex = visiblePhotos.indexOf(photo);
                    return (
                        <PhotoCard
                            key={photo.id}
                            photo={photo}
                            index={realIndex}
                            total={visiblePhotos.length}
                            maxWidth={Math.min(deckSize.width, width - insets.left - insets.right) - UI_METRICS.pageInset * 2}
                            maxHeight={deckSize.height - 16}
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
            <View style={styles.deckFooter}>
                <View style={styles.footerHints}>
                    <View style={styles.hintItem}>
                        <Ionicons name="arrow-up-outline" size={20} color={colors.danger} />
                        <Text style={[styles.hintText, { color: colors.textSecondary }]}>{t('hint_swipe_up')}</Text>
                    </View>
                    <View style={styles.hintItem}>
                        <Ionicons name="arrow-down-outline" size={20} color={colors.textSecondary} />
                        <Text style={[styles.hintText, { color: colors.textSecondary }]}>{t('hint_swipe_down')}</Text>
                    </View>
                </View>
                <Text style={[styles.queueHint, { color: colors.textSecondary }]}>{t('photos_queue_review_hint')}</Text>
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
                    <Pressable style={[styles.actionButton, { backgroundColor: colors.actionBackground }]} onPress={handleCreateAlbum}>
                        <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>{t('album_create_btn')}</Text>
                    </Pressable>
                    <Pressable style={[styles.actionButton, { backgroundColor: 'transparent', marginTop: 10 }]} onPress={() => setShowNewAlbumModal(false)}>
                        <Text style={[styles.actionButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
                    </Pressable>
                </GlassContainer>
            )}

            {/* Toast */}
            {toast}

        </View>
    );
}

const styles = StyleSheet.create({
    homeAccessButton: {
        minHeight: 44,
        marginTop: SPACING.s,
        paddingHorizontal: SPACING.m,
        alignItems: 'center',
        justifyContent: 'center',
    },
    homeContent: {
        flexGrow: 1,
        paddingHorizontal: UI_METRICS.pageInset,
    },
    homeBrandRow: {
        minHeight: 36,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    homeBrand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    homeBrandText: {
        ...TYPOGRAPHY.sectionTitle,
    },
    homeHero: {
        marginTop: 24,
    },
    homeTitle: {
        ...TYPOGRAPHY.pageTitle,
    },
    homeScope: {
        ...TYPOGRAPHY.secondary,
    },
    homeCountRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
    },
    homeCountSummary: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
    homeCount: {
        fontSize: 18,
        lineHeight: 26,
        fontWeight: '500',
        fontVariant: ['tabular-nums'],
        flexShrink: 1,
    },
    homeCountLabel: {
        ...TYPOGRAPHY.caption,
    },
    homeStart: {
        minHeight: 54,
        marginTop: 24,
        gap: 12,
        paddingVertical: 15,
        borderRadius: 27,
        paddingHorizontal: 22,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
    },
    homeStartLabel: {
        ...TYPOGRAPHY.button,
        flexShrink: 1,
        textAlign: 'center',
    },
    homePreviewSection: {
        marginTop: 20,
    },
    homeMosaic: {
        flexDirection: 'row',
        gap: 8,
    },
    homeEmpty: {
        minHeight: 224,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
    },
    homeMosaicLarge: {
        flex: 1.35,
        height: '100%',
        borderRadius: 18,
    },
    homeMosaicSide: {
        flex: 1,
        gap: 8,
    },
    homeMosaicSmall: {
        flex: 1,
        width: '100%',
        borderRadius: 18,
    },
    homeAlbumRow: {
        marginTop: 20,
        borderRadius: 16,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 72,
    },
    homeAlbumIcon: {
        width: 24,
        height: UI_METRICS.touchTarget,
        alignItems: 'center',
        justifyContent: 'center',
    },
    homeAlbumCopy: {
        flex: 1,
        gap: 4,
    },
    homeAlbumTitle: {
        ...TYPOGRAPHY.body,
        fontWeight: '500',
    },
    homeAlbumHint: {
        ...TYPOGRAPHY.secondary,
    },
    container: {
        flex: 1,
    },
    readErrorTitle: { ...TYPOGRAPHY.sectionTitle, marginBottom: 12 },
    readErrorDescription: { ...TYPOGRAPHY.body, textAlign: 'center', marginHorizontal: UI_METRICS.pageInset, marginBottom: 20 },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    reviewContent: {
        flexGrow: 1,
        flexShrink: 0,
        paddingHorizontal: UI_METRICS.pageInset,
        paddingTop: 16,
        paddingBottom: 16,
    },
    reviewLayout: { flex: 1 },
    reviewScroll: { flex: 1, minHeight: 0 },
    reviewTitle: { ...TYPOGRAPHY.pageTitle },
    reviewCount: { ...TYPOGRAPHY.secondary, marginTop: 8, fontVariant: ['tabular-nums'] },
    reviewHint: { ...TYPOGRAPHY.secondary, marginTop: 16, marginBottom: 16 },
    reviewPageText: { ...TYPOGRAPHY.secondary },
    reviewActions: { paddingHorizontal: UI_METRICS.pageInset, paddingTop: 12, paddingBottom: 8, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
    reviewWarning: { ...TYPOGRAPHY.caption },
    reviewButton: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
    reviewButtonText: { ...TYPOGRAPHY.button, textAlign: 'center' },
    completedContent: { flexGrow: 1, flexShrink: 0, padding: UI_METRICS.pageInset, justifyContent: 'center', gap: 16 },
    completedDescription: { ...TYPOGRAPHY.body, marginBottom: 8 },
    header: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingTop: 12,
        paddingBottom: 10,
    },
    headerTitle: {
        ...TYPOGRAPHY.pageTitle,
        flex: 1,
        minWidth: 0,
    },
    deckHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
    },
    deckCounter: {
        ...TYPOGRAPHY.secondary,
        flexShrink: 0,
        fontVariant: ['tabular-nums'],
    },
    deckProgressTrack: {
        height: 2,
        marginTop: 12,
        borderRadius: 1,
        overflow: 'hidden',
    },
    deckProgressFill: {
        height: '100%',
        borderRadius: 1,
    },
    deckContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerHints: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
        gap: 16,
    },
    deckFooter: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingTop: 12,
        paddingBottom: 16,
        gap: 12,
    },
    queueHint: {
        ...TYPOGRAPHY.caption,
        textAlign: 'center',
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
        flex: 1,
        minWidth: 0,
    },
    hintText: {
        marginTop: 4,
        ...TYPOGRAPHY.secondary,
        textAlign: 'center',
    },
    emptyText: {
        fontSize: 20,
        marginBottom: 20
    },
    thumbnailsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-start',
        gap: 8,
    },
    thumbnail: {
        borderRadius: 8
    },
    undoOverlay: {
        position: 'absolute',
        bottom: 6,
        right: 6,
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.65)',
        borderRadius: 6,
    },
    reviewPagination: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 8,
        marginTop: SPACING.s,
    },
    reviewPageButton: {
        minHeight: 44,
        paddingHorizontal: SPACING.s,
        justifyContent: 'center',
    },
    actionButton: {
        minHeight: UI_METRICS.buttonHeight,
        paddingHorizontal: 24,
        paddingVertical: 14,
        borderRadius: UI_METRICS.buttonRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionButtonText: {
        ...TYPOGRAPHY.button
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
