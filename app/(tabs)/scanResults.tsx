/**
 * Scan Results Screen - Display scanned photo analysis
 */

import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassContainer } from '../../components/GlassContainer';
import { SimilarGroupCard } from '../../components/SimilarGroupCard';
import { SimilarGroupDetailOverlay } from '../../components/SimilarGroupDetailOverlay';
import { SPACING } from '../../constants/theme';
import { AssetRepository, DupGroupRepository } from '../../database';
import { CategoryGroup, useAICategories } from '../../hooks/useAICategories';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { getCurrentlyVisibleAssetIds, useMediaStore } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

interface BlurryPhoto {
    assetId: string;
    blurScore: number;
    meanLuma: number;
    uri?: string;
}

interface SimilarGroup {
    groupId: string;
    memberCount: number;
    memberAssetIds: string[];
    bestAssetId: string | null;
    representativeUri?: string;
}

const RESULTS_MEDIA_PAGE_SIZE = 100;

/**
 * Resolve photo IDs visible to the current permission scope. A missing set
 * means full access; an empty set means no photo access.
 */
async function getVisiblePhotoIdsForResults(): Promise<ReadonlySet<string> | undefined> {
    const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    if (!permission.granted) return new Set();
    if (permission.accessPrivileges !== 'limited') return undefined;

    const visibleIds = new Set<string>();
    let after: string | undefined;

    while (true) {
        const result = await MediaLibrary.getAssetsAsync({
            mediaType: 'photo',
            first: RESULTS_MEDIA_PAGE_SIZE,
            ...(after ? { after } : {}),
        });

        for (const asset of result.assets) {
            visibleIds.add(asset.id);
        }

        if (!result.hasNextPage) break;
        if (!result.endCursor || result.endCursor === after) {
            throw new Error('Media library returned an invalid pagination cursor while reading visible scan results');
        }
        after = result.endCursor;
    }

    return visibleIds;
}

