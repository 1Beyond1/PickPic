import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { useFocusEffect } from 'expo-router';
import * as MediaLibrary from 'expo-media-library';
// import { BlurView } from 'expo-blur'; // Removed to fix crash
// import { Image } from 'expo-image'; // Removed to fix crash
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Dimensions, FlatList, Image, Linking, Pressable, StyleSheet, Text, View, ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlbumSelector } from '../../components/AlbumSelector';
import { GlassContainer } from '../../components/GlassContainer';
import { VideoFeedItem } from '../../components/VideoFeedItem';
import { BORDER_RADIUS, COLORS, SPACING } from '../../constants/theme';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function VideosScreen() {
    const insets = useSafeAreaInsets();
    const isFocused = useIsFocused();
    const { t, language } = useI18n();
    const { colors, isDark } = useThemeColor();

    const {
        videos, loadVideos, isLoading, hasHydrated,
        videoProcessedIds,
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
    const [showAlbumSelector, setShowAlbumSelector] = useState(false);
    const [selectedVideoForCollection, setSelectedVideoForCollection] = useState<any>(null);
    const [isScreenFocused, setIsScreenFocused] = useState(true);
    const [videoPermission, setVideoPermission] = useState<MediaLibrary.PermissionResponse | null>(null);
    const [videoPermissionChecked, setVideoPermissionChecked] = useState(false);
    const [requestingVideoPermission, setRequestingVideoPermission] = useState(false);
    const videoPermissionRequestIdRef = useRef(0);
    const isFocusedRef = useRef(isFocused);
    isFocusedRef.current = isFocused;
    const lastActiveIdRef = useRef<string | null>(null);
    const videosRef = useRef(videos);
    videosRef.current = videos;
    const processedVideoIds = new Set(videoProcessedIds);
    const visibleVideos = videos.filter(video => !processedVideoIds.has(video.id));
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

    // Dynamic height state
    const [feedHeight, setFeedHeight] = useState(SCREEN_HEIGHT); // Full screen height

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

    useFocusEffect(useCallback(() => {
        if (!showTrash) return;

        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            setShowTrash(false);
            return true;
        });

        return () => subscription.remove();
    }, [showTrash]));

    useFocusEffect(
        useCallback(() => {
            setIsScreenFocused(true);
            setActiveId(null);
            lastActiveIdRef.current = null;
            return () => {
                setIsScreenFocused(false);

                // The last visible item has no following item to trigger
                // onViewableItemsChanged. Mark it when leaving the screen so
                // it does not reappear forever on the next visit.
                const activeVideoId = lastActiveIdRef.current;
                if (activeVideoId) {
                    const activeVideo = videosRef.current.find(video => video.id === activeVideoId);
                    if (activeVideo) {
                        markVideoAsProcessed(activeVideo);
                    }
                }
                lastActiveIdRef.current = null;
            };
        }, [markVideoAsProcessed])
    );

    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        const newActiveId = viewableItems[0]?.key;
        if (!newActiveId) return;

        setActiveId(newActiveId);

        // Mark previous video as processed when swiping to next. Keep the
        // callback identity stable because FlatList does not support changing
        // onViewableItemsChanged after it has mounted.
        const previousActiveId = lastActiveIdRef.current;
        if (previousActiveId && previousActiveId !== newActiveId) {
            const prevVideo = videosRef.current.find(v => v.id === previousActiveId);
            if (prevVideo) {
                markVideoAsProcessed(prevVideo);
            }
        }
        lastActiveIdRef.current = newActiveId;
    }, [markVideoAsProcessed]);

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
        // A persisted trash item may belong to the filter that was active in
        // an earlier session. Re-query the current scope instead of blindly
        // inserting the restored asset into this feed.
        void loadVideos(50, displayOrder, selectedAlbumIds);
    };

    const onLayout = (event: any) => {
        const { height } = event.nativeEvent.layout;
        if (Math.abs(height - feedHeight) > 10) {
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
                    style={[styles.actionButton, { backgroundColor: colors.primary, opacity: requestingVideoPermission ? 0.6 : 1 }]}
                >
                    <Text style={styles.actionButtonText}>
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
                    style={[styles.actionButton, { backgroundColor: colors.primary, opacity: requestingVideoPermission ? 0.6 : 1 }]}
                >
                    <Text style={styles.actionButtonText}>
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
        <View style={[styles.container, { backgroundColor: colors.background }]} onLayout={onLayout}>
            {/* Feed */}
            {isLoading ? (
                <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            ) : visibleVideos.length > 0 ? (
                <FlatList
                    data={visibleVideos}
                    keyExtractor={item => item.id}
                    renderItem={({ item }) => (
                        <VideoFeedItem
                            video={item}
                            isActive={item.id === activeId}
                            isScreenFocused={isScreenFocused}
                            shouldPlay={item.id === activeId && isScreenFocused}
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
                    viewabilityConfig={viewabilityConfig}
                    // Processed items are removed from the head as the user
                    // advances. Keep the currently visible video anchored
                    // while that data update changes its index.
                    maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                    snapToInterval={feedHeight}
                    snapToAlignment="start"
                    decelerationRate="fast"
                    disableIntervalMomentum={true}
                    overScrollMode="never"
                    getItemLayout={(data, index) => ({
                        length: feedHeight,
                        offset: feedHeight * index,
                        index,
                    })}
                />
            ) : (
                <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                    <Text style={[styles.emptyText, { color: colors.text }]}>
                        {hasLimitedVideoAccess ? t('video_permission_desc') : t('video_empty')}
                    </Text>
                    {hasLimitedVideoAccess && (
                        <Pressable
                            onPress={handleManageVideoAccess}
                            disabled={requestingVideoPermission}
                            style={[styles.actionButton, { backgroundColor: colors.primary, opacity: requestingVideoPermission ? 0.6 : 1 }]}
                        >
                            <Text style={styles.actionButtonText}>
                                {requestingVideoPermission ? t('permission_requesting') : t('video_permission_btn')}
                            </Text>
                        </Pressable>
                    )}
                    <Pressable
                        onPress={() => loadVideos(50, displayOrder, selectedAlbumIds)}
                        disabled={requestingVideoPermission}
                        style={[styles.actionButton, { backgroundColor: colors.primary, opacity: requestingVideoPermission ? 0.6 : 1, marginTop: hasLimitedVideoAccess ? 10 : 0 }]}
                    >
                        <Text style={styles.actionButtonText}>{t('photos_reload')}</Text>
                    </Pressable>
                </View>
            )}

            {/* Trash Bin Icon (Top Right) */}
            <Pressable
                style={[styles.trashIcon, { top: insets.top + 10 }]}
                onPress={() => setShowTrash(true)}
            >
                <View style={[styles.blurIcon, { backgroundColor: isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.8)' }]}>
                    <Ionicons name="trash-bin-outline" size={24} color={colors.text} />
                    {visibleVideoTrashBin.length > 0 && (
                        <View style={styles.badge}>
                            <Text style={styles.badgeText}>{visibleVideoTrashBin.length}</Text>
                        </View>
                    )}
                </View>
            </Pressable>

            {/* Trash Bin Modal */}
            {showTrash && (
                <GlassContainer style={styles.trashModal}>
                    <View style={styles.trashHeader}>
                        <Text style={[styles.trashTitle, { color: colors.text }]}>{t('video_trash_title')}</Text>
                        <Pressable onPress={() => setShowTrash(false)}>
                            <Ionicons name="close" size={24} color={colors.textSecondary} />
                        </Pressable>
                    </View>

                    {visibleVideoTrashBin.length === 0 ? (
                        <Text style={[styles.emptyTextSmall, { color: colors.textSecondary }]}>{t('video_empty')}</Text>
                    ) : (
                        <FlatList
                            data={visibleVideoTrashBin}
                            keyExtractor={item => item.id}
                            horizontal
                            contentContainerStyle={{ gap: 10, paddingVertical: 20 }}
                            renderItem={({ item }) => (
                                <View style={[styles.trashCard, { backgroundColor: colors.surface }]}>
                                    <Image
                                        source={{ uri: item.uri }}
                                        style={styles.trashThumbnail}
                                        resizeMode="cover"
                                    />
                                    <View style={styles.videoIconOverlay}>
                                        <Ionicons name="videocam" size={20} color="white" />
                                    </View>
                                    <Pressable
                                        style={[styles.restoreBtn, isConfirmingVideoTrash && { opacity: 0.5 }]}
                                        onPress={() => handleRestoreFromTrash(item.id)}
                                        disabled={isConfirmingVideoTrash}
                                    >
                                        <Text style={styles.restoreText}>{t('video_restore')}</Text>
                                    </Pressable>
                                </View>
                            )}
                        />
                    )}

                    {visibleVideoTrashBin.length > 0 && (
                        <Pressable
                            style={[styles.confirmDeleteBtn, isConfirmingVideoTrash && { opacity: 0.6 }]}
                            onPress={async () => {
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
                                Alert.alert(
                                    language === 'zh' ? '删除失败' : 'Delete failed',
                                    language === 'zh' ? '视频仍保留在废纸篓中，请重试。' : 'The videos remain in the trash. Please try again.'
                                );
                            }
                        }}
                            disabled={isConfirmingVideoTrash}
                        >
                            <Text style={styles.confirmDeleteText}>{t('video_confirm_delete')}</Text>
                        </Pressable>
                    )}
                </GlassContainer>
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
        color: COLORS.white,
        fontWeight: 'bold'
    },
    trashIcon: {
        position: 'absolute',
        right: SPACING.m,
    },
    blurIcon: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
    },
    badge: {
        position: 'absolute',
        top: 0,
        right: 0,
        backgroundColor: COLORS.danger,
        width: 16,
        height: 16,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center'
    },
    badgeText: {
        color: COLORS.white,
        fontSize: 10,
        fontWeight: 'bold'
    },
    trashModal: {
        position: 'absolute',
        top: 100,
        left: 20,
        right: 20,
        height: 300,
        padding: SPACING.m,
        justifyContent: 'space-between'
    },
    trashHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    trashTitle: {
        fontSize: 18,
        fontWeight: 'bold'
    },
    emptyTextSmall: {
        textAlign: 'center',
        marginTop: 50
    },
    trashCard: {
        width: 100,
        height: 140,
        borderRadius: BORDER_RADIUS.m,
        overflow: 'hidden',
    },
    trashThumbnail: {
        flex: 1,
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
        padding: 8,
        backgroundColor: COLORS.success,
        alignItems: 'center'
    },
    restoreText: {
        color: COLORS.white,
        fontSize: 12
    },
    confirmDeleteBtn: {
        backgroundColor: COLORS.danger,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.full,
        alignItems: 'center'
    },
    confirmDeleteText: {
        color: COLORS.white,
        fontWeight: 'bold'
    }
});
