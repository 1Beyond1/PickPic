/**
 * Scan Results Screen - Display scanned photo analysis
 */

import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassContainer } from '../../components/GlassContainer';
import { SimilarGroupCard } from '../../components/SimilarGroupCard';
import { SimilarGroupDetailOverlay } from '../../components/SimilarGroupDetailOverlay';
import { SPACING } from '../../constants/theme';
import { DupGroupRepository } from '../../database';
import { CategoryGroup, useAICategories } from '../../hooks/useAICategories';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
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

export default function ScanResultsScreen() {
    const insets = useSafeAreaInsets();
    const { colors, isDark } = useThemeColor();
    const { t } = useI18n();

    const { enableAIClassification, language } = useSettingsStore();

    const [activeTab, setActiveTab] = useState<'blur' | 'similar' | 'ai'>('blur');
    const [blurryPhotos, setBlurryPhotos] = useState<BlurryPhoto[]>([]);
    const [similarGroups, setSimilarGroups] = useState<SimilarGroup[]>([]);
    const [loading, setLoading] = useState(true);

    // Similar Groups detail modal state
    const [selectedSimilarGroup, setSelectedSimilarGroup] = useState<{
        group: SimilarGroup;
        origin: { x: number; y: number; width: number; height: number };
    } | null>(null);
    const [processedGroupIds, setProcessedGroupIds] = useState<Set<string>>(new Set());

    // AI Categories Hook
    const { peopleGroups, objectGroups, uncategorizedGroup, isLoading: aiLoading, refresh: refreshAI } = useAICategories();

    useFocusEffect(
        useCallback(() => {
            loadResults();
        }, [])
    );

    // Refresh AI categories when tab changes to 'ai'
    useEffect(() => {
        if (activeTab === 'ai') {
            refreshAI();
        }
    }, [activeTab]);

    const loadResults = async () => {
        // ... (existing loadResults code) ...
        setLoading(true);
        try {
            // Load blurry photos (blur_score < 100)
            const db = await import('../../database').then(m => m.getDatabase());
            const blurryAssets = await db.getAllAsync<{ asset_id: string; blur_score: number; mean_luma: number }>(
                `SELECT asset_id, blur_score, mean_luma FROM assets 
         WHERE status = 1 AND blur_score < 100 
         ORDER BY blur_score ASC LIMIT 50`
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

            setBlurryPhotos(blurryWithUris.filter((p): p is BlurryPhoto => p !== null));

            // Load similar groups
            const groups = await DupGroupRepository.getAllGroups();
            const groupsWithCount = await Promise.all(
                groups.map(async (group) => {
                    const members = await DupGroupRepository.getGroupMembers(group.group_id);
                    let representativeUri: string | undefined;
                    try {
                        const assetId = group.representative_asset_id || members[0]?.asset_id;
                        if (assetId) {
                            const info = await MediaLibrary.getAssetInfoAsync(assetId);
                            representativeUri = info.localUri || info.uri;
                        }
                    } catch {
                        // Ignore
                    }
                    return {
                        groupId: group.group_id,
                        memberCount: members.length,
                        memberAssetIds: members.map(m => m.asset_id),
                        bestAssetId: group.best_asset_id,
                        representativeUri,
                    };
                })
            );

            setSimilarGroups(groupsWithCount.filter(g => g.memberCount > 1));
        } catch (error) {
            console.error('[ScanResults] Load error:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteBlurry = async (assetId: string) => {
        Alert.alert(
            '删除模糊照片',
            '确定要删除这张照片吗？',
            [
                { text: '取消', style: 'cancel' },
                {
                    text: '删除',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await MediaLibrary.deleteAssetsAsync([assetId]);
                            setBlurryPhotos(prev => prev.filter(p => p.assetId !== assetId));
                        } catch (error) {
                            Alert.alert('删除失败', String(error));
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
                    模糊度: {item.blurScore.toFixed(1)}
                </Text>
                <Text style={[styles.metaText, { color: colors.textSecondary }]}>
                    亮度: {item.meanLuma.toFixed(0)}
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

    // Render AI Category Card
    const renderCategoryCard = ({ item }: { item: CategoryGroup }) => (
        <Pressable
            style={styles.categoryCard}
            onPress={() => setSelectedCategory(item)}
        >
            <CategoryThumbnail assetId={item.coverAsset.asset_id} />
            <View style={styles.categoryInfoOverlay}>
                <Text style={styles.categoryTitle} numberOfLines={1}>
                    {t(('ai_category_' + item.title) as any) || item.title}
                </Text>
                <Text style={styles.categoryCount}>{item.count}</Text>
            </View>
        </Pressable>
    );

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
                            <Text style={{ color: colors.textSecondary, marginTop: 10 }}>正在整理相册...</Text>
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
                                        <Text style={{ color: colors.textSecondary }}>{peopleGroups.length} 组</Text>
                                    </View>
                                    <FlatList
                                        data={peopleGroups}
                                        horizontal
                                        showsHorizontalScrollIndicator={false}
                                        renderItem={renderCategoryCard}
                                        keyExtractor={item => item.id}
                                        contentContainerStyle={styles.horizontalList}
                                        ListEmptyComponent={<Text style={{ color: colors.textSecondary, padding: 20 }}>暂无人物照片</Text>}
                                    />

                                    {/* Objects Section */}
                                    <View style={styles.sectionHeader}>
                                        <Text style={[styles.sectionTitle, { color: colors.text }]}>
                                            {language === 'zh' ? '事物 & 场景' : 'Objects & Scenes'}
                                        </Text>
                                        <Text style={{ color: colors.textSecondary }}>{objectGroups.length} 类</Text>
                                    </View>
                                    <FlatList
                                        data={objectGroups}
                                        horizontal
                                        showsHorizontalScrollIndicator={false}
                                        renderItem={renderCategoryCard}
                                        keyExtractor={item => item.id}
                                        contentContainerStyle={styles.horizontalList}
                                        ListEmptyComponent={<Text style={{ color: colors.textSecondary, padding: 20 }}>暂无识别结果</Text>}
                                    />

                                    {/* Uncategorized Section */}
                                    {uncategorizedGroup && (
                                        <>
                                            <View style={styles.sectionHeader}>
                                                <Text style={[styles.sectionTitle, { color: colors.text }]}>
                                                    {language === 'zh' ? '未分类' : 'Uncategorized'}
                                                </Text>
                                                <Text style={{ color: colors.textSecondary }}>{uncategorizedGroup.count} 张</Text>
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
                                未发现模糊照片
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
                                未发现相似照片组
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
                onClose={() => setSelectedSimilarGroup(null)}
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
                            {selectedCategory?.title}
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
                                    共 {selectedCategory.count} 张照片
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
function CategoryThumbnail({ assetId }: { assetId: string }) {
    const [uri, setUri] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        MediaLibrary.getAssetInfoAsync(assetId).then(info => {
            if (mounted && info && (info.localUri || info.uri)) {
                setUri(info.localUri || info.uri);
            }
        }).catch(() => {
            // Ignore error if asset not found
        });
        return () => { mounted = false; };
    }, [assetId]);

    if (!uri) return <View style={[styles.categoryThumbnail, { backgroundColor: '#333' }]} />;
    return <Image source={{ uri }} style={styles.categoryThumbnail} />;
}

// Full Screen Viewer Helper
function FullPhotoViewer({ assetId }: { assetId: string }) {
    const [uri, setUri] = useState<string | null>(null);

    useEffect(() => {
        MediaLibrary.getAssetInfoAsync(assetId).then(info => {
            if (info) {
                setUri(info.localUri || info.uri);
            }
        }).catch(() => {
            // Ignore error
        });
    }, [assetId]);

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