export default function ScanResultsScreen() {
    const insets = useSafeAreaInsets();
    const { colors } = useThemeColor();
    const { t } = useI18n();

    const { enableAIClassification } = useSettingsStore();
    const permissionScope = useMediaStore(state => state.permissionScope);
    const mediaLibraryRefreshVersion = useMediaStore(state => state.mediaLibraryRefreshVersion);

    const [activeTab, setActiveTab] = useState<'blur' | 'similar' | 'ai'>('blur');
    const [blurryPhotos, setBlurryPhotos] = useState<BlurryPhoto[]>([]);
    const [similarGroups, setSimilarGroups] = useState<SimilarGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const loadRequestIdRef = useRef(0);

    // Similar Groups detail modal state
    const [selectedSimilarGroup, setSelectedSimilarGroup] = useState<{
        group: SimilarGroup;
        origin: { x: number; y: number; width: number; height: number };
    } | null>(null);
    const [processedGroupIds, setProcessedGroupIds] = useState<Set<string>>(new Set());
    const previousMediaLibraryRefreshVersionRef = useRef(mediaLibraryRefreshVersion);

    // AI Categories Hook
    // Category loading reads the complete DONE snapshot. Defer that work
    // until the user opens the AI tab instead of blocking every visit to the
    // scan-results screen when classification is merely enabled.
    const shouldLoadAICategories = enableAIClassification && activeTab === 'ai';
    const { peopleGroups, objectGroups, uncategorizedGroup, isLoading: aiLoading, refresh: refreshAI } = useAICategories(shouldLoadAICategories);

    useEffect(() => {
        if (!enableAIClassification && activeTab === 'ai') {
            setActiveTab('blur');
        }
    }, [activeTab, enableAIClassification]);

    const loadResults = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        // ... (existing loadResults code) ...
        setLoading(true);
        try {
            // Load blurry photos (blur_score < 100)
            const visiblePhotoIds = await getVisiblePhotoIdsForResults();
            const blurryAssets = await AssetRepository.getBlurryAssets(
                visiblePhotoIds === undefined ? undefined : Array.from(visiblePhotoIds),
                50,
            );

            const blurryWithUris: (BlurryPhoto | null)[] = await Promise.all(
                blurryAssets.map(async (asset): Promise<BlurryPhoto | null> => {
                    try {
                        const info = await MediaLibrary.getAssetInfoAsync(asset.asset_id);
                        const uri = info.localUri || info.uri;
                        if (!uri) return null;
                        return {
                            assetId: asset.asset_id,
                            blurScore: asset.blur_score,
                            meanLuma: asset.mean_luma,
                            uri,
                        };
                    } catch {
                        return null;
                    }
                })
            );

            if (requestId !== loadRequestIdRef.current) return;
            setBlurryPhotos(blurryWithUris.filter((p): p is BlurryPhoto => p !== null));

            // Load similar groups
            const groups = await DupGroupRepository.getAllGroups();
            const groupsWithCount = await Promise.all(
                groups.map(async (group) => {
                    const members = await DupGroupRepository.getGroupMembers(group.group_id);
                    const availableMembers = (await Promise.all(
                        members.map(async member => {
                            try {
                                const info = await MediaLibrary.getAssetInfoAsync(member.asset_id);
                                const uri = info.localUri || info.uri;
                                return uri ? { member, uri } : null;
                            } catch {
                                return null;
                            }
                        })
                    )).filter((member): member is { member: typeof members[number]; uri: string } => member !== null);

                    // A group with a deleted/inaccessible member should not
                    // remain actionable in the results screen.
                    if (availableMembers.length < 2) return null;

                    const representative = availableMembers.find(
                        item => item.member.asset_id === group.representative_asset_id
                    ) ?? availableMembers[0];
                    const bestAssetId = availableMembers.some(
                        item => item.member.asset_id === group.best_asset_id
                    )
                        ? group.best_asset_id
                        : availableMembers[0].member.asset_id;

                    return {
                        groupId: group.group_id,
                        memberCount: availableMembers.length,
                        memberAssetIds: availableMembers.map(item => item.member.asset_id),
                        bestAssetId,
                        representativeUri: representative.uri,
                    };
                })
            );

            if (requestId !== loadRequestIdRef.current) return;
            setSimilarGroups(groupsWithCount.filter((group): group is NonNullable<typeof group> => (
                group !== null && group.memberCount > 1
            )));
        } catch (error) {
            console.error('[ScanResults] Load error:', error);
        } finally {
            if (requestId === loadRequestIdRef.current) {
                setLoading(false);
            }
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            void loadResults();
            if (activeTab === 'ai' && enableAIClassification) {
                void refreshAI();
            }
        }, [activeTab, enableAIClassification, loadResults, refreshAI])
    );

    const handleDeleteBlurry = async (assetId: string) => {
        Alert.alert(
            t('scan_delete_blurry_title'),
            t('scan_delete_blurry_message'),
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('delete'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            const visibleIds = await getCurrentlyVisibleAssetIds([assetId], 'photo');
                            if (!visibleIds.has(assetId)) {
                                throw new Error('Photo is no longer available');
                            }
                            const deleted = await MediaLibrary.deleteAssetsAsync([assetId]);
                            if (!deleted) {
                                throw new Error('Media library did not confirm deletion');
                            }
                            useMediaStore.getState().removeDeletedAssets([assetId]);
                            // Invalidate a load that may have started before
                            // the deletion and could otherwise reinsert this
                            // asset into the list when it finishes.
                            loadRequestIdRef.current += 1;
                            try {
                                await AssetRepository.removeAssetAndDerivedData(assetId);
                            } catch (cleanupError) {
                                console.error('[ScanResults] Failed to clean deleted asset from index:', cleanupError);
                            }
                            setBlurryPhotos(prev => prev.filter(p => p.assetId !== assetId));
                            // The deleted asset may also belong to a similar
                            // group, so refresh both result tabs from SQLite.
                            void loadResults();
                        } catch (error) {
                            Alert.alert(t('delete_failed'), String(error));
                        }
                    },
                },
            ]
        );
    };

    const renderBlurryItem = ({ item }: { item: BlurryPhoto }) => (
        <GlassContainer style={styles.photoCard}>
            {item.uri && (
                <Image source={{ uri: item.uri }} style={styles.thumbnail} />
            )}
            <View style={styles.cardInfo}>
                <Text style={[styles.scoreText, { color: colors.danger }]}>
                    {t('scan_blur_score', { score: item.blurScore.toFixed(1) })}
                </Text>
                <Text style={[styles.metaText, { color: colors.textSecondary }]}>
                    {t('scan_brightness', { value: item.meanLuma.toFixed(0) })}
                </Text>
            </View>
            <Pressable
                style={[styles.deleteButton, { backgroundColor: colors.danger }]}
                onPress={() => handleDeleteBlurry(item.assetId)}
            >
                <Ionicons name="trash" size={20} color="#FFF" />
            </Pressable>
        </GlassContainer>
    );

    // Handle marking a similar group as processed
    const handleSimilarGroupComplete = () => {
        if (selectedSimilarGroup) {
            setProcessedGroupIds(prev => new Set(prev).add(selectedSimilarGroup.group.groupId));
            // Move processed group to end
            setSimilarGroups(prev => {
                const processed = prev.find(g => g.groupId === selectedSimilarGroup.group.groupId);
                const others = prev.filter(g => g.groupId !== selectedSimilarGroup.group.groupId);
                return processed ? [...others, processed] : prev;
            });
            // Deleting members can remove the group or change its count in
            // the database; reload so the card is not left stale in memory.
            void loadResults();
        }
    };

    // Sort similar groups: unprocessed first, processed at end
    const sortedSimilarGroups = [...similarGroups].sort((a, b) => {
        const aProcessed = processedGroupIds.has(a.groupId) ? 1 : 0;
        const bProcessed = processedGroupIds.has(b.groupId) ? 1 : 0;
        return aProcessed - bProcessed;
    });

    const renderSimilarItem = ({ item }: { item: SimilarGroup }) => (
        <SimilarGroupCard
            groupId={item.groupId}
            memberCount={item.memberCount}
            memberAssetIds={item.memberAssetIds}
            isProcessed={processedGroupIds.has(item.groupId)}
            onPress={(layout) => {
                if (layout) {
                    setSelectedSimilarGroup({ group: item, origin: layout });
                } else {
                    // Fallback if measurement fails
                    setSelectedSimilarGroup({
                        group: item,
                        origin: { x: 0, y: 0, width: 0, height: 0 }
                    });
                }
            }}
        />
    );

    // Category Detail State
    const [selectedCategory, setSelectedCategory] = useState<CategoryGroup | null>(null);
    const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);

    useEffect(() => {
        if (mediaLibraryRefreshVersion === previousMediaLibraryRefreshVersionRef.current) return;
        previousMediaLibraryRefreshVersionRef.current = mediaLibraryRefreshVersion;

        // Invalidate and clear every result surface immediately. Otherwise a
        // full-access snapshot can remain visible while the new permission
        // scope is still being loaded.
        loadRequestIdRef.current += 1;
        setBlurryPhotos([]);
        setSimilarGroups([]);
        setSelectedSimilarGroup(null);
        setSelectedCategory(null);
        setSelectedPhoto(null);

        if (permissionScope !== 'none') {
            void loadResults();
        }
        if (activeTab === 'ai' && enableAIClassification) {
            void refreshAI();
        }
    }, [activeTab, enableAIClassification, loadResults, mediaLibraryRefreshVersion, permissionScope, refreshAI]);

    const getCategoryDisplayTitle = (title: string): string => {
        const categoryTitleKey = `ai_category_${title}`;
        const translatedTitle = t(categoryTitleKey as any);
        return translatedTitle === categoryTitleKey ? title : translatedTitle;
    };

    // Render AI Category Card
    const renderCategoryCard = ({ item }: { item: CategoryGroup }) => {
        return (
            <Pressable
                style={styles.categoryCard}
                disabled={item.assets.length === 0}
                onPress={() => {
                    if (item.assets.length > 0) {
                        setSelectedCategory(item);
                    }
                }}
            >
                <CategoryThumbnail assetId={item.coverAsset?.asset_id} />
                <View style={styles.categoryInfoOverlay}>
                    <Text style={styles.categoryTitle} numberOfLines={1}>
                        {getCategoryDisplayTitle(item.title)}
                    </Text>
                    <Text style={styles.categoryCount}>{item.count}</Text>
                </View>
            </Pressable>
        );
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>{t('tab_scan_results')}</Text>

            {/* Tabs */}
            <View style={styles.tabs}>
                <Pressable
                    style={[styles.tab, activeTab === 'blur' && { borderBottomColor: colors.primary }]}
                    onPress={() => setActiveTab('blur')}
                >
                    <Ionicons
                        name="contrast"
                        size={20}
                        color={activeTab === 'blur' ? colors.primary : colors.textSecondary}
                    />
                    <Text
                        style={[
                            styles.tabText,
                            { color: activeTab === 'blur' ? colors.primary : colors.textSecondary },
                        ]}
                    >
                        {t('scan_tab_blur' as any)}
                    </Text>
                </Pressable>

                <Pressable
                    style={[styles.tab, activeTab === 'similar' && { borderBottomColor: colors.primary }]}
                    onPress={() => setActiveTab('similar')}
                >
                    <Ionicons
                        name="copy"
                        size={20}
                        color={activeTab === 'similar' ? colors.primary : colors.textSecondary}
                    />
                    <Text
                        style={[
                            styles.tabText,
                            { color: activeTab === 'similar' ? colors.primary : colors.textSecondary },
                        ]}
                    >
                        {t('scan_tab_similar' as any)}
                    </Text>
                </Pressable>

                {enableAIClassification ? (
                    <Pressable
                        style={[styles.tab, activeTab === 'ai' && { borderBottomColor: colors.primary }]}
                        onPress={() => setActiveTab('ai')}
                    >
                        <Ionicons
                            name="sparkles"
                            size={20}
                            color={activeTab === 'ai' ? colors.primary : colors.textSecondary}
                        />
                        <Text
                            style={[
                                styles.tabText,
                                { color: activeTab === 'ai' ? colors.primary : colors.textSecondary },
                            ]}
                        >
                            {t('scan_tab_ai' as any)}
                        </Text>
                    </Pressable>
                ) : null}
            </View>

            {/* Content */}
            {activeTab === 'ai' ? (
                <View style={styles.aiContainer}>
                    {aiLoading ? (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color={colors.primary} />
                            <Text style={{ color: colors.textSecondary, marginTop: 10 }}>{t('scan_organizing')}</Text>
                        </View>
                    ) : (
                        <FlatList
                            data={[]} // Main list is empty, utilizing ListHeaderComponent
                            renderItem={() => null}
                            ListHeaderComponent={
                                <>
                                    {/* People Section */}
                                    <View style={styles.sectionHeader}>
                                        <Text style={[styles.sectionTitle, { color: colors.text }]}>
                                            {t('ai_category_people' as any)}
                                        </Text>
                                        <Text style={{ color: colors.textSecondary }}>{t('scan_group_count', { count: peopleGroups.length })}</Text>
                                    </View>
                                    <FlatList
                                        data={peopleGroups}
                                        horizontal
                                        showsHorizontalScrollIndicator={false}
                                        renderItem={renderCategoryCard}
                                        keyExtractor={item => item.id}
                                        contentContainerStyle={styles.horizontalList}
                                        ListEmptyComponent={<Text style={{ color: colors.textSecondary, padding: 20 }}>{t('scan_no_people')}</Text>}
                                    />

                                    {/* Objects Section */}
                                    <View style={styles.sectionHeader}>
                                        <Text style={[styles.sectionTitle, { color: colors.text }]}>
                                            {t('scan_objects_scenes')}
                                        </Text>
                                        <Text style={{ color: colors.textSecondary }}>{t('scan_category_count', { count: objectGroups.length })}</Text>
                                    </View>
                                    <FlatList
                                        data={objectGroups}
                                        horizontal
                                        showsHorizontalScrollIndicator={false}
                                        renderItem={renderCategoryCard}
                                        keyExtractor={item => item.id}
                                        contentContainerStyle={styles.horizontalList}
                                        ListEmptyComponent={<Text style={{ color: colors.textSecondary, padding: 20 }}>{t('scan_no_results')}</Text>}
                                    />

                                    {/* Uncategorized Section */}
                                    {uncategorizedGroup && (
                                        <>
                                            <View style={styles.sectionHeader}>
                                                <Text style={[styles.sectionTitle, { color: colors.text }]}>
                                                    {t('scan_uncategorized')}
                                                </Text>
                                                <Text style={{ color: colors.textSecondary }}>{t('scan_photo_count', { count: uncategorizedGroup.count })}</Text>
                                            </View>
                                            <FlatList
                                                data={[uncategorizedGroup]}
                                                horizontal
                                                showsHorizontalScrollIndicator={false}
                                                renderItem={renderCategoryCard}
                                                keyExtractor={item => item.id}
                                                contentContainerStyle={styles.horizontalList}
                                            />
                                        </>
                                    )}
                                </>
                            }
                        />
                    )}
                </View>
            ) : loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            ) : activeTab === 'blur' ? (
                <FlatList<BlurryPhoto>
                    data={blurryPhotos}
                    renderItem={renderBlurryItem}
                    keyExtractor={(item) => item.assetId}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Ionicons name="checkmark-circle" size={64} color={colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                                {t('scan_no_blurry')}
                            </Text>
                        </View>
                    }
                />
            ) : (
                <FlatList<SimilarGroup>
                    data={sortedSimilarGroups}
                    renderItem={renderSimilarItem}
                    keyExtractor={(item) => item.groupId}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Ionicons name="checkmark-circle" size={64} color={colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                                {t('scan_no_similar')}
                            </Text>
                        </View>
                    }
                />
            )}

            {/* Similar Group Detail Overlay */}
            <SimilarGroupDetailOverlay
                visible={!!selectedSimilarGroup}
                groupId={selectedSimilarGroup?.group.groupId || ''}
                memberAssetIds={selectedSimilarGroup?.group.memberAssetIds || []}
                originRect={selectedSimilarGroup?.origin || null}
                onClose={() => {
                    setSelectedSimilarGroup(null);
                    // The detail overlay can delete only part of a group and
                    // remain open. Refresh on every close so the parent card
                    // cannot keep showing its pre-deletion member count.
                    void loadResults();
                }}
                onComplete={handleSimilarGroupComplete}
            />


            {/* Category Detail Modal */}
            <Modal
                visible={!!selectedCategory}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setSelectedCategory(null)}
            >
                <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
                    {/* Header */}
                    <View style={styles.modalHeader}>
                        <Text style={[styles.modalTitle, { color: colors.text }]}>
                            {selectedCategory ? getCategoryDisplayTitle(selectedCategory.title) : ''}
                        </Text>
                        <Pressable
                            style={styles.closeButton}
                            onPress={() => setSelectedCategory(null)}
                        >
                            <Ionicons name="close-circle" size={30} color={colors.textSecondary} />
                        </Pressable>
                    </View>

                    {/* Photo Grid */}
                    {selectedCategory && (
                        <FlatList
                            data={selectedCategory.assets}
                            keyExtractor={(item) => item.asset_id}
                            numColumns={3}
                            contentContainerStyle={styles.gridContent}
                            renderItem={({ item }) => (
                                <Pressable
                                    style={styles.gridItem}
                                    onPress={() => setSelectedPhoto(item.asset_id)}
                                >
                                    <CategoryThumbnail assetId={item.asset_id} />
                                </Pressable>
                            )}
                            ListHeaderComponent={
                                <Text style={{ color: colors.textSecondary, marginBottom: 10, textAlign: 'center' }}>
                                    {t('scan_category_total', { count: selectedCategory.count })}
                                </Text>
                            }
                        />
                    )}
                </View>
            </Modal>

            {/* Full Screen Photo Viewer Modal */}
            <Modal
                visible={!!selectedPhoto}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setSelectedPhoto(null)}
            >
                <View style={{ flex: 1, backgroundColor: 'black', justifyContent: 'center' }}>
                    <Pressable
                        style={{ position: 'absolute', top: 50, right: 20, zIndex: 10 }}
                        onPress={() => setSelectedPhoto(null)}
                    >
                        <Ionicons name="close-circle" size={40} color="white" />
                    </Pressable>

                    {selectedPhoto && <FullPhotoViewer assetId={selectedPhoto} />}
                </View>
            </Modal>
        </View>
    );
}

