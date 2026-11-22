import { getReadableMediaInfo, getReadableMediaInfos } from '../../services/readableMedia';
/**
 * Scan Results Screen - Display scanned photo analysis
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';

import { SimilarGroupCard } from '../../components/SimilarGroupCard';
import { SimilarGroupDetailOverlay } from '../../components/SimilarGroupDetailOverlay';
import { PendingDeletionButton } from '../../components/PendingDeletionReview';
import { getPendingDeletionEntries } from '../../services/pendingDeletion';
import { SPACING, TYPOGRAPHY, UI_METRICS } from '../../constants/theme';
import { AssetRepository, DupGroupRepository } from '../../database';
import type { DupGroup, DupMember } from '../../database';
import { SimilarReviewRepository, isSimilarReviewCurrent } from '../../database/repositories/SimilarReviewRepository';
import type { SimilarReview } from '../../database/repositories/SimilarReviewRepository';
import { CategoryGroup, useAICategories } from '../../hooks/useAICategories';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
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
    previewUris: string[];
    review: SimilarReview | null;
    allAccessible: boolean;
}

const RESULTS_MEDIA_PAGE_SIZE = 100;
const BLURRY_PAGE_SIZE = 50;
const SIMILAR_PAGE_SIZE = 30;
const CATEGORY_URI_PAGE_SIZE = 60;
const CATEGORY_URI_CACHE_MAX = 600;

function writeBoundedUriCache(cache: Map<string, string>, assetId: string, uri: string): void {
    if (cache.has(assetId)) {
        cache.delete(assetId);
    }
    cache.set(assetId, uri);
    while (cache.size > CATEGORY_URI_CACHE_MAX) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
    }
}

async function hydrateSimilarGroupPage(
    groups: readonly DupGroup[],
    membersByGroupId: ReadonlyMap<string, DupMember[]>,
    visiblePhotoIds: ReadonlySet<string> | undefined,
    readableInfos: ReadonlyMap<string, { localUri?: string; uri?: string }>,
): Promise<SimilarGroup[]> {
    const candidates: {
        group: DupGroup;
        availableMembers: { member: DupMember; uri: string }[];
    }[] = [];

    for (const group of groups) {
        const members = membersByGroupId.get(group.group_id) ?? [];
        const visibleMembers = visiblePhotoIds === undefined
            ? members
            : members.filter(member => visiblePhotoIds.has(member.asset_id));

        const availableMembers = visibleMembers
            .map(member => {
                const info = readableInfos.get(member.asset_id);
                const uri = info?.localUri || info?.uri;
                return uri ? { member, uri } : null;
            })
            .filter((entry): entry is { member: DupMember; uri: string } => entry !== null);

        // A group with a deleted/inaccessible member should not remain
        // actionable in the results screen.
        if (availableMembers.length < 2) continue;
        candidates.push({ group, availableMembers });
    }

    if (candidates.length === 0) return [];

    // Batch-load snapshots and reviews in two O(1) SQL queries instead of 2N per-group queries.
    const snapshotsByGroupId = await SimilarReviewRepository.getSnapshotsBatch(
        candidates.map(candidate => candidate.group.group_id),
    );
    const reviewsBySnapshotKey = await SimilarReviewRepository.getReviewsBatch(
        Array.from(snapshotsByGroupId.values()),
    );

    return candidates.map(({ group, availableMembers }) => {
        const representative = availableMembers.find(
            item => item.member.asset_id === group.representative_asset_id,
        ) ?? availableMembers[0];
        const bestAssetId = availableMembers.some(
            item => item.member.asset_id === group.best_asset_id,
        )
            ? group.best_asset_id
            : null;
        const snapshot = snapshotsByGroupId.get(group.group_id) ?? null;
        const review = snapshot ? (reviewsBySnapshotKey.get(snapshot.key) ?? null) : null;

        return {
            groupId: group.group_id,
            memberCount: availableMembers.length,
            memberAssetIds: availableMembers.map(item => item.member.asset_id),
            bestAssetId,
            representativeUri: representative.uri,
            previewUris: availableMembers.slice(0, 2).map(item => item.uri),
            review,
            allAccessible: !!snapshot && snapshot.assets.length === availableMembers.length
                && snapshot.assets.every(asset => availableMembers.some(item => item.member.asset_id === asset.asset_id)),
        };
    });
}

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
    const router = useRouter();
    const reducedMotion = useReducedMotion();
    const insets = useSafeAreaInsets();
    const { colors } = useThemeColor();
    const { t } = useI18n();

    const { enableAIClassification } = useSettingsStore();
    const permissionScope = useMediaStore(state => state.permissionScope);
    const mediaLibraryRefreshVersion = useMediaStore(state => state.mediaLibraryRefreshVersion);
    const photoProcessedIds = useMediaStore(state => state.photoProcessedIds);
    const deleteQueue = useMediaStore(state => state.deleteQueue);
    const hasHydrated = useMediaStore(state => state.hasHydrated);

    const [activeTab, setActiveTab] = useState<'blur' | 'similar' | 'ai'>('blur');
    const [blurryPhotos, setBlurryPhotos] = useState<BlurryPhoto[]>([]);
    const [similarGroups, setSimilarGroups] = useState<SimilarGroup[]>([]);
    const [hasMoreBlurry, setHasMoreBlurry] = useState(false);
    const [loadingMoreBlurry, setLoadingMoreBlurry] = useState(false);
    const [hasMoreSimilar, setHasMoreSimilar] = useState(false);
    const [loadingMoreSimilar, setLoadingMoreSimilar] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [completedCount, setCompletedCount] = useState<number | null>(null);
    const loadRequestIdRef = useRef(0);
    const visiblePhotoIdsRef = useRef<ReadonlySet<string> | undefined>(undefined);
    const blurryOffsetRef = useRef(0);
    const similarOffsetRef = useRef(0);
    const loadingMoreBlurryRef = useRef(false);
    const loadingMoreSimilarRef = useRef(false);
    const [isDeletingBlurry, setIsDeletingBlurry] = useState(false);
    const isDeletingBlurryRef = useRef(false);
    const [queueFeedback, setQueueFeedback] = useState<string | null>(null);

    // Similar Groups detail modal state
    const [selectedSimilarGroup, setSelectedSimilarGroup] = useState<{
        group: SimilarGroup;
        origin: { x: number; y: number; width: number; height: number };
    } | null>(null);
    const previousMediaLibraryRefreshVersionRef = useRef(mediaLibraryRefreshVersion);

    // AI Categories Hook
    // Category loading reads the complete DONE snapshot. Defer that work
    // until the user opens the AI tab instead of blocking every visit to the
    // scan-results screen when classification is merely enabled.
    const shouldLoadAICategories = enableAIClassification && activeTab === 'ai';
    const { peopleGroups, objectGroups, uncategorizedGroup, isLoading: aiLoading, hasError: aiError, completedCount: aiCompletedCount, refresh: refreshAI } = useAICategories(shouldLoadAICategories);

    useEffect(() => {
        if (!enableAIClassification && activeTab === 'ai') {
            setActiveTab('blur');
        }
    }, [activeTab, enableAIClassification]);

    const loadResults = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        blurryOffsetRef.current = 0;
        similarOffsetRef.current = 0;
        loadingMoreBlurryRef.current = false;
        loadingMoreSimilarRef.current = false;
        setLoadingMoreBlurry(false);
        setLoadingMoreSimilar(false);
        setHasMoreBlurry(false);
        setHasMoreSimilar(false);
        setLoading(true);
        setLoadError(false);
        setCompletedCount(null);
        try {
            // Load first pages of blurry photos and similar groups using batched SQL queries.
            const visiblePhotoIds = await getVisiblePhotoIdsForResults();
            visiblePhotoIdsRef.current = visiblePhotoIds;
            const visibleIdsArray = visiblePhotoIds === undefined ? undefined : Array.from(visiblePhotoIds);

            const [statusCounts, blurryAssets, groups] = await Promise.all([
                AssetRepository.getStatusCounts(visibleIdsArray),
                AssetRepository.getBlurryAssets(visibleIdsArray, BLURRY_PAGE_SIZE, 0),
                DupGroupRepository.getGroupsPage({ limit: SIMILAR_PAGE_SIZE, offset: 0, repair: true }),
            ]);
            const membersByGroupId = await DupGroupRepository.getGroupMembersBatch(
                groups.map(group => group.group_id),
            );

            // Resolve all blurry and similar-group asset URIs in one batched call
            // so Android EXIF fallback scans the library at most once.
            const similarVisibleAssetIds: string[] = [];
            for (const group of groups) {
                const members = membersByGroupId.get(group.group_id) ?? [];
                for (const member of members) {
                    if (visiblePhotoIds === undefined || visiblePhotoIds.has(member.asset_id)) {
                        similarVisibleAssetIds.push(member.asset_id);
                    }
                }
            }
            const allAssetIds = [
                ...blurryAssets.map(asset => asset.asset_id),
                ...similarVisibleAssetIds,
            ];
            const readableInfos = await getReadableMediaInfos(allAssetIds, 'photo', {
                shouldDownloadFromNetwork: false,
            });

            if (requestId !== loadRequestIdRef.current) return;

            const blurryWithUris: BlurryPhoto[] = [];
            for (const asset of blurryAssets) {
                const info = readableInfos.get(asset.asset_id);
                const uri = info?.localUri || info?.uri;
                if (!uri) continue;
                blurryWithUris.push({
                    assetId: asset.asset_id,
                    blurScore: asset.blur_score,
                    meanLuma: asset.mean_luma,
                    uri,
                });
            }

            const hydratedGroups = await hydrateSimilarGroupPage(
                groups,
                membersByGroupId,
                visiblePhotoIds,
                readableInfos,
            );

            if (requestId !== loadRequestIdRef.current) return;
            blurryOffsetRef.current = blurryAssets.length;
            similarOffsetRef.current = groups.length;
            setHasMoreBlurry(blurryAssets.length === BLURRY_PAGE_SIZE);
            setHasMoreSimilar(groups.length === SIMILAR_PAGE_SIZE);
            setBlurryPhotos(blurryWithUris);
            setCompletedCount(statusCounts.done);
            setSimilarGroups(hydratedGroups);
        } catch {
            console.error('[ScanResults] Results could not be loaded.');
            if (requestId === loadRequestIdRef.current) {
                // A failed refresh must not leave the previous result set
                // actionable. Clear both surfaces so a transient native,
                // permission, or database error fails closed.
                setBlurryPhotos([]);
                setSimilarGroups([]);
                setHasMoreBlurry(false);
                setHasMoreSimilar(false);
                setSelectedSimilarGroup(null);
                setLoadError(true);
            }
        } finally {
            if (requestId === loadRequestIdRef.current) {
                setLoading(false);
            }
        }
    }, []);

    const loadMoreBlurry = useCallback(async () => {
        if (loading || loadingMoreBlurryRef.current || !hasMoreBlurry) return;
        const requestId = loadRequestIdRef.current;
        loadingMoreBlurryRef.current = true;
        setLoadingMoreBlurry(true);
        try {
            const visiblePhotoIds = visiblePhotoIdsRef.current;
            const visibleIdsArray = visiblePhotoIds === undefined ? undefined : Array.from(visiblePhotoIds);
            const nextAssets = await AssetRepository.getBlurryAssets(
                visibleIdsArray,
                BLURRY_PAGE_SIZE,
                blurryOffsetRef.current,
            );
            if (requestId !== loadRequestIdRef.current) return;

            const readableInfos = nextAssets.length > 0
                ? await getReadableMediaInfos(nextAssets.map(asset => asset.asset_id), 'photo', {
                    shouldDownloadFromNetwork: false,
                })
                : new Map();
            if (requestId !== loadRequestIdRef.current) return;

            const nextItems: BlurryPhoto[] = [];
            for (const asset of nextAssets) {
                const info = readableInfos.get(asset.asset_id);
                const uri = info?.localUri || info?.uri;
                if (!uri) continue;
                nextItems.push({
                    assetId: asset.asset_id,
                    blurScore: asset.blur_score,
                    meanLuma: asset.mean_luma,
                    uri,
                });
            }

            blurryOffsetRef.current += nextAssets.length;
            setHasMoreBlurry(nextAssets.length === BLURRY_PAGE_SIZE);
            if (nextItems.length > 0) {
                setBlurryPhotos(previous => {
                    const seen = new Set(previous.map(item => item.assetId));
                    const appended = nextItems.filter(item => !seen.has(item.assetId));
                    return appended.length > 0 ? [...previous, ...appended] : previous;
                });
            }
        } catch {
            console.error('[ScanResults] Additional blurry results could not be loaded.');
        } finally {
            if (requestId === loadRequestIdRef.current) {
                loadingMoreBlurryRef.current = false;
                setLoadingMoreBlurry(false);
            }
        }
    }, [hasMoreBlurry, loading]);

    const loadMoreSimilar = useCallback(async () => {
        if (loading || loadingMoreSimilarRef.current || !hasMoreSimilar) return;
        const requestId = loadRequestIdRef.current;
        loadingMoreSimilarRef.current = true;
        setLoadingMoreSimilar(true);
        try {
            const visiblePhotoIds = visiblePhotoIdsRef.current;
            const nextGroups = await DupGroupRepository.getGroupsPage({
                limit: SIMILAR_PAGE_SIZE,
                offset: similarOffsetRef.current,
                repair: false,
            });
            if (requestId !== loadRequestIdRef.current) return;

            const membersByGroupId = await DupGroupRepository.getGroupMembersBatch(
                nextGroups.map(group => group.group_id),
            );
            if (requestId !== loadRequestIdRef.current) return;

            const visibleMemberIds: string[] = [];
            for (const group of nextGroups) {
                const members = membersByGroupId.get(group.group_id) ?? [];
                for (const member of members) {
                    if (visiblePhotoIds === undefined || visiblePhotoIds.has(member.asset_id)) {
                        visibleMemberIds.push(member.asset_id);
                    }
                }
            }
            const readableInfos = visibleMemberIds.length > 0
                ? await getReadableMediaInfos(visibleMemberIds, 'photo', {
                    shouldDownloadFromNetwork: false,
                })
                : new Map();
            if (requestId !== loadRequestIdRef.current) return;

            const hydrated = await hydrateSimilarGroupPage(
                nextGroups,
                membersByGroupId,
                visiblePhotoIds,
                readableInfos,
            );
            if (requestId !== loadRequestIdRef.current) return;

            similarOffsetRef.current += nextGroups.length;
            setHasMoreSimilar(nextGroups.length === SIMILAR_PAGE_SIZE);
            if (hydrated.length > 0) {
                setSimilarGroups(previous => {
                    const seen = new Set(previous.map(item => item.groupId));
                    const appended = hydrated.filter(item => !seen.has(item.groupId));
                    return appended.length > 0 ? [...previous, ...appended] : previous;
                });
            }
        } catch {
            console.error('[ScanResults] Additional similar groups could not be loaded.');
        } finally {
            if (requestId === loadRequestIdRef.current) {
                loadingMoreSimilarRef.current = false;
                setLoadingMoreSimilar(false);
            }
        }
    }, [hasMoreSimilar, loading]);

    useFocusEffect(
        useCallback(() => {
            void loadResults();
        }, [loadResults])
    );

    useFocusEffect(
        useCallback(() => {
            if (activeTab === 'ai' && enableAIClassification) {
                void refreshAI();
            }
        }, [activeTab, enableAIClassification, refreshAI])
    );

    const queueFromAI = async (assetId: string, source: 'blur' | 'classification') => {
        if (isDeletingBlurryRef.current) return;
        const refreshVersion = useMediaStore.getState().mediaLibraryRefreshVersion;
        isDeletingBlurryRef.current = true;
        setIsDeletingBlurry(true);
        setQueueFeedback(null);
        try {
            const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
            if (!permission.granted) throw new Error('Unavailable');
            const info = await getReadableMediaInfo(assetId, 'photo', { shouldDownloadFromNetwork: false });
            if (info?.id !== assetId || info.mediaType !== 'photo') throw new Error('Unavailable');
            const store = useMediaStore.getState();
            if (refreshVersion !== store.mediaLibraryRefreshVersion) throw new Error('Access changed');
            const existed = getPendingDeletionEntries(store).some(entry => entry.asset.id === assetId);
            const added = store.enqueuePendingDeletion([info], source);
            if (!added && !existed) throw new Error('Record mutation is blocked');
            setQueueFeedback(t(added ? 'pending_added' : 'pending_already_added'));
        } catch {
            setQueueFeedback(t('pending_add_failed'));
        } finally {
            isDeletingBlurryRef.current = false;
            setIsDeletingBlurry(false);
        }
    };
    const handleDeleteBlurry = (assetId: string) => queueFromAI(assetId, 'blur');

    const renderBlurryItem = ({ item }: { item: BlurryPhoto }) => (
        <View style={[styles.photoCard, { borderBottomColor: colors.divider }]}>
            {item.uri && (
                <Image source={{ uri: item.uri }} cachePolicy="memory" contentFit="cover" style={styles.thumbnail} />
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
                accessibilityLabel={t('pending_add')}
                accessibilityState={{ disabled: isDeletingBlurry, busy: isDeletingBlurry }}
                onPress={() => handleDeleteBlurry(item.assetId)}
            >
                <Ionicons name="trash-outline" size={20} color={colors.danger} />
            </Pressable>
        </View>
    );

    const pendingDeleteIds = useMemo(() => deleteQueue.map(asset => asset.id), [deleteQueue]);
    const isGroupProcessed = useCallback((group: SimilarGroup) => hasHydrated && group.allAccessible
        && isSimilarReviewCurrent(group.review, photoProcessedIds, pendingDeleteIds), [hasHydrated, pendingDeleteIds, photoProcessedIds]);

    // Sort similar groups: unprocessed first, processed at end
    const sortedSimilarGroups = useMemo(() => [...similarGroups].sort((a, b) => {
        const aProcessed = isGroupProcessed(a) ? 1 : 0;
        const bProcessed = isGroupProcessed(b) ? 1 : 0;
        return aProcessed - bProcessed;
    }), [isGroupProcessed, similarGroups]);

    const renderSimilarItem = ({ item }: { item: SimilarGroup }) => (
        <SimilarGroupCard
            groupId={item.groupId}
            memberCount={item.memberCount}
            memberAssetIds={item.memberAssetIds}
            previewUris={item.previewUris}
            isProcessed={isGroupProcessed(item)}
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
    const categoryUriCacheRef = useRef<{ version: number; entries: Map<string, string> }>({
        version: -1,
        entries: new Map(),
    });
    const categoryThumbnailWindowRef = useRef(0);
    const loadingCategoryThumbnailsRef = useRef(false);
    const [categoryCoverUris, setCategoryCoverUris] = useState<{ version: number; map: Record<string, string> }>({
        version: -1,
        map: {},
    });
    const [categoryDetailUris, setCategoryDetailUris] = useState<{
        version: number;
        categoryId: string;
        map: Record<string, string>;
    }>({
        version: -1,
        categoryId: '',
        map: {},
    });

    const getScopedUriCache = useCallback((version: number): Map<string, string> => {
        if (categoryUriCacheRef.current.version !== version) {
            categoryUriCacheRef.current = { version, entries: new Map() };
        }
        return categoryUriCacheRef.current.entries;
    }, []);

    const categoryCoverIds = useMemo(() => {
        if (!shouldLoadAICategories) return [] as string[];
        const ids: string[] = [];
        for (const group of peopleGroups) {
            if (group.coverAsset?.asset_id) ids.push(group.coverAsset.asset_id);
        }
        for (const group of objectGroups) {
            if (group.coverAsset?.asset_id) ids.push(group.coverAsset.asset_id);
        }
        if (uncategorizedGroup?.coverAsset?.asset_id) {
            ids.push(uncategorizedGroup.coverAsset.asset_id);
        }
        return Array.from(new Set(ids));
    }, [shouldLoadAICategories, peopleGroups, objectGroups, uncategorizedGroup]);
    const categoryCoverIdsKey = JSON.stringify(categoryCoverIds);

    useEffect(() => {
        let active = true;
        if (categoryCoverIds.length === 0) {
            setCategoryCoverUris({ version: mediaLibraryRefreshVersion, map: {} });
            return () => { active = false; };
        }
        const cache = getScopedUriCache(mediaLibraryRefreshVersion);
        const initialMap: Record<string, string> = {};
        const missingIds: string[] = [];
        for (const assetId of categoryCoverIds) {
            const cachedUri = cache.get(assetId);
            if (cachedUri) {
                initialMap[assetId] = cachedUri;
            } else {
                missingIds.push(assetId);
            }
        }
        if (Object.keys(initialMap).length > 0 || missingIds.length === 0) {
            setCategoryCoverUris({ version: mediaLibraryRefreshVersion, map: initialMap });
        }
        if (missingIds.length === 0) {
            return () => { active = false; };
        }
        void getReadableMediaInfos(missingIds, 'photo', {
            shouldDownloadFromNetwork: false,
        }).then(infos => {
            if (!active) return;
            const nextMap: Record<string, string> = { ...initialMap };
            for (const [assetId, info] of infos) {
                const uri = info.localUri || info.uri;
                if (uri) {
                    writeBoundedUriCache(cache, assetId, uri);
                    nextMap[assetId] = uri;
                }
            }
            setCategoryCoverUris({ version: mediaLibraryRefreshVersion, map: nextMap });
        });
        return () => { active = false; };
        // categoryCoverIdsKey encodes the exact cover ID list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [categoryCoverIdsKey, getScopedUriCache, mediaLibraryRefreshVersion]);

    const selectedCategoryAssetIds = useMemo(
        () => selectedCategory ? selectedCategory.assets.map(asset => asset.asset_id) : [],
        [selectedCategory],
    );
    const selectedCategoryKey = selectedCategory
        ? `${selectedCategory.id}:${JSON.stringify(selectedCategoryAssetIds)}`
        : '';

    const fetchCategoryThumbnailWindow = useCallback(async (
        categoryId: string,
        assetIds: readonly string[],
        startIndex: number,
        version: number,
        isActive: () => boolean,
    ) => {
        const endIndex = Math.min(assetIds.length, startIndex + CATEGORY_URI_PAGE_SIZE);
        const slice = assetIds.slice(startIndex, endIndex);
        if (slice.length === 0) return;

        const cache = getScopedUriCache(version);
        const missingIds: string[] = [];
        const cachedPatch: Record<string, string> = {};
        for (const assetId of slice) {
            const cachedUri = cache.get(assetId);
            if (cachedUri) {
                cachedPatch[assetId] = cachedUri;
            } else {
                missingIds.push(assetId);
            }
        }
        categoryThumbnailWindowRef.current = Math.max(categoryThumbnailWindowRef.current, endIndex);

        if (Object.keys(cachedPatch).length > 0 && isActive()) {
            setCategoryDetailUris(previous => {
                const base = previous.version === version && previous.categoryId === categoryId ? previous.map : {};
                return { version, categoryId, map: { ...base, ...cachedPatch } };
            });
        }

        if (missingIds.length === 0) return;
        const infos = await getReadableMediaInfos(missingIds, 'photo', {
            shouldDownloadFromNetwork: false,
        });
        if (!isActive()) return;
        const resolvedPatch: Record<string, string> = {};
        for (const [assetId, info] of infos) {
            const uri = info.localUri || info.uri;
            if (uri) {
                writeBoundedUriCache(cache, assetId, uri);
                resolvedPatch[assetId] = uri;
            }
        }
        setCategoryDetailUris(previous => {
            const base = previous.version === version && previous.categoryId === categoryId ? previous.map : {};
            return { version, categoryId, map: { ...base, ...cachedPatch, ...resolvedPatch } };
        });
    }, [getScopedUriCache]);

    const selectedCategoryRef = useRef<{ key: string; version: number; categoryId: string; assetIds: string[] }>({
        key: '',
        version: -1,
        categoryId: '',
        assetIds: [],
    });

    useEffect(() => {
        let active = true;
        categoryThumbnailWindowRef.current = 0;
        loadingCategoryThumbnailsRef.current = false;
        if (!selectedCategory || selectedCategoryAssetIds.length === 0) {
            selectedCategoryRef.current = { key: '', version: mediaLibraryRefreshVersion, categoryId: '', assetIds: [] };
            setCategoryDetailUris({ version: mediaLibraryRefreshVersion, categoryId: '', map: {} });
            return () => { active = false; };
        }
        const categoryId = selectedCategory.id;
        selectedCategoryRef.current = {
            key: selectedCategoryKey,
            version: mediaLibraryRefreshVersion,
            categoryId,
            assetIds: selectedCategoryAssetIds,
        };
        setCategoryDetailUris({ version: mediaLibraryRefreshVersion, categoryId, map: {} });
        void fetchCategoryThumbnailWindow(
            categoryId,
            selectedCategoryAssetIds,
            0,
            mediaLibraryRefreshVersion,
            () => active,
        );
        return () => { active = false; };
        // selectedCategoryKey encodes the active category ID and asset list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fetchCategoryThumbnailWindow, selectedCategoryKey, mediaLibraryRefreshVersion]);

    const loadMoreCategoryThumbnails = useCallback(() => {
        if (loadingCategoryThumbnailsRef.current) return;
        const current = selectedCategoryRef.current;
        if (!current.categoryId || categoryThumbnailWindowRef.current >= current.assetIds.length) return;
        loadingCategoryThumbnailsRef.current = true;
        const start = categoryThumbnailWindowRef.current;
        void fetchCategoryThumbnailWindow(
            current.categoryId,
            current.assetIds,
            start,
            current.version,
            () => selectedCategoryRef.current.key === current.key && selectedCategoryRef.current.version === current.version,
        ).finally(() => {
            loadingCategoryThumbnailsRef.current = false;
        });
    }, [fetchCategoryThumbnailWindow]);

    useEffect(() => {
        if (mediaLibraryRefreshVersion === previousMediaLibraryRefreshVersionRef.current) return;
        previousMediaLibraryRefreshVersionRef.current = mediaLibraryRefreshVersion;

        // Invalidate and clear every result surface immediately. Otherwise a
        // full-access snapshot can remain visible while the new permission
        // scope is still being loaded.
        loadRequestIdRef.current += 1;
        visiblePhotoIdsRef.current = undefined;
        blurryOffsetRef.current = 0;
        similarOffsetRef.current = 0;
        loadingMoreBlurryRef.current = false;
        loadingMoreSimilarRef.current = false;
        categoryUriCacheRef.current = { version: -1, entries: new Map() };
        categoryThumbnailWindowRef.current = 0;
        loadingCategoryThumbnailsRef.current = false;
        setBlurryPhotos([]);
        setSimilarGroups([]);
        setHasMoreBlurry(false);
        setHasMoreSimilar(false);
        setLoadingMoreBlurry(false);
        setLoadingMoreSimilar(false);
        setSelectedSimilarGroup(null);
        setSelectedCategory(null);
        setSelectedPhoto(null);
        setCategoryCoverUris({ version: -1, map: {} });
        setCategoryDetailUris({ version: -1, categoryId: '', map: {} });
        setQueueFeedback(null);

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

    const currentCategoryCoverMap = categoryCoverUris.version === mediaLibraryRefreshVersion
        ? categoryCoverUris.map
        : {};
    const currentCategoryDetailMap = selectedCategory
        && categoryDetailUris.version === mediaLibraryRefreshVersion
        && categoryDetailUris.categoryId === selectedCategory.id
        ? categoryDetailUris.map
        : {};

    // Render AI Category Card
    const renderCategoryCard = ({ item }: { item: CategoryGroup }) => {
        const coverAssetId = item.coverAsset?.asset_id;
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
                    <CategoryThumbnail
                        assetId={coverAssetId}
                        uri={coverAssetId ? currentCategoryCoverMap[coverAssetId] : undefined}
                    />
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

    // A successful empty query, no completed scans, and an unavailable query
    // must not look identical. These actions only retry reads or open the
    // existing settings screen; they never start a scan or change its scope.
    const renderResultState = (failed: boolean, noMatchKey?: 'scan_no_blurry' | 'scan_no_similar') => {
        const title = t(failed ? 'scan_results_load_failed' : noMatchKey ?? 'scan_results_not_ready');
        const action = t(failed ? 'retry' : 'scan_open_settings');
        const content = (
            <View style={[styles.resultState, noMatchKey && { paddingVertical: 32 }]}>
                <Text accessibilityRole={failed ? 'alert' : 'header'} accessibilityLiveRegion="polite" style={[styles.resultStateTitle, { color: colors.text }]}>{title}</Text>
                <Text style={[styles.resultStateBody, { color: colors.textSecondary }]}>
                    {t(failed ? 'scan_results_retry_desc' : noMatchKey ? 'scan_results_scope_desc' : 'scan_results_not_ready_desc')}
                </Text>
                {!noMatchKey && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={action}
                        style={({ pressed }) => [styles.resultStateButton, { backgroundColor: colors.actionBackground, opacity: pressed ? 0.8 : 1 }]}
                        onPress={() => {
                            if (failed) {
                                void (activeTab === 'ai' ? refreshAI() : loadResults());
                            } else {
                                router.navigate('/(tabs)/settings');
                            }
                        }}
                    >
                        <Text style={[styles.resultStateButtonText, { color: colors.actionForeground }]}>{action}</Text>
                    </Pressable>
                )}
            </View>
        );
        // Empty FlatLists already own scrolling and horizontal page padding.
        // Avoid a nested scroll surface and duplicated insets there.
        return noMatchKey ? content : <ScrollView contentContainerStyle={styles.resultStateContent}>{content}</ScrollView>;
    };

    return (
        <View testID="scan-results" style={[styles.container, {
            paddingTop: insets.top,
            paddingBottom: UI_METRICS.dockHeight + insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
            backgroundColor: colors.background,
        }]}>
            <View testID="scan-results-main" style={styles.mainContent} accessibilityElementsHidden={!!selectedSimilarGroup} importantForAccessibility={selectedSimilarGroup ? 'no-hide-descendants' : 'auto'}>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: UI_METRICS.pageInset }}>
                    <Text accessibilityRole="header" style={[styles.headerTitle, { color: colors.text, flex: 1 }]}>{t('tab_scan_results')}</Text>
                    <PendingDeletionButton />
                </View>
                {queueFeedback && <Text accessibilityLiveRegion="polite" style={{ ...TYPOGRAPHY.secondary, color: colors.textSecondary, paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 12 }}>{queueFeedback}</Text>}

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
                        ) : aiError ? renderResultState(true) : aiCompletedCount === 0 && !uncategorizedGroup ? renderResultState(false) : (
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
                ) : loadError ? renderResultState(true) : completedCount === 0 && blurryPhotos.length === 0 && similarGroups.length === 0 ? renderResultState(false) : activeTab === 'blur' ? (
                    <FlatList<BlurryPhoto>
                        testID="blurry-results-list"
                        data={blurryPhotos}
                        renderItem={renderBlurryItem}
                        keyExtractor={(item) => item.assetId}
                        contentContainerStyle={styles.listContent}
                        windowSize={5}
                        initialNumToRender={12}
                        maxToRenderPerBatch={10}
                        removeClippedSubviews
                        onEndReached={() => { void loadMoreBlurry(); }}
                        onEndReachedThreshold={0.5}
                        ListFooterComponent={loadingMoreBlurry ? (
                            <View style={styles.listFooterLoading}>
                                <ActivityIndicator size="small" color={colors.primary} />
                            </View>
                        ) : null}
                        ListEmptyComponent={
                            renderResultState(false, 'scan_no_blurry')
                        }
                    />
                ) : (
                    <FlatList<SimilarGroup>
                        testID="similar-results-list"
                        data={sortedSimilarGroups}
                        renderItem={renderSimilarItem}
                        keyExtractor={(item) => item.groupId}
                        contentContainerStyle={styles.listContent}
                        windowSize={5}
                        initialNumToRender={8}
                        maxToRenderPerBatch={8}
                        removeClippedSubviews
                        onEndReached={() => { void loadMoreSimilar(); }}
                        onEndReachedThreshold={0.5}
                        ListFooterComponent={loadingMoreSimilar ? (
                            <View style={styles.listFooterLoading}>
                                <ActivityIndicator size="small" color={colors.primary} />
                            </View>
                        ) : null}
                        ListEmptyComponent={
                            renderResultState(false, 'scan_no_similar')
                        }
                    />
                )}

            </View>
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
                onComplete={() => setSelectedSimilarGroup(null)}
            />


            {/* Category Detail Modal */}
            <Modal
                visible={!!selectedCategory}
                animationType={reducedMotion ? 'none' : 'slide'}
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
                            testID="category-detail-grid"
                            data={selectedCategory.assets}
                            extraData={currentCategoryDetailMap}
                            keyExtractor={(item) => item.asset_id}
                            numColumns={3}
                            style={styles.grid}
                            contentContainerStyle={styles.gridContent}
                            windowSize={5}
                            initialNumToRender={18}
                            maxToRenderPerBatch={15}
                            updateCellsBatchingPeriod={50}
                            removeClippedSubviews
                            onEndReached={loadMoreCategoryThumbnails}
                            onEndReachedThreshold={0.5}
                            renderItem={({ item, index }) => (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t('scan_open_category_photo', { index: index + 1 })}
                                    style={styles.gridItem}
                                    onPress={() => { setQueueFeedback(null); setSelectedPhoto(item.asset_id); }}
                                >
                                    <CategoryThumbnail
                                        assetId={item.asset_id}
                                        uri={currentCategoryDetailMap[item.asset_id]}
                                    />
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
                animationType={reducedMotion ? 'none' : 'fade'}
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
                        <Pressable accessibilityRole="button" accessibilityLabel={t('pending_add')} disabled={isDeletingBlurry} onPress={() => selectedPhoto && void queueFromAI(selectedPhoto, 'classification')} style={styles.closeButton}>
                            <Ionicons name="trash-outline" size={22} color={colors.danger} />
                        </Pressable>
                        <Pressable
                            style={({ pressed }) => [styles.closeButton, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                            accessibilityRole="button"
                            accessibilityLabel={t('close')}
                            onPress={() => setSelectedPhoto(null)}
                        >
                            <Ionicons name="close-outline" size={24} color={colors.text} />
                        </Pressable>
                    </View>
                    {queueFeedback && <Text testID="category-queue-feedback" accessibilityLiveRegion="polite" style={{ ...TYPOGRAPHY.secondary, color: colors.textSecondary, paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 12 }}>{queueFeedback}</Text>}
                    <View style={styles.viewerMedia}>
                        {selectedPhoto && <FullPhotoViewer assetId={selectedPhoto} />}
                    </View>
                </View>
            </Modal>
        </View>
    );
}

// Helper component to render a batch-prefetched category thumbnail using memory-only caching
const CategoryThumbnail = memo(function CategoryThumbnail({ assetId, uri }: { assetId?: string; uri?: string | null }) {
    const { colors } = useThemeColor();
    if (!uri) return <View style={[styles.categoryThumbnail, { backgroundColor: colors.surfaceHover }]} />;
    return (
        <Image
            source={{ uri }}
            recyclingKey={assetId ?? uri}
            cachePolicy="memory"
            contentFit="cover"
            transition={0}
            style={styles.categoryThumbnail}
        />
    );
});

// Full Screen Viewer Helper
function FullPhotoViewer({ assetId }: { assetId: string }) {
    const { t } = useI18n();
    const { colors } = useThemeColor();
    const [attempt, setAttempt] = useState(0);
    const [image, setImage] = useState<{ assetId: string; uri: string | null; failed: boolean } | null>(null);

    useEffect(() => {
        let mounted = true;
        setImage(null);

        getReadableMediaInfo(assetId).then(info => {
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
            cachePolicy="memory"
            contentFit="contain"
            style={{ width: '100%', height: '100%' }}
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
    mainContent: { flex: 1 },
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
    listFooterLoading: {
        paddingVertical: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    resultStateContent: { flexGrow: 1, paddingHorizontal: UI_METRICS.pageInset, paddingVertical: 32 },
    resultState: { width: '100%', maxWidth: 480, alignSelf: 'center' },
    resultStateTitle: { ...TYPOGRAPHY.sectionTitle, marginBottom: 8 },
    resultStateBody: { ...TYPOGRAPHY.body, marginBottom: 24 },
    resultStateButton: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 16, paddingVertical: 14, justifyContent: 'center' },
    resultStateButtonText: { ...TYPOGRAPHY.button, textAlign: 'center' },
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
