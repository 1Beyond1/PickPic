import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { useFocusEffect } from 'expo-router';
import * as MediaLibrary from 'expo-media-library';
// import { BlurView } from 'expo-blur'; // Removed to fix crash
// import { Image } from 'expo-image'; // Removed to fix crash
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Image, Linking, NativeScrollEvent, NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, Text, View, ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlbumSelector } from '../../components/AlbumSelector';
import { BottomSheet } from '../../components/BottomSheet';
import { VideoFeedItem } from '../../components/VideoFeedItem';
import { BORDER_RADIUS, COLORS, TYPOGRAPHY, UI_METRICS } from '../../constants/theme';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

export default function VideosScreen() {
    const insets = useSafeAreaInsets();
    const isFocused = useIsFocused();
    const { t, language } = useI18n();
    const { colors } = useThemeColor();

    const {
        videos, loadVideos, isLoading, hasHydrated,
        markVideoForTrash, markVideoAsProcessed, videoTrashBin, confirmVideoTrash, restoreFromTrash,
        isConfirmingVideoTrash,
        addAssetToAlbum, hiddenVideoQueuedAssetIds, mediaLibraryRefreshVersion,
    } = useMediaStore();
    const {
        displayOrder,
        selectedAlbumIds,
        hasHydrated: settingsHydrated,
    } = useSettingsStore();

    const [activeId, setActiveId] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(true);
    const [showTrash, setShowTrash] = useState(false);
    const [trashDeleteFailed, setTrashDeleteFailed] = useState(false);
    const [showAlbumSelector, setShowAlbumSelector] = useState(false);
    const [selectedVideoForCollection, setSelectedVideoForCollection] = useState<any>(null);
    const [isScreenFocused, setIsScreenFocused] = useState(true);
    // Derive the notice from the current feed and visible identity. Removing
    // an item directly (e.g. into trash) need not emit another viewability event.
    const isAtEnd = videos.length > 0 && activeId === videos[videos.length - 1].id;
    const [videoPermission, setVideoPermission] = useState<MediaLibrary.PermissionResponse | null>(null);
    const [videoPermissionChecked, setVideoPermissionChecked] = useState(false);
    const [requestingVideoPermission, setRequestingVideoPermission] = useState(false);
    const videoPermissionRequestIdRef = useRef(0);
    const isFocusedRef = useRef(isFocused);
    isFocusedRef.current = isFocused;
    const lastActiveIdRef = useRef<string | null>(null);
    const visibleIdRef = useRef<string | null>(null);
    const feedRef = useRef<FlatList>(null);
    const videosRef = useRef(videos);
    videosRef.current = videos;
    const hiddenQueueIds = new Set(hiddenVideoQueuedAssetIds ?? []);
    const videoPermissionScope = !videoPermission?.granted
        ? 'none'
        : videoPermission.accessPrivileges === 'limited'
            ? 'limited'
            : 'full';
    const hasLimitedVideoAccess = videoPermission?.accessPrivileges === 'limited';
    const visibleVideoTrashBin = videoPermissionScope === 'full' && hiddenVideoQueuedAssetIds === null
        ? videoTrashBin
        : videoPermissionScope === 'limited' && hasHydrated && hiddenVideoQueuedAssetIds !== null
            ? videoTrashBin.filter(video => !hiddenQueueIds.has(video.id))
            : [];

    const refreshVideoPermission = useCallback(async (): Promise<MediaLibrary.PermissionResponse | null> => {
        const requestId = ++videoPermissionRequestIdRef.current;
        // Do not leave a previously loaded video batch visible while the OS
        // permission state is being revalidated (for example after returning
        // from system settings).
        setVideoPermission(null);
        setVideoPermissionChecked(false);
        try {
            const permission = await MediaLibrary.getPermissionsAsync(false, ['video']);
            if (requestId !== videoPermissionRequestIdRef.current) return null;
            setVideoPermission(permission);
            setVideoPermissionChecked(true);
            const scope = !permission.granted
                ? 'none'
                : permission.accessPrivileges === 'limited'
                    ? 'limited'
                    : 'full';
            const mediaStore = useMediaStore.getState();
            mediaStore.refreshQueuedAssetVisibility(scope, 'video');
            mediaStore.pruneUnavailableQueuedAssets(scope, 'video');
            return permission;
        } catch (error) {
            if (requestId !== videoPermissionRequestIdRef.current) return null;
            console.error('[Videos] Failed to refresh video permission:', error);
            setVideoPermission(null);
            setVideoPermissionChecked(true);
            useMediaStore.getState().refreshQueuedAssetVisibility('none', 'video');
            return null;
        }
    }, []);

    // A refresh can replace the FlatList while this tab remains focused.
    // The next viewability callback belongs to the new list, so carrying the
    // previous list's active ID forward would incorrectly mark that old item
    // as processed even though the user never swiped past it.
    useLayoutEffect(() => {
        if (!isLoading) return;
        lastActiveIdRef.current = null;
        visibleIdRef.current = null;
        setActiveId(null);
    }, [isLoading]);

    const previousMediaLibraryRefreshVersionRef = useRef(mediaLibraryRefreshVersion);
    useEffect(() => {
        if (mediaLibraryRefreshVersion === previousMediaLibraryRefreshVersionRef.current) return;
        previousMediaLibraryRefreshVersionRef.current = mediaLibraryRefreshVersion;
        let active = true;

        // Close local previews/selectors when the underlying media snapshot
        // changes. Persisted trash is retained for recovery and projected
        // through the permission-aware visible list above.
        setShowTrash(false);
        setShowAlbumSelector(false);
        setSelectedVideoForCollection(null);
        // Recheck a video permission change reported while this tab remains
        // mounted, including a grant made from system settings.
        if (hasHydrated && settingsHydrated && isFocused) {
            void refreshVideoPermission().then(permission => {
                if (active && permission?.granted && isFocusedRef.current) {
                    void loadVideos(50, displayOrder, selectedAlbumIds);
                }
            });
        }

        return () => {
            active = false;
        };
    }, [
        displayOrder,
        selectedAlbumIds,
        hasHydrated,
        settingsHydrated,
        isFocused,
        loadVideos,
        mediaLibraryRefreshVersion,
        refreshVideoPermission,
    ]);

    // Measure only the feed viewport, excluding header, hints and the dock.
    const [feedHeight, setFeedHeight] = useState(0);
    useLayoutEffect(() => {
        if (!feedHeight) return;
        const index = videosRef.current.findIndex(video => video.id === visibleIdRef.current);
        if (index > 0) feedRef.current?.scrollToOffset({ offset: index * feedHeight, animated: false });
    }, [feedHeight]);

    useFocusEffect(useCallback(() => {
        if (!hasHydrated || !settingsHydrated) return;
        let active = true;
        const refreshAndLoad = async () => {
            const permission = await refreshVideoPermission();
            if (active && permission?.granted) {
                await loadVideos(50, displayOrder, selectedAlbumIds);
            }
        };
        void refreshAndLoad();
        return () => {
            active = false;
        };
    }, [
        displayOrder,
        selectedAlbumIds,
        hasHydrated,
        settingsHydrated,
        loadVideos,
        refreshVideoPermission,
    ]));

    useEffect(() => {
        let active = true;
        const subscription = AppState.addEventListener('change', nextState => {
            if (!active || nextState !== 'active' || !hasHydrated || !settingsHydrated || !isFocusedRef.current) return;
            void refreshVideoPermission().then(permission => {
                if (active && permission?.granted && isFocusedRef.current) {
                    void loadVideos(50, displayOrder, selectedAlbumIds);
                }
            });
        });

        return () => {
            active = false;
            subscription.remove();
        };
    }, [
        displayOrder,
        selectedAlbumIds,
        hasHydrated,
        settingsHydrated,
        isFocused,
        loadVideos,
        refreshVideoPermission,
    ]);

    useFocusEffect(
        useCallback(() => {
            setIsScreenFocused(true);
            setActiveId(null);
            lastActiveIdRef.current = null;
            visibleIdRef.current = null;
            return () => {
                setIsScreenFocused(false);
                setShowTrash(false);
                setShowAlbumSelector(false);
                setSelectedVideoForCollection(null);

                // Leaving the tab is not a review action. Keep the current
                // video unprocessed so an accidental tab switch does not
                // silently remove it from the feed on the next visit.
                lastActiveIdRef.current = null;
            };
        }, [])
    );

    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        const newActiveId = viewableItems[0]?.key;
        if (!newActiveId) return;
        visibleIdRef.current = newActiveId;
        setActiveId(newActiveId);
        // Visibility drives playback, not review progress: a half-finished
        // drag can reveal the next video and then snap back to this one.
        if (!lastActiveIdRef.current) lastActiveIdRef.current = newActiveId;
    }, []);

    const onMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (!feedHeight || !isFocusedRef.current) return;
        const currentVideos = videosRef.current;
        const newIndex = Math.round(event.nativeEvent.contentOffset.y / feedHeight);
        const nextVideo = currentVideos[newIndex];
        if (!nextVideo) return;
        const newActiveId = nextVideo.id;
        const previousActiveId = lastActiveIdRef.current;
        if (previousActiveId && previousActiveId !== newActiveId) {
            const previousIndex = currentVideos.findIndex(video => video.id === previousActiveId);
            const isAdvancing = previousIndex >= 0 && newIndex > previousIndex;

            if (isAdvancing) {
                const prevVideo = currentVideos[previousIndex];
                if (prevVideo) {
                    markVideoAsProcessed(prevVideo);
                }
            }
        }
        lastActiveIdRef.current = newActiveId;
        visibleIdRef.current = newActiveId;
        setActiveId(newActiveId);
    }, [feedHeight, markVideoAsProcessed]);

    // View config ref
    const viewabilityConfig = useRef({
        itemVisiblePercentThreshold: 50,
    }).current;

    const handleFavorite = (video: any) => {
        setSelectedVideoForCollection(video);
        setShowAlbumSelector(true);
    };

    const handleConfirmCollection = async (ids: string[]) => {
        if (selectedVideoForCollection && ids.length > 0) {
            try {
                await Promise.all(ids.map(id => addAssetToAlbum(id, selectedVideoForCollection)));
            } catch (error) {
                console.error('Failed to collect video', error);
                Alert.alert(
                    language === 'zh' ? '收藏失败' : 'Collection failed',
                    language === 'zh' ? '请重试，原视频未被删除。' : 'Please try again. The original video was not deleted.'
                );
            }
        }
        setShowAlbumSelector(false);
        setSelectedVideoForCollection(null);
    };

    const handleRestoreFromTrash = (assetId: string) => {
        restoreFromTrash(assetId);
        setTrashDeleteFailed(false);
        // A persisted trash item may belong to the filter that was active in
        // an earlier session. Re-query the current scope instead of blindly
        // inserting the restored asset into this feed.
        void loadVideos(50, displayOrder, selectedAlbumIds);
    };

    const onLayout = (event: any) => {
        const { height } = event.nativeEvent.layout;
        if (height > 0 && Math.abs(height - feedHeight) > 1) {
            setFeedHeight(height);
        }
    };

    const handleRequestVideoPermission = async () => {
        const requestId = ++videoPermissionRequestIdRef.current;
        if (videoPermission?.canAskAgain === false) {
            try {
                await Linking.openSettings();
            } catch (error) {
                console.error('[Videos] Failed to open system settings:', error);
            }
            return;
        }

        setRequestingVideoPermission(true);
        try {
            const permission = await MediaLibrary.requestPermissionsAsync(false, ['video']);
            if (requestId !== videoPermissionRequestIdRef.current) return;
            setVideoPermission(permission);
            setVideoPermissionChecked(true);
            const scope = !permission.granted
                ? 'none'
                : permission.accessPrivileges === 'limited'
                    ? 'limited'
                    : 'full';
            const mediaStore = useMediaStore.getState();
            mediaStore.refreshQueuedAssetVisibility(scope, 'video');
            mediaStore.pruneUnavailableQueuedAssets(scope, 'video');
            if (permission.granted && isFocusedRef.current) {
                await loadVideos(50, displayOrder, selectedAlbumIds);
            }
        } catch (error) {
            console.error('[Videos] Failed to request video permission:', error);
        } finally {
            setRequestingVideoPermission(false);
        }
    };

    const handleRetryVideoPermission = async () => {
        if (requestingVideoPermission) return;
        setRequestingVideoPermission(true);
        try {
            const permission = await refreshVideoPermission();
            if (permission?.granted && isFocusedRef.current) {
                await loadVideos(50, displayOrder, selectedAlbumIds);
            }
        } finally {
            setRequestingVideoPermission(false);
        }
    };

    const handleManageVideoAccess = async () => {
        if (requestingVideoPermission) return;
        setRequestingVideoPermission(true);
        try {
            // Android 14 may expose a global limited grant while no videos
            // were selected. Open the type-scoped picker instead of treating
            // that response as proof that the video feed is accessible.
            await MediaLibrary.presentPermissionsPickerAsync(['video']);
            const permission = await refreshVideoPermission();
            if (permission?.granted && isFocusedRef.current) {
                await loadVideos(50, displayOrder, selectedAlbumIds);
            }
        } catch (error) {
            console.error('[Videos] Failed to manage video access:', error);
        } finally {
            setRequestingVideoPermission(false);
        }
    };

    if (!videoPermissionChecked) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    if (!videoPermission) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background, paddingHorizontal: 24 }]}>
                <Text style={[styles.emptyText, { color: colors.text, textAlign: 'center' }]}>
                    {t('video_permission_unavailable_desc')}
                </Text>
                <Pressable
                    onPress={handleRetryVideoPermission}
                    disabled={requestingVideoPermission}
                    style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: requestingVideoPermission ? 0.6 : 1 }]}
                >
                    <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>
                        {requestingVideoPermission ? t('permission_requesting') : t('video_permission_retry_btn')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    if (!videoPermission.granted) {
        const canAskAgain = videoPermission.canAskAgain !== false;
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background, paddingHorizontal: 24 }]}>
                <Text style={[styles.emptyText, { color: colors.text, textAlign: 'center' }]}>
                    {canAskAgain ? t('video_permission_desc') : t('video_permission_denied_desc')}
                </Text>
                <Pressable
                    onPress={handleRequestVideoPermission}
                    disabled={requestingVideoPermission}
                    style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: requestingVideoPermission ? 0.6 : 1 }]}
                >
                    <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>
                        {requestingVideoPermission
                            ? t('permission_requesting')
                            : canAskAgain
                                ? t('video_permission_btn')
                                : t('permission_open_settings')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: 65 + insets.bottom }]}>
            <View style={styles.pageHeader}>
                <View style={styles.heading}>
                    <Text style={[styles.pageTitle, { color: colors.text }]}>{t('video_organize')}</Text>
                    {videos.length > 0 && !isLoading && (
                        <Text style={[styles.pageCount, { color: colors.textSecondary }]}>
                            {Math.max(1, videos.findIndex(video => video.id === activeId) + 1)} / {videos.length}
                        </Text>
                    )}
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${t('video_trash_title')} · ${visibleVideoTrashBin.length}`}
                    onPress={() => { setTrashDeleteFailed(false); setShowTrash(true); }}
                    style={({ pressed }) => [styles.trashIcon, { backgroundColor: pressed ? colors.selectionBackground : 'transparent', opacity: pressed ? 0.6 : 1 }]}
                >
                    <Ionicons name="trash-bin-outline" size={20} color={colors.text} />
                    <Text style={[styles.trashCount, { color: visibleVideoTrashBin.length ? colors.danger : colors.textSecondary }]}>
                        {visibleVideoTrashBin.length > 99 ? '99+' : visibleVideoTrashBin.length}
                    </Text>
                </Pressable>
            </View>
            <View style={styles.feedViewport} onLayout={onLayout} testID="video-feed-viewport">
            {/* Feed */}
            {isLoading ? (
                <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            ) : videos.length > 0 && feedHeight > 0 ? (
                <FlatList
                    ref={feedRef}
                    data={videos}
                    keyExtractor={item => item.id}
                    renderItem={({ item }) => (
                        <VideoFeedItem
                            video={item}
                            isActive={item.id === activeId}
                            isScreenFocused={isScreenFocused}
                            shouldPlay={item.id === activeId && isScreenFocused && !showTrash && !showAlbumSelector}
                            isMuted={isMuted}
                            toggleMute={() => setIsMuted(prev => !prev)}
                            onDelete={() => markVideoForTrash(item)}
                            onFavorite={() => handleFavorite(item)}
                            t={t}
                            colors={colors}
                            itemHeight={feedHeight}
                        />
                    )}
                    pagingEnabled
                    showsVerticalScrollIndicator={false}
                    onViewableItemsChanged={onViewableItemsChanged}
                    onMomentumScrollEnd={onMomentumScrollEnd}
                    viewabilityConfig={viewabilityConfig}
                    snapToInterval={feedHeight}
                    snapToAlignment="start"
                    decelerationRate="fast"
                    disableIntervalMomentum={true}
                    overScrollMode="never"
                    bounces={false}
                    getItemLayout={(data, index) => ({
                        length: feedHeight,
                        offset: feedHeight * index,
                        index,
                    })}
                />
            ) : videos.length === 0 ? (
                <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                    <Text style={[styles.emptyText, { color: colors.text }]}>
                        {hasLimitedVideoAccess ? t('video_permission_desc') : t('video_empty')}
                    </Text>
                    {selectedAlbumIds.length > 0 && (
                        <Text style={[styles.scopeHint, { color: colors.textSecondary }]}>{t('video_filtered_empty_hint')}</Text>
                    )}
                    {hasLimitedVideoAccess && (
                        <Pressable
                            onPress={handleManageVideoAccess}
                            disabled={requestingVideoPermission}
                            style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: requestingVideoPermission ? 0.6 : 1 }]}
                        >
                            <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>
                                {requestingVideoPermission ? t('permission_requesting') : t('video_permission_btn')}
                            </Text>
                        </Pressable>
                    )}
                    <Pressable
                        onPress={() => loadVideos(50, displayOrder, selectedAlbumIds)}
                        disabled={requestingVideoPermission}
                        style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: requestingVideoPermission ? 0.6 : 1, marginTop: hasLimitedVideoAccess ? 10 : 0 }]}
                    >
                        <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>{t('photos_reload')}</Text>
                    </Pressable>
                </View>
            ) : null}
            </View>
            {videos.length > 0 && !isLoading && (
                <View style={styles.feedHint} pointerEvents="none">
                    <Text numberOfLines={1} style={[styles.feedHintText, { color: colors.textSecondary }]}>
                        {isAtEnd ? t('video_last_item') : t('video_swipe_hint')}
                    </Text>
                </View>
            )}

            {/* Trash Bin Modal */}
            {showTrash && (
                <BottomSheet
                    visible={isFocused}
                    title={t('video_trash_title')}
                    onClose={() => { setShowTrash(false); setTrashDeleteFailed(false); }}
                    footer={visibleVideoTrashBin.length > 0 ? (
                        <Pressable
                            style={[styles.confirmDeleteBtn, { backgroundColor: colors.dangerBackground }, isConfirmingVideoTrash && { opacity: 0.6 }]}
                            accessibilityRole="button"
                            accessibilityLabel={t('video_confirm_delete')}
                            onPress={async () => {
                            setTrashDeleteFailed(false);
                            try {
                                const requestedIds = visibleVideoTrashBin.map(video => video.id);
                                await confirmVideoTrash(requestedIds);
                                if (useMediaStore.getState().isConfirmingVideoTrash) return;

                                // The store keeps assets that failed the
                                // last-moment visibility check. Close only
                                // when every item that this confirmation
                                // started with is gone; otherwise leave the
                                // trash open so the remaining items can be
                                // retried instead of implying success.
                                const remainingTrashIds = new Set(
                                    useMediaStore.getState().videoTrashBin.map(video => video.id)
                                );
                                if (requestedIds.every(id => !remainingTrashIds.has(id))) {
                                    setShowTrash(false);
                                }
                            } catch (error) {
                                console.error('Failed to permanently delete videos', error);
                                // A native Alert can end up below RN's modal window on
                                // Android. Keep recovery feedback inside this sheet.
                                setTrashDeleteFailed(true);
                            }
                        }}
                            disabled={isConfirmingVideoTrash}
                        >
                            <Text style={[styles.confirmDeleteText, { color: colors.dangerForeground }]}>{t('video_confirm_delete')}</Text>
                        </Pressable>
                    ) : undefined}
                >
                    <ScrollView style={styles.trashContent}>
                        {trashDeleteFailed && (
                            <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.trashError, { color: colors.danger }]}>
                                {language === 'zh' ? '视频仍保留在废纸篓中，请重试。' : 'The videos remain in the trash. Please try again.'}
                            </Text>
                        )}
                        {visibleVideoTrashBin.length === 0 ? (
                            <Text style={[styles.emptyTextSmall, { color: colors.textSecondary }]}>{t('video_trash_empty')}</Text>
                        ) : (
                            <FlatList
                                data={visibleVideoTrashBin}
                                keyExtractor={item => item.id}
                                horizontal
                                contentContainerStyle={{ gap: 12, paddingVertical: 8 }}
                                renderItem={({ item }) => (
                                    <View style={[styles.trashCard, { backgroundColor: colors.selectionBackground }]}>
                                        <Image source={{ uri: item.uri }} style={styles.trashThumbnail} resizeMode="cover" />
                                        <View style={styles.videoIconOverlay}>
                                            <Ionicons name="videocam" size={20} color="white" />
                                        </View>
                                        <Pressable
                                            style={[styles.restoreBtn, isConfirmingVideoTrash && { opacity: 0.5 }]}
                                            onPress={() => handleRestoreFromTrash(item.id)}
                                            disabled={isConfirmingVideoTrash}
                                            accessibilityRole="button"
                                            accessibilityLabel={`${t('video_restore')} · ${item.filename || item.id}`}
                                        >
                                            <Text style={[styles.restoreText, { color: colors.text }]}>{t('video_restore')}</Text>
                                        </Pressable>
                                    </View>
                                )}
                            />
                        )}
                    </ScrollView>
                </BottomSheet>
            )}

            {/* Album Selector Modal */}
            <AlbumSelector
                visible={showAlbumSelector}
                onClose={() => setShowAlbumSelector(false)}
                onConfirm={handleConfirmCollection}
                editableOnly
            />

        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    pageHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingHorizontal: 20,
        paddingVertical: 6,
    },
    heading: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 10 },
    pageTitle: { fontSize: 17, fontWeight: '500', flexShrink: 1 },
    pageCount: { fontSize: 12, fontVariant: ['tabular-nums'] },
    feedViewport: { flex: 1 },
    feedHint: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 8, minHeight: 34 },
    feedHintText: { fontSize: 11, textAlign: 'center' },
    scopeHint: { fontSize: 13, lineHeight: 20, textAlign: 'center', marginHorizontal: 32, marginBottom: 20 },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 20,
        marginBottom: 20
    },
    actionButton: {
        backgroundColor: COLORS.primary,
        paddingHorizontal: 40,
        paddingVertical: 15,
        borderRadius: BORDER_RADIUS.full
    },
    actionButtonText: {
        fontWeight: 'bold'
    },
    trashIcon: {
        minWidth: 56,
        minHeight: 44,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 12,
        flexDirection: 'row',
        gap: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    trashCount: {
        fontSize: 12,
        fontWeight: '500',
        fontVariant: ['tabular-nums'],
    },
    trashContent: { flexShrink: 1 },
    trashError: { ...TYPOGRAPHY.body, marginBottom: 12 },
    emptyTextSmall: {
        textAlign: 'center',
        paddingVertical: 40,
    },
    trashCard: {
        width: 100,
        borderRadius: BORDER_RADIUS.m,
        overflow: 'hidden',
    },
    trashThumbnail: {
        height: 120,
        width: '100%',
    },
    videoIconOverlay: {
        position: 'absolute',
        top: 8,
        left: 8,
        backgroundColor: 'rgba(0,0,0,0.5)',
        borderRadius: 4,
        padding: 2,
    },
    restoreBtn: {
        width: '100%',
        padding: 10,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    restoreText: {
        color: COLORS.white,
        ...TYPOGRAPHY.secondary
    },
    confirmDeleteBtn: {
        minHeight: UI_METRICS.buttonHeight,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: UI_METRICS.buttonRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    confirmDeleteText: {
        ...TYPOGRAPHY.button
    },
});
