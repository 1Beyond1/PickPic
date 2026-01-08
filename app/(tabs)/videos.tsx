import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
// import { BlurView } from 'expo-blur'; // Removed to fix crash
// import { Image } from 'expo-image'; // Removed to fix crash
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, FlatList, Image, Pressable, StyleSheet, Text, View, ViewToken } from 'react-native';
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
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();

    const {
        videos, loadVideos, isLoading,
        markVideoForTrash, markVideoAsProcessed, videoTrashBin, confirmVideoTrash, restoreFromTrash,
        addAssetToAlbum
    } = useMediaStore();
    const { activeCollectionIds, displayOrder, selectedAlbumIds } = useSettingsStore();

    const [activeId, setActiveId] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(true);
    const [showTrash, setShowTrash] = useState(false);
    const [showAlbumSelector, setShowAlbumSelector] = useState(false);
    const [selectedVideoForCollection, setSelectedVideoForCollection] = useState<any>(null);
    const [isScreenFocused, setIsScreenFocused] = useState(true);
    const [lastActiveId, setLastActiveId] = useState<string | null>(null);

    // Dynamic height state
    const [feedHeight, setFeedHeight] = useState(SCREEN_HEIGHT); // Full screen height

    useEffect(() => {
        loadVideos(50, displayOrder, selectedAlbumIds);
    }, []);

    useFocusEffect(
        useCallback(() => {
            setIsScreenFocused(true);
            return () => {
                setIsScreenFocused(false);
            };
        }, [])
    );

    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        if (viewableItems.length > 0) {
            const newActiveId = viewableItems[0].key;
            setActiveId(newActiveId);

            // Mark previous video as processed when swiping to next
            if (lastActiveId && lastActiveId !== newActiveId) {
                const prevVideo = videos.find(v => v.id === lastActiveId);
                if (prevVideo) {
                    markVideoAsProcessed(prevVideo);
                }
            }
            setLastActiveId(newActiveId);
        }
    }, [lastActiveId, markVideoAsProcessed]);

    // View config ref
    const viewabilityConfig = useRef({
        itemVisiblePercentThreshold: 50,
    }).current;

    const handleFavorite = (video: any) => {
        setSelectedVideoForCollection(video);
        setShowAlbumSelector(true);
    };

    const handleConfirmCollection = (ids: string[]) => {
        if (selectedVideoForCollection && ids.length > 0) {
            ids.forEach(id => addAssetToAlbum(id, selectedVideoForCollection));
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

    if (videos.length === 0 && !isLoading) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                <Text style={[styles.emptyText, { color: colors.text }]}>{t('video_empty')}</Text>
                <Pressable onPress={() => loadVideos(50, displayOrder, selectedAlbumIds)} style={[styles.actionButton, { backgroundColor: colors.primary }]}>
                    <Text style={styles.actionButtonText}>{t('photos_reload')}</Text>
                </Pressable>
            </View>
        )
    }

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]} onLayout={onLayout}>
            {/* Feed */}
            <FlatList
                data={videos}
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
                                    <Pressable style={styles.restoreBtn} onPress={() => restoreFromTrash(item.id)}>
                                        <Text style={styles.restoreText}>{t('video_restore')}</Text>
                                    </Pressable>
                                </View>
                            )}
                        />
                    )}

                    {videoTrashBin.length > 0 && (
                        <Pressable style={styles.confirmDeleteBtn} onPress={() => {
                            confirmVideoTrash();
                            setShowTrash(false);
                        }}>
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
                initialSelection={[]}
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
