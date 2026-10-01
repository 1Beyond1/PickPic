/**
 * Scan Results Screen - Display scanned photo analysis
 */

import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SimilarGroupCard } from '../../components/SimilarGroupCard';
import { SimilarGroupDetailOverlay } from '../../components/SimilarGroupDetailOverlay';
import { SPACING, TYPOGRAPHY, UI_METRICS } from '../../constants/theme';
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
    const [isDeletingBlurry, setIsDeletingBlurry] = useState(false);
    const isDeletingBlurryRef = useRef(false);

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
            if (requestId === loadRequestIdRef.current) {
                // A failed refresh must not leave the previous result set
                // actionable. Clear both surfaces so a transient native,
                // permission, or database error fails closed.
                setBlurryPhotos([]);
                setSimilarGroups([]);
                setSelectedSimilarGroup(null);
            }
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
        if (isDeletingBlurryRef.current) return;
        Alert.alert(
            t('scan_delete_blurry_title'),
            t('scan_delete_blurry_message'),
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('delete'),
                    style: 'destructive',
                    onPress: async () => {
                        // Alert confirmations can outlive a render. Lock before
                        // the permission preflight, not only the native request.
                        if (isDeletingBlurryRef.current) return;
                        isDeletingBlurryRef.current = true;
                        setIsDeletingBlurry(true);
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
                        } finally {
                            isDeletingBlurryRef.current = false;
                            setIsDeletingBlurry(false);
                        }
                    },
                },
            ]
        );
    };

    const renderBlurryItem = ({ item }: { item: BlurryPhoto }) => (
        <View style={[styles.photoCard, { borderBottomColor: colors.divider }]}>
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
                style={({ pressed }) => [styles.deleteButton, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }, isDeletingBlurry && { opacity: 0.5 }]}
                disabled={isDeletingBlurry}
                accessibilityRole="button"
                accessibilityLabel={t('scan_delete_blurry_title')}
                accessibilityState={{ disabled: isDeletingBlurry, busy: isDeletingBlurry }}
                onPress={() => handleDeleteBlurry(item.assetId)}
            >
                <Ionicons name="trash-outline" size={20} color={colors.danger} />
            </Pressable>
        </View>
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
                accessibilityRole="button"
                accessibilityLabel={`${getCategoryDisplayTitle(item.title)}, ${t('scan_photo_count', { count: item.count })}`}
                accessibilityState={{ disabled: item.assets.length === 0 }}
                style={({ pressed }) => [styles.categoryCard, { opacity: pressed ? 0.7 : 1 }]}
                disabled={item.assets.length === 0}
                onPress={() => {
                    if (item.assets.length > 0) {
                        setSelectedCategory(item);
                    }
                }}
            >
                <View style={[styles.categoryMedia, { backgroundColor: colors.surfaceHover }]}>
                    <CategoryThumbnail assetId={item.coverAsset?.asset_id} />
                </View>
                <View style={styles.categoryInfo}>
                    <Text style={[styles.categoryTitle, { color: colors.text }]}>
                        {getCategoryDisplayTitle(item.title)}
                    </Text>
                    <Text style={[styles.categoryCount, { color: colors.textSecondary }]}>{t('scan_photo_count', { count: item.count })}</Text>
                </View>
            </Pressable>
        );
    };

    return (
        <View testID="scan-results" style={[styles.container, {
            paddingTop: insets.top,
            paddingBottom: UI_METRICS.dockHeight + insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
            backgroundColor: colors.background,
        }]}>
            <Text accessibilityRole="header" style={[styles.headerTitle, { color: colors.text }]}>{t('tab_scan_results')}</Text>

            {/* Tabs */}
            <View style={styles.tabs}>
                <Pressable
                    accessibilityRole="tab"
                    accessibilityLabel={t('scan_tab_blur')}
                    accessibilityState={{ selected: activeTab === 'blur' }}
                    style={[styles.tab, activeTab === 'blur' && { borderBottomColor: colors.primary }]}
                    onPress={() => setActiveTab('blur')}
                >
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
                    accessibilityRole="tab"
                    accessibilityLabel={t('scan_tab_similar')}
                    accessibilityState={{ selected: activeTab === 'similar' }}
                    style={[styles.tab, activeTab === 'similar' && { borderBottomColor: colors.primary }]}
                    onPress={() => setActiveTab('similar')}
                >
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
                        accessibilityRole="tab"
                        accessibilityLabel={t('scan_tab_ai')}
                        accessibilityState={{ selected: activeTab === 'ai' }}
                        style={[styles.tab, styles.categoryTab, activeTab === 'ai' && { borderBottomColor: colors.primary }]}
                        onPress={() => setActiveTab('ai')}
                    >
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
                            contentContainerStyle={styles.categoryContent}
                            renderItem={() => null}
                            ListHeaderComponent={
                                <>
                                    {/* People Section */}
                                    <View style={styles.sectionHeader}>
                                        <Text style={[styles.sectionTitle, { color: colors.text }]}>
                                            {t('ai_category_people' as any)}
                                        </Text>
                                        <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{t('scan_group_count', { count: peopleGroups.length })}</Text>
                                    </View>
                                    <FlatList
                                        data={peopleGroups}
                                        horizontal
                                        showsHorizontalScrollIndicator={false}
                                        renderItem={renderCategoryCard}
                                        keyExtractor={item => item.id}
                                        contentContainerStyle={styles.horizontalList}
                                        ListEmptyComponent={<Text style={[styles.categoryEmpty, { color: colors.textSecondary }]}>{t('scan_no_people')}</Text>}
                                    />

                                    {/* Objects Section */}
                                    <View style={styles.sectionHeader}>
                                        <Text style={[styles.sectionTitle, { color: colors.text }]}>
                                            {t('scan_objects_scenes')}
                                        </Text>
                                        <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{t('scan_category_count', { count: objectGroups.length })}</Text>
                                    </View>
                                    <FlatList
                                        data={objectGroups}
                                        horizontal
                                        showsHorizontalScrollIndicator={false}
                                        renderItem={renderCategoryCard}
                                        keyExtractor={item => item.id}
                                        contentContainerStyle={styles.horizontalList}
                                        ListEmptyComponent={<Text style={[styles.categoryEmpty, { color: colors.textSecondary }]}>{t('scan_no_results')}</Text>}
                                    />

                                    {/* Uncategorized Section */}
                                    {uncategorizedGroup && (
                                        <>
                                            <View style={styles.sectionHeader}>
                                                <Text style={[styles.sectionTitle, { color: colors.text }]}>
                                                    {t('scan_uncategorized')}
                                                </Text>
                                                <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{t('scan_photo_count', { count: uncategorizedGroup.count })}</Text>
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
                statusBarTranslucent
                navigationBarTranslucent
                onRequestClose={() => setSelectedCategory(null)}
            >
                <View accessibilityViewIsModal testID="category-detail" style={[styles.modalContainer, {
                    backgroundColor: colors.background,
                    paddingTop: insets.top + 8,
                    paddingBottom: insets.bottom,
                    paddingLeft: insets.left,
                    paddingRight: insets.right,
                }]}>
                    {/* Header */}
                    <View style={styles.modalHeader}>
                        <View testID="category-heading" style={styles.modalHeading}>
                            <Text accessibilityRole="header" style={[styles.modalTitle, { color: colors.text }]}>
                                {selectedCategory ? getCategoryDisplayTitle(selectedCategory.title) : ''}
                            </Text>
                            {selectedCategory && (
                                <Text style={[styles.categoryCount, { color: colors.textSecondary }]}>
                                    {t('scan_category_total', { count: selectedCategory.count })}
                                </Text>
                            )}
                        </View>
                        <Pressable
                            style={({ pressed }) => [styles.closeButton, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                            onPress={() => setSelectedCategory(null)}
                            accessibilityRole="button"
                            accessibilityLabel={t('scan_close_category')}
                        >
                            <Ionicons name="close-outline" size={24} color={colors.text} />
                        </Pressable>
                    </View>

                    {/* Photo Grid */}
                    {selectedCategory && (
                        <FlatList
                            data={selectedCategory.assets}
                            keyExtractor={(item) => item.asset_id}
                            numColumns={3}
                            style={styles.grid}
                            contentContainerStyle={styles.gridContent}
                            renderItem={({ item, index }) => (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t('scan_open_category_photo', { index: index + 1 })}
                                    style={styles.gridItem}
                                    onPress={() => setSelectedPhoto(item.asset_id)}
                                >
                                    <CategoryThumbnail assetId={item.asset_id} />
                                </Pressable>
                            )}
                        />
                    )}
                </View>
            </Modal>

            {/* Full Screen Photo Viewer Modal */}
            <Modal
                visible={!!selectedPhoto}
                transparent={true}
                animationType="fade"
                statusBarTranslucent
                navigationBarTranslucent
                onRequestClose={() => setSelectedPhoto(null)}
            >
                <View accessibilityViewIsModal testID="category-photo-preview" style={[styles.modalContainer, {
                    backgroundColor: colors.background,
                    paddingTop: insets.top + 8,
                    paddingBottom: insets.bottom,
                    paddingLeft: insets.left,
                    paddingRight: insets.right,
                }]}>
                    <View style={styles.modalHeader}>
                        <Text accessibilityRole="header" style={[styles.viewerTitle, { color: colors.text }]}>{t('photo_detail_title')}</Text>
                        <Pressable
                            style={({ pressed }) => [styles.closeButton, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                            accessibilityRole="button"
                            accessibilityLabel={t('close')}
                            onPress={() => setSelectedPhoto(null)}
                        >
                            <Ionicons name="close-outline" size={24} color={colors.text} />
                        </Pressable>
                    </View>
                    <View style={styles.viewerMedia}>
                        {selectedPhoto && <FullPhotoViewer assetId={selectedPhoto} />}
                    </View>
                </View>
            </Modal>
        </View>
    );
}

// Helper component to load image for category
function CategoryThumbnail({ assetId }: { assetId?: string }) {
    const { colors } = useThemeColor();
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
    if (!uri) return <View style={[styles.categoryThumbnail, { backgroundColor: colors.surfaceHover }]} />;
    return <Image source={{ uri }} style={styles.categoryThumbnail} />;
}

// Full Screen Viewer Helper
function FullPhotoViewer({ assetId }: { assetId: string }) {
    const { t } = useI18n();
    const { colors } = useThemeColor();
    const [attempt, setAttempt] = useState(0);
    const [image, setImage] = useState<{ assetId: string; uri: string | null; failed: boolean } | null>(null);

    useEffect(() => {
        let mounted = true;
        setImage(null);

        MediaLibrary.getAssetInfoAsync(assetId).then(info => {
            const uri = info?.localUri || info?.uri;
            if (mounted) {
                setImage({ assetId, uri: uri || null, failed: !uri });
            }
        }).catch(() => {
            if (mounted) setImage({ assetId, uri: null, failed: true });
        });
        return () => { mounted = false; };
    }, [assetId, attempt]);

    const currentImage = image?.assetId === assetId ? image : null;
    if (currentImage?.failed) {
        return (
            <View style={styles.viewerError}>
                <Text style={[styles.viewerErrorText, { color: colors.textSecondary }]} accessibilityLiveRegion="polite">
                    {t('scan_photo_unavailable')}
                </Text>
                <Pressable
                    style={({ pressed }) => [styles.viewerRetry, { backgroundColor: colors.actionBackground, opacity: pressed ? 0.8 : 1 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('retry')}
                    onPress={() => setAttempt(value => value + 1)}
                >
                    <Text style={[styles.viewerRetryText, { color: colors.actionForeground }]}>{t('retry')}</Text>
                </Pressable>
            </View>
        );
    }
    const uri = currentImage?.uri;
    if (!uri) return <ActivityIndicator size="large" color={colors.primary} />;
    return (
        <Image
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('photo_detail_title')}
            source={{ uri }}
            style={{ width: '100%', height: '100%', resizeMode: 'contain' }}
            onError={() => setImage(previous => (
                previous?.assetId === assetId && previous.uri === uri
                    ? { ...previous, failed: true }
                    : previous
            ))}
        />
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    headerTitle: {
        ...TYPOGRAPHY.pageTitle,
        paddingHorizontal: UI_METRICS.pageInset,
        paddingTop: 16,
        paddingBottom: 12,
    },
    tabs: {
        flexDirection: 'row',
        paddingHorizontal: UI_METRICS.pageInset,
        marginBottom: 8,
    },
    tab: {
        flex: 1,
        minWidth: 0,
        minHeight: UI_METRICS.touchTarget,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: 4,
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    tabText: {
        ...TYPOGRAPHY.button,
        textAlign: 'center',
        flexShrink: 1,
    },
    categoryTab: { flex: 1.35 },
    listContent: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingBottom: 20,
    },
    aiContainer: {
        flex: 1,
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: UI_METRICS.pageInset,
        paddingTop: 16,
        paddingBottom: 12,
    },
    sectionTitle: {
        ...TYPOGRAPHY.sectionTitle,
        flex: 1,
        minWidth: 0,
    },
    sectionCount: { ...TYPOGRAPHY.secondary, flexShrink: 1, textAlign: 'right' },
    categoryContent: { paddingBottom: 20 },
    categoryEmpty: { ...TYPOGRAPHY.body, paddingVertical: 8 },
    horizontalList: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingBottom: 8,
    },
    categoryCard: {
        width: 140,
        marginRight: 12,
    },
    categoryMedia: { height: 144, borderRadius: 12, overflow: 'hidden' },
    categoryThumbnail: {
        width: '100%',
        height: '100%',
    },
    categoryInfo: { paddingTop: 8, gap: 2 },
    categoryTitle: {
        ...TYPOGRAPHY.button,
    },
    categoryCount: {
        ...TYPOGRAPHY.secondary,
    },
    // ... (existing styles)
    photoCard: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 16,
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    thumbnail: {
        width: 64,
        height: 64,
        borderRadius: 8,
    },
    cardInfo: {
        flex: 1,
        minWidth: 0,
    },
    scoreText: {
        ...TYPOGRAPHY.button,
        marginBottom: 4,
    },
    metaText: {
        ...TYPOGRAPHY.secondary,
    },
    deleteButton: {
        width: 44,
        height: 44,
        flexShrink: 0,
        borderRadius: UI_METRICS.buttonRadius,
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
    },
    viewerMedia: { flex: 1, minHeight: 0, justifyContent: 'center' },
    viewerError: {
        alignItems: 'center',
        paddingHorizontal: UI_METRICS.pageInset,
        gap: SPACING.m,
    },
    viewerErrorText: {
        ...TYPOGRAPHY.body,
        textAlign: 'center',
    },
    viewerRetry: {
        minHeight: UI_METRICS.buttonHeight,
        minWidth: 88,
        paddingHorizontal: UI_METRICS.pageInset,
        paddingVertical: 12,
        justifyContent: 'center',
        borderRadius: UI_METRICS.buttonRadius,
    },
    viewerRetryText: {
        ...TYPOGRAPHY.button,
        textAlign: 'center',
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: UI_METRICS.pageInset,
        paddingBottom: 16,
        gap: 12,
    },
    modalHeading: { flex: 1, minWidth: 0, gap: 4 },
    modalTitle: {
        ...TYPOGRAPHY.pageTitle,
    },
    viewerTitle: { ...TYPOGRAPHY.sectionTitle, flex: 1, minWidth: 0 },
    closeButton: {
        minWidth: 44,
        minHeight: 44,
        flexShrink: 0,
        borderRadius: UI_METRICS.buttonRadius,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 4,
    },
    grid: { flex: 1 },
    gridContent: { paddingHorizontal: 2, paddingBottom: 20 },
    gridItem: {
        width: '33.333333%',
        aspectRatio: 1,
        padding: 2,
    },
});