// Helper component to load image for category
function CategoryThumbnail({ assetId }: { assetId?: string }) {
    const [image, setImage] = useState<{ assetId: string; uri: string } | null>(null);

    useEffect(() => {
        let mounted = true;
        setImage(null);

        if (!assetId) return () => { mounted = false; };

        MediaLibrary.getAssetInfoAsync(assetId).then(info => {
            const uri = info?.localUri || info?.uri;
            if (mounted && uri) {
                setImage({ assetId, uri });
            }
        }).catch(() => {
            // Ignore error if asset not found
        });
        return () => { mounted = false; };
    }, [assetId]);

    const uri = image && image.assetId === assetId ? image.uri : null;
    if (!uri) return <View style={[styles.categoryThumbnail, { backgroundColor: '#333' }]} />;
    return <Image source={{ uri }} style={styles.categoryThumbnail} />;
}

// Full Screen Viewer Helper
function FullPhotoViewer({ assetId }: { assetId: string }) {
    const [image, setImage] = useState<{ assetId: string; uri: string } | null>(null);

    useEffect(() => {
        let mounted = true;
        setImage(null);

        MediaLibrary.getAssetInfoAsync(assetId).then(info => {
            const uri = info?.localUri || info?.uri;
            if (mounted && uri) {
                setImage({ assetId, uri });
            }
        }).catch(() => {
            // Ignore error
        });
        return () => { mounted = false; };
    }, [assetId]);

    const uri = image && image.assetId === assetId ? image.uri : null;
    if (!uri) return <ActivityIndicator size="large" color="white" />;
    return <Image source={{ uri }} style={{ width: '100%', height: '100%', resizeMode: 'contain' }} />;
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    headerTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        paddingHorizontal: SPACING.l,
        marginVertical: SPACING.m,
    },
    tabs: {
        flexDirection: 'row',
        paddingHorizontal: SPACING.m,
        marginBottom: SPACING.m,
    },
    tab: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: SPACING.s,
        gap: 8,
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    tabText: {
        fontSize: 15,
        fontWeight: '600',
    },
    listContent: {
        padding: SPACING.m,
        paddingBottom: 100,
    },
    aiContainer: {
        flex: 1,
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.m,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
    },
    horizontalList: {
        paddingHorizontal: SPACING.m,
        paddingBottom: SPACING.l,
    },
    categoryCard: {
        width: 140,
        height: 180,
        marginRight: SPACING.m,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: '#333',
    },
    categoryThumbnail: {
        width: '100%',
        height: '100%',
    },
    categoryInfoOverlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: SPACING.s,
        backgroundColor: 'rgba(0,0,0,0.6)',
    },
    categoryTitle: {
        color: '#FFF',
        fontSize: 14,
        fontWeight: 'bold',
    },
    categoryCount: {
        color: '#DDD',
        fontSize: 12,
    },
    // ... (existing styles)
    photoCard: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
        marginBottom: SPACING.s,
        gap: SPACING.m,
    },
    thumbnail: {
        width: 80,
        height: 80,
        borderRadius: 8,
    },
    cardInfo: {
        flex: 1,
    },
    scoreText: {
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 4,
    },
    metaText: {
        fontSize: 13,
    },
    deleteButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
    groupCard: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
        marginBottom: SPACING.s,
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 12,
        gap: SPACING.m,
    },
    groupThumbnail: {
        width: 60,
        height: 60,
        borderRadius: 8,
    },
    groupInfo: {
        flex: 1,
    },
    groupTitle: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 4,
    },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        gap: 4,
    },
    badgeText: {
        fontSize: 11,
        color: '#FFF',
        fontWeight: '600',
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 60,
    },
    emptyText: {
        fontSize: 16,
        marginTop: SPACING.m,
    },
    modalContainer: {
        flex: 1,
        paddingTop: 20,
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(0,0,0,0.1)',
    },
    modalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
    },
    closeButton: {
        padding: 4,
    },
    gridContent: {
        padding: 2,
    },
    gridItem: {
        flex: 1,
        aspectRatio: 1,
        margin: 1,
        backgroundColor: '#eee',
    },
});
