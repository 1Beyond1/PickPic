import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
// import { BlurView } from 'expo-blur'; // Removed to fix crash
// import { Image } from 'expo-image'; // Removed to fix crash
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Dimensions, FlatList, Image, Pressable, StyleSheet, Text, View, ViewToken } from 'react-native';
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
    const { t, language } = useI18n();
    const { colors, isDark } = useThemeColor();

    const {
        videos, loadVideos, isLoading, hasHydrated,
        videoProcessedIds,
        markVideoForTrash, markVideoAsProcessed, videoTrashBin, confirmVideoTrash, restoreFromTrash,
        isConfirmingVideoTrash,
        addAssetToAlbum
    } = useMediaStore();
    const { displayOrder, selectedAlbumIds } = useSettingsStore();

    const [activeId, setActiveId] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(true);
    const [showTrash, setShowTrash] = useState(false);
    const [showAlbumSelector, setShowAlbumSelector] = useState(false);
    const [selectedVideoForCollection, setSelectedVideoForCollection] = useState<any>(null);
    const [isScreenFocused, setIsScreenFocused] = useState(true);
    const lastActiveIdRef = useRef<string | null>(null);
    const videosRef = useRef(videos);
    videosRef.current = videos;
    const processedVideoIds = new Set(videoProcessedIds);
    const visibleVideos = videos.filter(video => !processedVideoIds.has(video.id));

    // Dynamic height state
    const [feedHeight, setFeedHeight] = useState(SCREEN_HEIGHT); // Full screen height

    useFocusEffect(useCallback(() => {
        if (!hasHydrated) return;
        void loadVideos(50, displayOrder, selectedAlbumIds);
    }, [displayOrder, selectedAlbumIds, hasHydrated, loadVideos]));

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

    const onLayout = (event: any) => {
        const { height } = event.nativeEvent.layout;
        if (Math.abs(height - feedHeight) > 10) {
            setFeedHeight(height);
        }
    };

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
                    <Text style={[styles.emptyText, { color: colors.text }]}>{t('video_empty')}</Text>
                    <Pressable onPress={() => loadVideos(50, displayOrder, selectedAlbumIds)} style={[styles.actionButton, { backgroundColor: colors.primary }]}>
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
                    {videoTrashBin.length > 0 && (
                        <View style={styles.badge}>
                            <Text style={styles.badgeText}>{videoTrashBin.length}</Text>
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

                    {videoTrashBin.length === 0 ? (
                        <Text style={[styles.emptyTextSmall, { color: colors.textSecondary }]}>{t('video_empty')}</Text>
                    ) : (
                        <FlatList
                            data={videoTrashBin}
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
                                        onPress={() => restoreFromTrash(item.id)}
                                        disabled={isConfirmingVideoTrash}
                                    >
                                        <Text style={styles.restoreText}>{t('video_restore')}</Text>
                                    </Pressable>
                                </View>
                            )}
                        />
                    )}

                    {videoTrashBin.length > 0 && (
                        <Pressable
                            style={[styles.confirmDeleteBtn, isConfirmingVideoTrash && { opacity: 0.6 }]}
                            onPress={async () => {
                            try {
                                await confirmVideoTrash();
                                if (useMediaStore.getState().isConfirmingVideoTrash) return;
                                setShowTrash(false);
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
