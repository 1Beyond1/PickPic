import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { useFocusEffect } from 'expo-router';
import * as MediaLibrary from 'expo-media-library';
// import { BlurView } from 'expo-blur'; // Removed to fix crash
// import { Image } from 'expo-image'; // Removed to fix crash
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, FlatList, Linking, NativeScrollEvent, NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, Text, View, ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlbumSelector } from '../../components/AlbumSelector';
import { OrganizingScopeButton, OrganizingScopeModal } from '../../components/OrganizingScopeModal';
import { PendingDeletionModal } from '../../components/PendingDeletionReview';
import { RecentDecisionsButton, RecentUndoButton } from '../../components/RecentDecisionControls';
import { getPendingDeletionEntries } from '../../services/pendingDeletion';
import { VideoFeedItem } from '../../components/VideoFeedItem';
import { COLORS, TYPOGRAPHY, UI_METRICS } from '../../constants/theme';
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
        videos, loadVideos, isLoading, videoLoadFailed, hasHydrated,
        markVideoForTrash, markVideoAsProcessed,
        addAssetToAlbum, mediaLibraryRefreshVersion,
        videoCurrentIndex, organizingSessions, videoProcessedIds,
        videoSessionRecoveryStatus, videoSessionUnavailableCount,
        moveVideoSession, deferSessionMedia, revisitSessionDeferred,
    } = useMediaStore();
    const {
        displayOrder,
        selectedAlbumIds,
        hasHydrated: settingsHydrated,
    } = useSettingsStore();

    const [activeId, setActiveId] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(true);
    const [showTrash, setShowTrash] = useState(false);
    const [showAlbumSelector, setShowAlbumSelector] = useState(false);
    const [selectedVideoForCollection, setSelectedVideoForCollection] = useState<any>(null);
    const [isScreenFocused, setIsScreenFocused] = useState(true);
    const [showHome, setShowHome] = useState(false);
    const [showScopeSelector, setShowScopeSelector] = useState(false);
    const session = organizingSessions?.video;
    const batchFinished = !!session && session.assetIds.every(id => videoProcessedIds.includes(id) || session.deferredIds.includes(id));
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
    const dragStartIdRef = useRef<string | null>(null);
    const visibleIdRef = useRef<string | null>(null);
    const confirmedVisibleIdRef = useRef<string | null>(null);
    const feedRef = useRef<FlatList>(null);
    const videosRef = useRef(videos);
    videosRef.current = videos;
    const displayedVideosRef = useRef(videos);
    const hasLimitedVideoAccess = videoPermission?.accessPrivileges === 'limited';
    const pendingCount = getPendingDeletionEntries(useMediaStore.getState()).length;

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
        } catch {
            if (requestId !== videoPermissionRequestIdRef.current) return null;
            console.error('[Videos] Failed to refresh video permission.');
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
        dragStartIdRef.current = null;
        visibleIdRef.current = null;
        confirmedVisibleIdRef.current = null;
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
        if (!feedHeight || isLoading || showHome) return;
        const retainedId = displayedVideosRef.current === videos ? dragStartIdRef.current ?? confirmedVisibleIdRef.current : null;
        displayedVideosRef.current = videos;
        const retainedIndex = videos.findIndex(video => video.id === retainedId);
        const index = retainedIndex >= 0 ? retainedIndex : Math.max(0, Math.min(useMediaStore.getState().videoCurrentIndex ?? 0, videos.length - 1));
        const id = videos[index]?.id ?? null;
        lastActiveIdRef.current = id;
        visibleIdRef.current = id;
        dragStartIdRef.current = null;
        // Resizing an already visible item need not emit viewability again.
        // Retain its verified identity; a replacement/restored list still waits
        // for native visibility before playback or the last-item notice.
        setActiveId(confirmedVisibleIdRef.current === id ? id : null);
        feedRef.current?.scrollToOffset({ offset: index * feedHeight, animated: false });
    }, [feedHeight, videos, isLoading, showHome]);

    useEffect(() => {
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!isFocused || showHome || showTrash || showAlbumSelector) return false;
            setShowHome(true);
            dragStartIdRef.current = null;
            return true;
        });
        return () => subscription.remove();
    }, [isFocused, showHome, showTrash, showAlbumSelector]);

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
            confirmedVisibleIdRef.current = null;
            dragStartIdRef.current = null;
            return () => {
                setIsScreenFocused(false);
                setShowTrash(false);
                setShowAlbumSelector(false);
                setSelectedVideoForCollection(null);

                // Leaving the tab is not a review action. Keep the current
                // video unprocessed so an accidental tab switch does not
                // silently remove it from the feed on the next visit.
                lastActiveIdRef.current = null;
                dragStartIdRef.current = null;
            };
        }, [])
    );

    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        const newActiveId = viewableItems[0]?.key;
        if (!newActiveId) return;
        visibleIdRef.current = newActiveId;
        confirmedVisibleIdRef.current = newActiveId;
        setActiveId(newActiveId);
        // Visibility drives playback, not review progress: a half-finished
        // drag can reveal the next video and then snap back to this one.
        if (!lastActiveIdRef.current) lastActiveIdRef.current = newActiveId;
    }, []);

    const onMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        // Restore/layout/button scrolling is navigation, not a user's swipe.
        const previousActiveId = dragStartIdRef.current;
        dragStartIdRef.current = null;
        if (!previousActiveId || !feedHeight || !isFocusedRef.current) return;
        const currentVideos = videosRef.current;
        const newIndex = Math.round(event.nativeEvent.contentOffset.y / feedHeight);
        const nextVideo = currentVideos[newIndex];
        if (!nextVideo) return;
        const newActiveId = nextVideo.id;
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
        moveVideoSession(newActiveId);
    }, [feedHeight, markVideoAsProcessed, moveVideoSession]);

    const openSession = async (mode?: 'new' | 'continue') => {
        if (mode === 'new' && session?.scope.date !== undefined) { setShowScopeSelector(true); return; }
        if (mode) await loadVideos(50, displayOrder, selectedAlbumIds, mode);
        else await loadVideos(50, displayOrder, selectedAlbumIds);
        if (useMediaStore.getState().videos.length) setShowHome(false);
    };
    const revisitDeferred = async () => {
        if (!revisitSessionDeferred('video')) return;
        await openSession();
    };
    const keepCurrent = () => {
        const state = useMediaStore.getState();
        const asset = state.videos.find(video => video.id === visibleIdRef.current);
        if (!asset) return;
        markVideoAsProcessed(asset);
        const index = state.videos.indexOf(asset);
        const latest = useMediaStore.getState();
        const next = state.videos[index + 1] ?? latest.videos.find(video => !latest.videoProcessedIds.includes(video.id));
        if (next && moveVideoSession(next.id)) {
            lastActiveIdRef.current = next.id;
            visibleIdRef.current = next.id;
            dragStartIdRef.current = null;
            setActiveId(next.id);
            feedRef.current?.scrollToOffset({ offset: state.videos.indexOf(next) * feedHeight, animated: false });
        } else if (latest.organizingSessions.video?.phase === 'organizing') {
            setShowHome(true); // Remaining members may require permission recovery.
        }
    };
    const skipCurrent = () => {
        const id = visibleIdRef.current;
        if (id) deferSessionMedia('video', id);
    };
    const afterUndo = () => {
        if (!isFocusedRef.current) return;
        setShowHome(false); dragStartIdRef.current = null;
        void loadVideos(50, displayOrder, selectedAlbumIds);
    };

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

    const unavailable = videoSessionRecoveryStatus === 'unavailable'
        || (!!session && !batchFinished && videoSessionUnavailableCount > 0
            && !videos.some(asset => !videoProcessedIds.includes(asset.id)));
    const readFailed = videoLoadFailed || videoSessionRecoveryStatus === 'failed';
    const emptyTitle = readFailed ? 'video_load_failed' : unavailable ? 'session_unavailable'
        : session?.phase === 'complete' ? session.deferredIds.length ? 'video_rest_complete'
            : session.scope.albumIds.length || session.scope.date !== undefined ? 'session_scope_complete' : hasLimitedVideoAccess ? 'video_accessible_complete' : 'video_library_complete'
        : batchFinished ? 'video_batch_complete' : showHome && videos.length ? 'video_organize'
        : hasLimitedVideoAccess ? 'video_permission_desc' : 'video_empty';
    const scope = session?.scope;
    const scopeText = scope ? t(scope.albumIds.length ? 'session_album_scope' : 'session_all_scope', {
        count: scope.albumIds.length, order: t(`session_order_${scope.order}`),
    }) + (scope.date !== undefined ? ` · ${scope.date === 'unknown' ? t('scope_unknown_date') : t('scope_month_value', { year: scope.date.year, month: scope.date.month })}` : '') : null;
    const activeIsProcessed = !!activeId && videoProcessedIds.includes(activeId);

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
        <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top,
            paddingBottom: UI_METRICS.dockHeight + insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
            <View style={styles.pageHeader}>
                {!showHome && videos.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={t('photos_back_home')}
                    onPress={() => { setShowHome(true); dragStartIdRef.current = null; }} style={styles.homeButton}>
                    <Ionicons name="chevron-back" size={22} color={colors.text} />
                </Pressable>}
                <View style={styles.heading}>
                    <Text style={[styles.pageTitle, { color: colors.text }]}>{t('video_organize')}</Text>
                    {videos.length > 0 && !isLoading && (
                        <Text style={[styles.pageCount, { color: colors.textSecondary }]}>
                            {Math.max(1, session ? session.assetIds.indexOf(activeId ?? '') + 1 : videos.findIndex(video => video.id === activeId) + 1)} / {session?.assetIds.length ?? videos.length}
                        </Text>
                    )}
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('pending_open', { count: pendingCount })}
                    onPress={() => setShowTrash(true)}
                    style={({ pressed }) => [styles.trashIcon, { backgroundColor: pressed ? colors.selectionBackground : 'transparent', opacity: pressed ? 0.6 : 1 }]}
                >
                    <Ionicons name="trash-bin-outline" size={20} color={colors.text} />
                    <Text style={[styles.trashCount, { color: pendingCount ? colors.danger : colors.textSecondary }]}>
                        {pendingCount > 99 ? '99+' : pendingCount}
                    </Text>
                </Pressable>
            </View>
            <View style={styles.feedViewport} onLayout={onLayout} testID="video-feed-viewport">
            {/* Feed */}
            {isLoading ? (
                <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            ) : !showHome && videos.length > 0 && feedHeight > 0 ? (
                <FlatList
                    // Native cached page frames belong to this viewport size.
                    // Recreate them when large text/layout changes its height.
                    key={`video-feed-${feedHeight}`}
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
                    onScrollBeginDrag={() => { dragStartIdRef.current = lastActiveIdRef.current; }}
                    initialScrollIndex={Math.min(videoCurrentIndex ?? 0, videos.length - 1)}
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
            ) : showHome || videos.length === 0 ? (
                <ScrollView testID="videos-home" contentContainerStyle={styles.homeContent}>
                    <Text accessibilityRole={readFailed || unavailable ? 'alert' : 'header'} style={[styles.emptyText, { color: colors.text, textAlign: 'center' }]}>
                        {t(emptyTitle)}
                    </Text>
                    {scopeText && <Text style={[styles.scopeHint, { color: colors.textSecondary }]}>{scopeText}</Text>}
                    {scope && <Text style={[styles.scopeHint, { color: colors.textSecondary }]}>{t('session_filter_hint')}</Text>}
                    {(readFailed || unavailable) && <Text style={[styles.scopeHint, { color: colors.textSecondary }]}>{t('session_preserved_hint')}</Text>}
                    {!scope && selectedAlbumIds.length > 0 && !readFailed && (
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
                        accessibilityRole="button"
                        onPress={() => void openSession(session && batchFinished && !videos.length && !readFailed && !unavailable ? 'continue' : undefined)}
                        disabled={requestingVideoPermission}
                        style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: requestingVideoPermission ? 0.6 : 1, marginTop: hasLimitedVideoAccess ? 10 : 0 }]}
                    >
                        <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>{t(session && batchFinished && !videos.length && !readFailed && !unavailable
                            ? 'session_next_batch' : readFailed || unavailable || !videos.length ? 'photos_reload' : 'session_continue')}</Text>
                    </Pressable>
                    {session && batchFinished && (videos.length > 0 || readFailed || unavailable) && <Pressable accessibilityRole="button" onPress={() => void openSession('continue')}
                        style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: 12 }]}>
                        <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('session_next_batch')}</Text>
                    </Pressable>}
                    {!!session?.deferredIds.length && <Pressable accessibilityRole="button" onPress={() => void revisitDeferred()}
                        style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: 12 }]}>
                        <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('session_deferred_count', { count: session.deferredIds.length })}</Text>
                    </Pressable>}
                    {session && <Pressable accessibilityRole="button" onPress={() => void openSession('new')}
                        style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: 12 }]}>
                        <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('session_new_round')}</Text>
                    </Pressable>}
                    {session && <Text style={[styles.scopeHint, { color: colors.textSecondary, marginTop: 12 }]}>{t('session_new_round_hint')}</Text>}
                    <OrganizingScopeButton onPress={() => setShowScopeSelector(true)} />
                    <View style={styles.recentRow}><RecentDecisionsButton kind="video" /><RecentUndoButton kind="video" onChanged={afterUndo} /></View>
                </ScrollView>
            ) : null}
            </View>
            {videos.length > 0 && !isLoading && !showHome && (
                <View style={styles.feedHint}>
                    {!!videoSessionUnavailableCount && <Text style={[styles.feedHintText, { color: colors.textSecondary }]}>
                        {t('video_partial_hint', { count: videoSessionUnavailableCount })}
                    </Text>}
                    <Text style={[styles.feedHintText, { color: colors.textSecondary }]}>
                        {isAtEnd ? t('video_last_item') : t('video_swipe_hint')}
                    </Text>
                    <View style={styles.footerActions}>
                        {!batchFinished && !activeIsProcessed && <Pressable accessibilityRole="button" onPress={skipCurrent}
                            disabled={!activeId} style={[styles.footerButton, { backgroundColor: colors.surface }]}>
                            <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('session_defer')}</Text>
                        </Pressable>}
                        <Pressable accessibilityRole="button" onPress={() => batchFinished ? void openSession('continue') : keepCurrent()}
                            disabled={!activeId} style={[styles.footerButton, { backgroundColor: colors.actionBackground }]}>
                            <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>
                                {t(batchFinished ? 'session_next_batch' : activeIsProcessed ? 'video_view_next' : isAtEnd ? 'video_keep' : 'video_keep_next')}
                            </Text>
                        </Pressable>
                    </View>
                    <View style={styles.recentRow}><RecentUndoButton kind="video" onChanged={afterUndo} /><RecentDecisionsButton kind="video" iconOnly /></View>
                </View>
            )}

            <PendingDeletionModal visible={showTrash && isFocused} onClose={() => setShowTrash(false)} />

            {/* Album Selector Modal */}
            <OrganizingScopeModal visible={showScopeSelector} kind="video" onClose={() => setShowScopeSelector(false)} onStarted={() => {
                setShowScopeSelector(false); setShowHome(false); dragStartIdRef.current = null;
            }} />
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
    recentRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
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
    homeButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
    homeContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 24 },
    pageTitle: { fontSize: 17, fontWeight: '500', flexShrink: 1 },
    pageCount: { fontSize: 12, fontVariant: ['tabular-nums'] },
    feedViewport: { flex: 1 },
    feedHint: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 8, minHeight: 34 },
    feedHintText: { fontSize: 11, textAlign: 'center' },
    footerActions: { flexDirection: 'row', gap: 12, marginTop: 8, width: '100%', flexWrap: 'wrap' },
    footerButton: { flex: 1, minWidth: 120, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10,
        borderRadius: UI_METRICS.buttonRadius, alignItems: 'center', justifyContent: 'center' },
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

});
