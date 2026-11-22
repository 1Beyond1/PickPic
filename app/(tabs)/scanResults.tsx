import { getReadableMediaInfo, getReadableMediaInfos } from '../../services/readableMedia';
/**
 * Scan Results Screen - Display scanned photo analysis
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';

import { SimilarGroupCard } from '../../components/SimilarGroupCard';
import { SimilarGroupDetailOverlay } from '../../components/SimilarGroupDetailOverlay';
import { PendingDeletionButton } from '../../components/PendingDeletionReview';
import { ZoomablePhotoModal } from '../../components/ZoomablePhotoModal';
import { getPendingDeletionEntries } from '../../services/pendingDeletion';
import { isAssetProtected } from '../../services/protectedAlbums';
import { addReviewIgnore, addReviewIgnores, getIgnoredReviewKeys } from '../../services/reviewIgnores';
import { SPACING, TYPOGRAPHY, UI_METRICS } from '../../constants/theme';
import { AssetRepository, DupGroupRepository } from '../../database';
import type { BlurryAssetsCursor, DupGroup, DupGroupsCursor, DupMember } from '../../database';
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
    albumId?: string;
}

interface SimilarGroup {
    groupId: string;
    snapshotKey: string | null;
    memberCount: number;
    memberAssetIds: string[];
    memberAlbumIds: Record<string, string | undefined>;
    bestAssetId: string | null;
    representativeUri?: string;
    previewUris: string[];
    review: SimilarReview | null;
    allAccessible: boolean;
}

const RESULTS_MEDIA_PAGE_SIZE = 100;
const BLURRY_PAGE_SIZE = 50;
const SIMILAR_PAGE_SIZE = 30;
const MAX_FILTER_SKIP_PAGES = 10;
const CATEGORY_URI_PAGE_SIZE = 60;
const CATEGORY_URI_OVERSCAN_BEFORE = 15;
const CATEGORY_URI_OVERSCAN_AFTER = 45;
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

function mergeBoundedDetailMap(
    base: Record<string, string>,
    patch: Record<string, string>,
    assetIds: readonly string[],
    anchorIndex: number,
): Record<string, string> {
    const merged: Record<string, string> = { ...base, ...patch };
    const keys = Object.keys(merged);
    if (keys.length <= CATEGORY_URI_CACHE_MAX) {
        return merged;
    }
    const indexById = new Map<string, number>();
    assetIds.forEach((id, idx) => indexById.set(id, idx));
    keys.sort((left, right) => {
        const leftDist = Math.abs((indexById.get(left) ?? anchorIndex) - anchorIndex);
        const rightDist = Math.abs((indexById.get(right) ?? anchorIndex) - anchorIndex);
        return leftDist - rightDist;
    });
    const bounded: Record<string, string> = {};
    for (let i = 0; i < CATEGORY_URI_CACHE_MAX; i++) {
        const key = keys[i];
        bounded[key] = merged[key];
    }
    return bounded;
}

function sortSimilarGroupPage(
    groups: readonly SimilarGroup[],
    hasHydrated: boolean,
    processedIdSet: ReadonlySet<string>,
    pendingDeleteIdSet: ReadonlySet<string>,
): SimilarGroup[] {
    if (groups.length <= 1) return [...groups];
    const processedRank = new Map<string, number>();
    for (const group of groups) {
        const isProcessed = hasHydrated
            && group.allAccessible
            && isSimilarReviewCurrent(group.review, processedIdSet, pendingDeleteIdSet);
        processedRank.set(group.groupId, isProcessed ? 1 : 0);
    }
    return [...groups].sort(
        (left, right) => (processedRank.get(left.groupId) ?? 0) - (processedRank.get(right.groupId) ?? 0),
    );
}

async function hydrateSimilarGroupPage(
    groups: readonly DupGroup[],
    membersByGroupId: ReadonlyMap<string, DupMember[]>,
    visiblePhotoIds: ReadonlySet<string> | undefined,
    readableInfos: ReadonlyMap<string, { localUri?: string; uri?: string; albumId?: string }>,
    ignoredSimilarKeys: ReadonlySet<string> = new Set(),
): Promise<SimilarGroup[]> {
    const candidates: {
        group: DupGroup;
        availableMembers: { member: DupMember; uri: string; albumId?: string }[];
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
                return uri ? { member, uri, ...(info?.albumId ? { albumId: info.albumId } : {}) } : null;
            })
            .filter((entry): entry is { member: DupMember; uri: string; albumId?: string } => entry !== null);

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

    const hydrated: SimilarGroup[] = [];
    for (const { group, availableMembers } of candidates) {
        const snapshot = snapshotsByGroupId.get(group.group_id) ?? null;
        if (snapshot && ignoredSimilarKeys.has(snapshot.key)) {
            continue;
        }
        const representative = availableMembers.find(
            item => item.member.asset_id === group.representative_asset_id,
        ) ?? availableMembers[0];
        const bestAssetId = availableMembers.some(
            item => item.member.asset_id === group.best_asset_id,
        )
            ? group.best_asset_id
            : null;
        const review = snapshot ? (reviewsBySnapshotKey.get(snapshot.key) ?? null) : null;
        const memberAlbumIds: Record<string, string | undefined> = {};
        for (const item of availableMembers) {
            if (item.albumId) memberAlbumIds[item.member.asset_id] = item.albumId;
        }

        hydrated.push({
            groupId: group.group_id,
            snapshotKey: snapshot?.key ?? null,
            memberCount: availableMembers.length,
            memberAssetIds: availableMembers.map(item => item.member.asset_id),
            memberAlbumIds,
            bestAssetId,
            representativeUri: representative.uri,
            previewUris: availableMembers.slice(0, 2).map(item => item.uri),
            review,
            allAccessible: !!snapshot && snapshot.assets.length === availableMembers.length
                && snapshot.assets.every(asset => availableMembers.some(item => item.member.asset_id === asset.asset_id)),
        });
    }
    return hydrated;
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
    const permissionRefreshVersion = useMediaStore(state => state.permissionRefreshVersion ?? 0);
    const lastDeletionResult = useMediaStore(state => state.lastDeletionResult ?? null);
    const photoProcessedIds = useMediaStore(state => state.photoProcessedIds);
    const deleteQueue = useMediaStore(state => state.deleteQueue);
    const protectedAlbums = useMediaStore(state => state.protectedAlbums);
    const protectedAssetIds = useMediaStore(state => state.protectedAssetIds);
    const hasHydrated = useMediaStore(state => state.hasHydrated);

    const processedPhotoIdSet = useMemo(() => new Set(photoProcessedIds), [photoProcessedIds]);
    const pendingDeleteIdSet = useMemo(() => new Set(deleteQueue.map(asset => asset.id)), [deleteQueue]);
    const protectedAlbumIdSet = useMemo(
        () => new Set((protectedAlbums ?? []).map(album => album.albumId)),
        [protectedAlbums],
    );
    const protectedAssetIdSet = useMemo(
        () => new Set(protectedAssetIds ?? []),
        [protectedAssetIds],
    );

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
    const blurryCursorRef = useRef<BlurryAssetsCursor | null>(null);
    const similarCursorRef = useRef<DupGroupsCursor | null>(null);
    const loadingMoreBlurryRef = useRef(false);
    const loadingMoreSimilarRef = useRef(false);
    const [isDeletingBlurry, setIsDeletingBlurry] = useState(false);
    const isDeletingBlurryRef = useRef(false);
    const [queueFeedback, setQueueFeedback] = useState<string | null>(null);
    const [isSelectingBlurry, setIsSelectingBlurry] = useState(false);
    const [selectedBlurryIds, setSelectedBlurryIds] = useState<Set<string>>(new Set());
    const [previewBlurryPhoto, setPreviewBlurryPhoto] = useState<BlurryPhoto | null>(null);
    const ignoredBlurIdsRef = useRef<Set<string>>(new Set());
    const ignoredSimilarKeysRef = useRef<Set<string>>(new Set());

    // Similar Groups detail modal state
    const [selectedSimilarGroup, setSelectedSimilarGroup] = useState<{
        group: SimilarGroup;
        origin: { x: number; y: number; width: number; height: number };
    } | null>(null);
    const previousPermissionRefreshVersionRef = useRef(permissionRefreshVersion);
    const previousLastDeletionResultRef = useRef(lastDeletionResult);

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

    const fetchAdditionalBlurryPages = useCallback(async (
        visibleIdsArray: readonly string[] | undefined,
        initialCursor: BlurryAssetsCursor | null,
        requestId: number,
        maxPages: number,
    ): Promise<{ items: BlurryPhoto[]; cursor: BlurryAssetsCursor | null; hasMore: boolean } | null> => {
        let cursor = initialCursor;
        let hasMore = true;
        const collected: BlurryPhoto[] = [];

        for (let page = 0; page < maxPages && collected.length === 0 && hasMore; page++) {
            const nextAssets = await AssetRepository.getBlurryAssets(
                visibleIdsArray,
                BLURRY_PAGE_SIZE,
                0,
                cursor,
            );
            if (requestId !== loadRequestIdRef.current) return null;

            hasMore = nextAssets.length === BLURRY_PAGE_SIZE;
            if (nextAssets.length === 0) break;
            const last = nextAssets[nextAssets.length - 1];
            cursor = { blurScore: last.blur_score, assetId: last.asset_id };

            const readableInfos = await getReadableMediaInfos(nextAssets.map(asset => asset.asset_id), 'photo', {
                shouldDownloadFromNetwork: false,
            });
            if (requestId !== loadRequestIdRef.current) return null;

            for (const asset of nextAssets) {
                if (ignoredBlurIdsRef.current.has(asset.asset_id)) continue;
                const info = readableInfos.get(asset.asset_id);
                const uri = info?.localUri || info?.uri;
                if (!uri) continue;
                collected.push({
                    assetId: asset.asset_id,
                    blurScore: asset.blur_score,
                    meanLuma: asset.mean_luma,
                    uri,
                    ...(info?.albumId ? { albumId: info.albumId } : {}),
                });
            }
        }

        return { items: collected, cursor, hasMore };
    }, []);

    const fetchAdditionalSimilarPages = useCallback(async (
        visiblePhotoIds: ReadonlySet<string> | undefined,
        initialCursor: DupGroupsCursor | null,
        requestId: number,
        maxPages: number,
    ): Promise<{ groups: SimilarGroup[]; cursor: DupGroupsCursor | null; hasMore: boolean } | null> => {
        let cursor = initialCursor;
        let hasMore = true;
        const collected: SimilarGroup[] = [];

        for (let page = 0; page < maxPages && collected.length === 0 && hasMore; page++) {
            const nextGroups = await DupGroupRepository.getGroupsPage({
                limit: SIMILAR_PAGE_SIZE,
                cursor,
                repair: false,
            });
            if (requestId !== loadRequestIdRef.current) return null;

            hasMore = nextGroups.length === SIMILAR_PAGE_SIZE;
            if (nextGroups.length === 0) break;
            const last = nextGroups[nextGroups.length - 1];
            cursor = { createdAt: last.created_at ?? null, groupId: last.group_id };

            const membersByGroupId = await DupGroupRepository.getGroupMembersBatch(
                nextGroups.map(group => group.group_id),
            );
            if (requestId !== loadRequestIdRef.current) return null;

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
            if (requestId !== loadRequestIdRef.current) return null;

            const hydrated = await hydrateSimilarGroupPage(
                nextGroups,
                membersByGroupId,
                visiblePhotoIds,
                readableInfos,
                ignoredSimilarKeysRef.current,
            );
            if (requestId !== loadRequestIdRef.current) return null;
            collected.push(...hydrated);
        }

        return { groups: collected, cursor, hasMore };
    }, []);

    const loadResults = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        blurryCursorRef.current = null;
        similarCursorRef.current = null;
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

            const [statusCounts, blurryAssets, groups, ignoredBlurIds, ignoredSimilarKeys] = await Promise.all([
                AssetRepository.getStatusCounts(visibleIdsArray),
                AssetRepository.getBlurryAssets(visibleIdsArray, BLURRY_PAGE_SIZE, 0),
                DupGroupRepository.getGroupsPage({ limit: SIMILAR_PAGE_SIZE, offset: 0, repair: true }),
                getIgnoredReviewKeys('blur'),
                getIgnoredReviewKeys('similar_group'),
            ]);
            ignoredBlurIdsRef.current = new Set(ignoredBlurIds);
            ignoredSimilarKeysRef.current = new Set(ignoredSimilarKeys);
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

            let blurryWithUris: BlurryPhoto[] = [];
            for (const asset of blurryAssets) {
                if (ignoredBlurIdsRef.current.has(asset.asset_id)) continue;
                const info = readableInfos.get(asset.asset_id);
                const uri = info?.localUri || info?.uri;
                if (!uri) continue;
                blurryWithUris.push({
                    assetId: asset.asset_id,
                    blurScore: asset.blur_score,
                    meanLuma: asset.mean_luma,
                    uri,
                    ...(info?.albumId ? { albumId: info.albumId } : {}),
                });
            }

            let hydratedGroups = await hydrateSimilarGroupPage(
                groups,
                membersByGroupId,
                visiblePhotoIds,
                readableInfos,
                ignoredSimilarKeysRef.current,
            );
            if (requestId !== loadRequestIdRef.current) return;

            let nextBlurryCursor: BlurryAssetsCursor | null = blurryAssets.length > 0
                ? {
                    blurScore: blurryAssets[blurryAssets.length - 1].blur_score,
                    assetId: blurryAssets[blurryAssets.length - 1].asset_id,
                }
                : null;
            let nextHasMoreBlurry = blurryAssets.length === BLURRY_PAGE_SIZE;

            let nextSimilarCursor: DupGroupsCursor | null = groups.length > 0
                ? {
                    createdAt: groups[groups.length - 1].created_at ?? null,
                    groupId: groups[groups.length - 1].group_id,
                }
                : null;
            let nextHasMoreSimilar = groups.length === SIMILAR_PAGE_SIZE;

            // Under limited permissions (or after external deletions), page 1 can
            // filter down to 0 visible rows while later pages still hold visible
            // matches. Advance bounded pages via keyset cursor so we never show
            // a false empty state that blocks onEndReached.
            if (blurryWithUris.length === 0 && nextHasMoreBlurry && nextBlurryCursor) {
                const continued = await fetchAdditionalBlurryPages(
                    visibleIdsArray,
                    nextBlurryCursor,
                    requestId,
                    MAX_FILTER_SKIP_PAGES - 1,
                );
                if (!continued || requestId !== loadRequestIdRef.current) return;
                blurryWithUris = continued.items;
                nextBlurryCursor = continued.cursor;
                nextHasMoreBlurry = continued.hasMore;
            }

            if (hydratedGroups.length === 0 && nextHasMoreSimilar && nextSimilarCursor) {
                const continued = await fetchAdditionalSimilarPages(
                    visiblePhotoIds,
                    nextSimilarCursor,
                    requestId,
                    MAX_FILTER_SKIP_PAGES - 1,
                );
                if (!continued || requestId !== loadRequestIdRef.current) return;
                hydratedGroups = continued.groups;
                nextSimilarCursor = continued.cursor;
                nextHasMoreSimilar = continued.hasMore;
            }

            if (requestId !== loadRequestIdRef.current) return;
            const storeState = useMediaStore.getState();
            const initialSortedGroups = sortSimilarGroupPage(
                hydratedGroups,
                !!storeState.hasHydrated,
                new Set(storeState.photoProcessedIds ?? []),
                new Set((storeState.deleteQueue ?? []).map(asset => asset.id)),
            );

            blurryCursorRef.current = nextBlurryCursor;
            similarCursorRef.current = nextSimilarCursor;
            setHasMoreBlurry(nextHasMoreBlurry);
            setHasMoreSimilar(nextHasMoreSimilar);
            setBlurryPhotos(blurryWithUris);
            setCompletedCount(statusCounts.done);
            setSimilarGroups(initialSortedGroups);
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
    }, [fetchAdditionalBlurryPages, fetchAdditionalSimilarPages]);

    const loadMoreBlurry = useCallback(async () => {
        if (loading || loadingMoreBlurryRef.current || !hasMoreBlurry || !blurryCursorRef.current) return;
        const requestId = loadRequestIdRef.current;
        loadingMoreBlurryRef.current = true;
        setLoadingMoreBlurry(true);
        try {
            const visiblePhotoIds = visiblePhotoIdsRef.current;
            const visibleIdsArray = visiblePhotoIds === undefined ? undefined : Array.from(visiblePhotoIds);
            const result = await fetchAdditionalBlurryPages(
                visibleIdsArray,
                blurryCursorRef.current,
                requestId,
                MAX_FILTER_SKIP_PAGES,
            );
            if (!result || requestId !== loadRequestIdRef.current) return;

            blurryCursorRef.current = result.cursor;
            setHasMoreBlurry(result.hasMore);
            if (result.items.length > 0) {
                setBlurryPhotos(previous => {
                    const seen = new Set(previous.map(item => item.assetId));
                    const appended = result.items.filter(item => !seen.has(item.assetId));
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
    }, [fetchAdditionalBlurryPages, hasMoreBlurry, loading]);

    const loadMoreSimilar = useCallback(async () => {
        if (loading || loadingMoreSimilarRef.current || !hasMoreSimilar || !similarCursorRef.current) return;
        const requestId = loadRequestIdRef.current;
        loadingMoreSimilarRef.current = true;
        setLoadingMoreSimilar(true);
        try {
            const result = await fetchAdditionalSimilarPages(
                visiblePhotoIdsRef.current,
                similarCursorRef.current,
                requestId,
                MAX_FILTER_SKIP_PAGES,
            );
            if (!result || requestId !== loadRequestIdRef.current) return;

            similarCursorRef.current = result.cursor;
            setHasMoreSimilar(result.hasMore);
            if (result.groups.length > 0) {
                // Sort only the newly fetched page before appending so previously
                // rendered items above the viewport never jump mid-scroll.
                const storeState = useMediaStore.getState();
                const sortedNextPage = sortSimilarGroupPage(
                    result.groups,
                    !!storeState.hasHydrated,
                    new Set(storeState.photoProcessedIds ?? []),
                    new Set((storeState.deleteQueue ?? []).map(asset => asset.id)),
                );
                setSimilarGroups(previous => {
                    const seen = new Set(previous.map(item => item.groupId));
                    const appended = sortedNextPage.filter(item => !seen.has(item.groupId));
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
    }, [fetchAdditionalSimilarPages, hasMoreSimilar, loading]);

    const refreshSimilarGroupInPlace = useCallback(async (groupId: string) => {
        const requestId = loadRequestIdRef.current;
        try {
            const visiblePhotoIds = visiblePhotoIdsRef.current;
            const membersByGroupId = await DupGroupRepository.getGroupMembersBatch([groupId]);
            if (requestId !== loadRequestIdRef.current) return;
            const members = membersByGroupId.get(groupId) ?? [];
            const visibleMemberIds = visiblePhotoIds === undefined
                ? members.map(member => member.asset_id)
                : members.map(member => member.asset_id).filter(id => visiblePhotoIds.has(id));
            const readableInfos = visibleMemberIds.length > 0
                ? await getReadableMediaInfos(visibleMemberIds, 'photo', { shouldDownloadFromNetwork: false })
                : new Map();
            if (requestId !== loadRequestIdRef.current) return;

            const existingGroup = similarGroups.find(group => group.groupId === groupId);
            const syntheticRow: DupGroup = {
                group_id: groupId,
                representative_asset_id: existingGroup?.memberAssetIds[0] ?? members[0]?.asset_id ?? null,
                best_asset_id: existingGroup?.bestAssetId ?? null,
                created_at: 0,
            };
            const hydrated = await hydrateSimilarGroupPage(
                [syntheticRow],
                membersByGroupId,
                visiblePhotoIds,
                readableInfos,
                ignoredSimilarKeysRef.current,
            );
            if (requestId !== loadRequestIdRef.current) return;

            const updated = hydrated[0] ?? null;
            setSimilarGroups(previous => {
                if (!updated) {
                    return previous.filter(item => item.groupId !== groupId);
                }
                return previous.map(item => (item.groupId === groupId ? updated : item));
            });
        } catch {
            console.error('[ScanResults] Failed to refresh similar group in place.');
        }
    }, [similarGroups]);

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
        const initialStore = useMediaStore.getState();
        const refreshVersion = initialStore.mediaLibraryRefreshVersion;
        const permVersion = initialStore.permissionRefreshVersion ?? 0;
        isDeletingBlurryRef.current = true;
        setIsDeletingBlurry(true);
        setQueueFeedback(null);
        try {
            const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
            if (!permission.granted) throw new Error('Unavailable');
            const info = await getReadableMediaInfo(assetId, 'photo', { shouldDownloadFromNetwork: false });
            if (info?.id !== assetId || info.mediaType !== 'photo') throw new Error('Unavailable');
            const store = useMediaStore.getState();
            if (
                refreshVersion !== store.mediaLibraryRefreshVersion
                || permVersion !== (store.permissionRefreshVersion ?? 0)
            ) {
                throw new Error('Access changed');
            }
            if (isAssetProtected(info, protectedAlbumIdSet, protectedAssetIdSet)) {
                setQueueFeedback(t('protected_delete_blocked'));
                return;
            }
            const existed = getPendingDeletionEntries(store).some(entry => entry.asset.id === assetId);
            const report = typeof store.enqueuePendingDeletionWithReport === 'function'
                ? store.enqueuePendingDeletionWithReport([info], source)
                : (() => {
                    const added = store.enqueuePendingDeletion([info], source);
                    return { added, alreadyQueued: 0, protectedSkipped: 0, protectedAssetIds: [] as string[] };
                })();
            if (report.protectedSkipped > 0) {
                setQueueFeedback(t('protected_delete_blocked'));
                return;
            }
            if (!report.added && !existed) throw new Error('Record mutation is blocked');
            setQueueFeedback(t(report.added ? 'pending_added' : 'pending_already_added'));
        } catch {
            setQueueFeedback(t('pending_add_failed'));
        } finally {
            isDeletingBlurryRef.current = false;
            setIsDeletingBlurry(false);
        }
    };
    const handleDeleteBlurry = (assetId: string) => queueFromAI(assetId, 'blur');

    const toggleBlurrySelection = (assetId: string) => {
        setSelectedBlurryIds(previous => {
            const next = new Set(previous);
            if (next.has(assetId)) next.delete(assetId);
            else next.add(assetId);
            return next;
        });
    };

    const exitBlurrySelection = () => {
        setIsSelectingBlurry(false);
        setSelectedBlurryIds(new Set());
    };

    const handleIgnoreBlurry = async (assetIds: readonly string[]) => {
        const uniqueIds = Array.from(new Set(assetIds.filter(Boolean)));
        if (uniqueIds.length === 0 || isDeletingBlurryRef.current) return;
        isDeletingBlurryRef.current = true;
        setIsDeletingBlurry(true);
        setQueueFeedback(null);
        try {
            if (uniqueIds.length === 1) {
                await addReviewIgnore('blur', uniqueIds[0]);
            } else {
                await addReviewIgnores(uniqueIds.map(targetKey => ({ ignoreType: 'blur' as const, targetKey })));
            }
            const ignoredSet = new Set(uniqueIds);
            for (const id of ignoredSet) ignoredBlurIdsRef.current.add(id);
            setBlurryPhotos(previous => previous.filter(item => !ignoredSet.has(item.assetId)));
            setPreviewBlurryPhoto(previous => (previous && ignoredSet.has(previous.assetId) ? null : previous));
            setSelectedBlurryIds(previous => {
                const next = new Set(previous);
                for (const id of ignoredSet) next.delete(id);
                return next;
            });
            if (isSelectingBlurry) {
                setIsSelectingBlurry(false);
            }
            setQueueFeedback(
                uniqueIds.length === 1
                    ? t('blur_ignored_feedback')
                    : t('blur_batch_ignored_feedback', { count: uniqueIds.length }),
            );
        } catch {
            setQueueFeedback(t('similar_save_failed'));
        } finally {
            isDeletingBlurryRef.current = false;
            setIsDeletingBlurry(false);
        }
    };

    const handleBatchQueueBlurry = async () => {
        const targetIds = Array.from(selectedBlurryIds);
        if (targetIds.length === 0 || isDeletingBlurryRef.current) return;
        const initialStore = useMediaStore.getState();
        const refreshVersion = initialStore.mediaLibraryRefreshVersion;
        const permVersion = initialStore.permissionRefreshVersion ?? 0;
        isDeletingBlurryRef.current = true;
        setIsDeletingBlurry(true);
        setQueueFeedback(null);
        try {
            const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
            if (!permission.granted) throw new Error('Unavailable');
            const infoMap = await getReadableMediaInfos(targetIds, 'photo', { shouldDownloadFromNetwork: false });
            const store = useMediaStore.getState();
            if (
                refreshVersion !== store.mediaLibraryRefreshVersion
                || permVersion !== (store.permissionRefreshVersion ?? 0)
            ) {
                throw new Error('Access changed');
            }
            const assets = targetIds
                .map(id => infoMap.get(id))
                .filter((info): info is NonNullable<typeof info> => !!info && info.mediaType === 'photo');
            if (assets.length === 0) throw new Error('Unavailable');

            const unprotected: typeof assets = [];
            let protectedSkipped = 0;
            for (const asset of assets) {
                if (isAssetProtected(asset, protectedAlbumIdSet, protectedAssetIdSet)) {
                    protectedSkipped++;
                } else {
                    unprotected.push(asset);
                }
            }

            let added = 0;
            if (unprotected.length > 0) {
                const report = typeof store.enqueuePendingDeletionWithReport === 'function'
                    ? store.enqueuePendingDeletionWithReport(unprotected, 'blur')
                    : (() => {
                        const count = store.enqueuePendingDeletion(unprotected, 'blur');
                        return { added: count, alreadyQueued: 0, protectedSkipped: 0, protectedAssetIds: [] as string[] };
                    })();
                added = report.added;
                protectedSkipped += report.protectedSkipped;
            }

            exitBlurrySelection();
            if (protectedSkipped > 0) {
                setQueueFeedback(added > 0
                    ? t('protected_batch_skipped_feedback', { added, skipped: protectedSkipped })
                    : t('protected_all_skipped_feedback', { skipped: protectedSkipped }));
            } else {
                setQueueFeedback(t(added > 0 ? 'pending_added' : 'pending_already_added'));
            }
        } catch {
            setQueueFeedback(t('pending_add_failed'));
        } finally {
            isDeletingBlurryRef.current = false;
            setIsDeletingBlurry(false);
        }
    };

    const handleIgnoreSimilarGroup = async (groupId: string, snapshotKey: string | null) => {
        if (!snapshotKey || isDeletingBlurryRef.current) return;
        isDeletingBlurryRef.current = true;
        setIsDeletingBlurry(true);
        setQueueFeedback(null);
        try {
            await addReviewIgnore('similar_group', snapshotKey);
            ignoredSimilarKeysRef.current.add(snapshotKey);
            setSimilarGroups(previous => previous.filter(item => item.groupId !== groupId && item.snapshotKey !== snapshotKey));
            setQueueFeedback(t('similar_hidden_feedback'));
        } catch {
            setQueueFeedback(t('similar_save_failed'));
        } finally {
            isDeletingBlurryRef.current = false;
            setIsDeletingBlurry(false);
        }
    };

    const renderBlurryItem = ({ item }: { item: BlurryPhoto }) => {
        const isQueued = pendingDeleteIdSet.has(item.assetId);
        const isSelected = selectedBlurryIds.has(item.assetId);
        const isProtected = isAssetProtected({ id: item.assetId, albumId: item.albumId }, protectedAlbumIdSet, protectedAssetIdSet);
        return (
            <View style={[styles.photoCard, { borderBottomColor: colors.divider }, isSelected && { backgroundColor: colors.surfaceHover }]}>
                <Pressable
                    style={styles.photoCardBody}
                    accessibilityRole={isSelectingBlurry ? 'checkbox' : 'button'}
                    accessibilityLabel={t('blur_open_preview')}
                    accessibilityState={isSelectingBlurry ? { checked: isSelected } : undefined}
                    onPress={() => {
                        if (isSelectingBlurry) {
                            toggleBlurrySelection(item.assetId);
                        } else if (item.uri) {
                            setQueueFeedback(null);
                            setPreviewBlurryPhoto(item);
                        }
                    }}
                    onLongPress={() => {
                        if (!isSelectingBlurry) setIsSelectingBlurry(true);
                        toggleBlurrySelection(item.assetId);
                    }}
                >
                    {isSelectingBlurry && (
                        <View style={styles.selectCheckbox}>
                            <Ionicons
                                name={isSelected ? 'checkbox' : 'square-outline'}
                                size={22}
                                color={isSelected ? colors.primary : colors.textSecondary}
                            />
                        </View>
                    )}
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
                        <View style={styles.badgeRow}>
                            {isProtected && (
                                <View
                                    testID={`blurry-protected-badge-${item.assetId}`}
                                    style={[styles.queuedBadge, { backgroundColor: colors.surfaceHover }]}
                                >
                                    <Text style={[styles.queuedBadgeText, { color: colors.primary }]}>
                                        {t('protected_badge')}
                                    </Text>
                                </View>
                            )}
                            {isQueued && (
                                <View
                                    testID={`blurry-queued-badge-${item.assetId}`}
                                    style={[styles.queuedBadge, { backgroundColor: colors.surfaceHover }]}
                                >
                                    <Text style={[styles.queuedBadgeText, { color: colors.danger }]}>
                                        {t('pending_already_added')}
                                    </Text>
                                </View>
                            )}
                        </View>
                    </View>
                </Pressable>
                {!isSelectingBlurry && (
                    <View style={styles.rowActions}>
                        <Pressable
                            testID={`blurry-ignore-${item.assetId}`}
                            style={({ pressed }) => [styles.deleteButton, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }, isDeletingBlurry && { opacity: 0.5 }]}
                            disabled={isDeletingBlurry}
                            accessibilityRole="button"
                            accessibilityLabel={t('blur_ignore_action')}
                            accessibilityState={{ disabled: isDeletingBlurry, busy: isDeletingBlurry }}
                            onPress={() => void handleIgnoreBlurry([item.assetId])}
                        >
                            <Ionicons name="eye-off-outline" size={20} color={colors.textSecondary} />
                        </Pressable>
                        <Pressable
                            style={({ pressed }) => [styles.deleteButton, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }, (isDeletingBlurry || isProtected) && { opacity: 0.5 }]}
                            disabled={isDeletingBlurry}
                            accessibilityRole="button"
                            accessibilityLabel={t('pending_add')}
                            accessibilityState={{ disabled: isDeletingBlurry, busy: isDeletingBlurry }}
                            onPress={() => void handleDeleteBlurry(item.assetId)}
                        >
                            <Ionicons name={isQueued ? 'trash' : 'trash-outline'} size={20} color={colors.danger} />
                        </Pressable>
                    </View>
                )}
            </View>
        );
    };

    const isGroupProcessed = useCallback((group: SimilarGroup) => hasHydrated && group.allAccessible
        && isSimilarReviewCurrent(group.review, processedPhotoIdSet, pendingDeleteIdSet), [hasHydrated, pendingDeleteIdSet, processedPhotoIdSet]);

    const renderSimilarItem = ({ item }: { item: SimilarGroup }) => {
        const protectedCount = item.memberAssetIds.reduce((count, assetId) => (
            isAssetProtected({ id: assetId, albumId: item.memberAlbumIds[assetId] }, protectedAlbumIdSet, protectedAssetIdSet)
                ? count + 1
                : count
        ), 0);
        return (
            <SimilarGroupCard
                groupId={item.groupId}
                memberCount={item.memberCount}
                memberAssetIds={item.memberAssetIds}
                previewUris={item.previewUris}
                isProcessed={isGroupProcessed(item)}
                protectedCount={protectedCount}
                onIgnore={item.snapshotKey ? () => { void handleIgnoreSimilarGroup(item.groupId, item.snapshotKey); } : undefined}
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
    };

    // Category Detail State
    const [selectedCategory, setSelectedCategory] = useState<CategoryGroup | null>(null);
    const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
    const categoryUriCacheRef = useRef<{ version: number; entries: Map<string, string> }>({
        version: -1,
        entries: new Map(),
    });
    const categoryThumbnailWindowRef = useRef(0);
    const inFlightCategoryAssetIdsRef = useRef<Set<string>>(new Set());
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
    const categoryDetailUrisRef = useRef(categoryDetailUris);
    categoryDetailUrisRef.current = categoryDetailUris;

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
            setCategoryCoverUris({ version: permissionRefreshVersion, map: {} });
            return () => { active = false; };
        }
        const cache = getScopedUriCache(permissionRefreshVersion);
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
            setCategoryCoverUris({ version: permissionRefreshVersion, map: initialMap });
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
            setCategoryCoverUris({ version: permissionRefreshVersion, map: nextMap });
        });
        return () => { active = false; };
        // categoryCoverIdsKey encodes the exact cover ID list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [categoryCoverIdsKey, getScopedUriCache, permissionRefreshVersion]);

    const selectedCategoryAssetIds = useMemo(
        () => selectedCategory ? selectedCategory.assets.map(asset => asset.asset_id) : [],
        [selectedCategory],
    );
    const selectedCategoryKey = selectedCategory
        ? `${selectedCategory.id}:${JSON.stringify(selectedCategoryAssetIds)}`
        : '';

    const fetchCategoryAssetRange = useCallback(async (
        categoryId: string,
        assetIds: readonly string[],
        startIndex: number,
        endIndex: number,
        version: number,
        isActive: () => boolean,
    ) => {
        const clampedStart = Math.max(0, startIndex);
        const clampedEnd = Math.min(assetIds.length, endIndex);
        if (clampedStart >= clampedEnd) return;

        const slice = assetIds.slice(clampedStart, clampedEnd);
        const cache = getScopedUriCache(version);
        const currentDetail = categoryDetailUrisRef.current;
        const currentMap = currentDetail.version === version && currentDetail.categoryId === categoryId
            ? currentDetail.map
            : {};

        const missingIds: string[] = [];
        const cachedPatch: Record<string, string> = {};
        for (const assetId of slice) {
            const cachedUri = cache.get(assetId);
            if (cachedUri) {
                if (currentMap[assetId] !== cachedUri) {
                    cachedPatch[assetId] = cachedUri;
                }
            } else if (!inFlightCategoryAssetIdsRef.current.has(assetId)) {
                missingIds.push(assetId);
            }
        }

        const anchorIndex = Math.floor((clampedStart + clampedEnd) / 2);
        if (Object.keys(cachedPatch).length > 0 && isActive()) {
            setCategoryDetailUris(previous => {
                const base = previous.version === version && previous.categoryId === categoryId ? previous.map : {};
                return {
                    version,
                    categoryId,
                    map: mergeBoundedDetailMap(base, cachedPatch, assetIds, anchorIndex),
                };
            });
        }

        if (missingIds.length === 0) return;
        for (const id of missingIds) inFlightCategoryAssetIdsRef.current.add(id);
        try {
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
            if (Object.keys(resolvedPatch).length > 0) {
                setCategoryDetailUris(previous => {
                    const base = previous.version === version && previous.categoryId === categoryId ? previous.map : {};
                    return {
                        version,
                        categoryId,
                        map: mergeBoundedDetailMap(base, resolvedPatch, assetIds, anchorIndex),
                    };
                });
            }
        } finally {
            for (const id of missingIds) inFlightCategoryAssetIdsRef.current.delete(id);
        }
    }, [getScopedUriCache]);

    const selectedCategoryRef = useRef<{
        key: string;
        version: number;
        categoryId: string;
        assetIds: string[];
        indexById: Map<string, number>;
    }>({
        key: '',
        version: -1,
        categoryId: '',
        assetIds: [],
        indexById: new Map(),
    });

    const fetchCategoryAssetRangeRef = useRef(fetchCategoryAssetRange);
    fetchCategoryAssetRangeRef.current = fetchCategoryAssetRange;

    useEffect(() => {
        let active = true;
        categoryThumbnailWindowRef.current = 0;
        inFlightCategoryAssetIdsRef.current.clear();
        if (!selectedCategory || selectedCategoryAssetIds.length === 0) {
            selectedCategoryRef.current = {
                key: '',
                version: permissionRefreshVersion,
                categoryId: '',
                assetIds: [],
                indexById: new Map(),
            };
            setCategoryDetailUris({ version: permissionRefreshVersion, categoryId: '', map: {} });
            return () => { active = false; };
        }
        const categoryId = selectedCategory.id;
        const indexById = new Map<string, number>();
        selectedCategoryAssetIds.forEach((id, idx) => indexById.set(id, idx));
        selectedCategoryRef.current = {
            key: selectedCategoryKey,
            version: permissionRefreshVersion,
            categoryId,
            assetIds: selectedCategoryAssetIds,
            indexById,
        };
        const initialEnd = Math.min(selectedCategoryAssetIds.length, CATEGORY_URI_PAGE_SIZE);
        categoryThumbnailWindowRef.current = initialEnd;
        setCategoryDetailUris({ version: permissionRefreshVersion, categoryId, map: {} });
        void fetchCategoryAssetRange(
            categoryId,
            selectedCategoryAssetIds,
            0,
            initialEnd,
            permissionRefreshVersion,
            () => active,
        );
        return () => { active = false; };
        // selectedCategoryKey encodes the active category ID and asset list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fetchCategoryAssetRange, selectedCategoryKey, permissionRefreshVersion]);

    // Viewport-driven thumbnail loader: scrolling or jumping to ANY position
    // (item 100, 500, 2000, or back to 0) resolves that visible window immediately
    // without deadlocking on FlatList's single-shot onEndReached.
    const categoryViewabilityConfig = useRef({
        itemVisiblePercentThreshold: 1,
        minimumViewTime: 0,
    }).current;

    const onCategoryViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        const current = selectedCategoryRef.current;
        if (!current.categoryId || current.assetIds.length === 0 || viewableItems.length === 0) return;

        let minIndex = Number.POSITIVE_INFINITY;
        let maxIndex = -1;
        for (const token of viewableItems) {
            const rawItem = token.item as { asset_id?: string } | { asset_id?: string }[] | null | undefined;
            if (Array.isArray(rawItem)) {
                for (const sub of rawItem) {
                    const idx = sub?.asset_id ? current.indexById.get(sub.asset_id) : undefined;
                    if (idx !== undefined) {
                        if (idx < minIndex) minIndex = idx;
                        if (idx > maxIndex) maxIndex = idx;
                    }
                }
            } else {
                const idx = rawItem?.asset_id !== undefined
                    ? current.indexById.get(rawItem.asset_id)
                    : (typeof token.index === 'number' ? token.index : undefined);
                if (idx !== undefined) {
                    if (idx < minIndex) minIndex = idx;
                    if (idx > maxIndex) maxIndex = idx;
                }
            }
        }
        if (maxIndex < 0 || !Number.isFinite(minIndex)) return;

        const start = Math.max(0, minIndex - CATEGORY_URI_OVERSCAN_BEFORE);
        const end = Math.min(current.assetIds.length, maxIndex + 1 + CATEGORY_URI_OVERSCAN_AFTER);
        categoryThumbnailWindowRef.current = Math.max(categoryThumbnailWindowRef.current, end);
        void fetchCategoryAssetRangeRef.current(
            current.categoryId,
            current.assetIds,
            start,
            end,
            current.version,
            () => selectedCategoryRef.current.key === current.key && selectedCategoryRef.current.version === current.version,
        );
    }).current;

    const loadMoreCategoryThumbnails = useCallback(() => {
        const current = selectedCategoryRef.current;
        if (!current.categoryId || categoryThumbnailWindowRef.current >= current.assetIds.length) return;
        const start = categoryThumbnailWindowRef.current;
        const end = Math.min(current.assetIds.length, start + CATEGORY_URI_PAGE_SIZE);
        categoryThumbnailWindowRef.current = end;
        void fetchCategoryAssetRange(
            current.categoryId,
            current.assetIds,
            start,
            end,
            current.version,
            () => selectedCategoryRef.current.key === current.key && selectedCategoryRef.current.version === current.version,
        );
    }, [fetchCategoryAssetRange]);

    // Hard reset ONLY on permission/scope changes (`permissionRefreshVersion`),
    // never on unrelated external media additions (screenshots/edits) which
    // would otherwise destroy pagination and force-close open detail modals.
    useEffect(() => {
        if (permissionRefreshVersion === previousPermissionRefreshVersionRef.current) return;
        previousPermissionRefreshVersionRef.current = permissionRefreshVersion;

        // Invalidate and clear every result surface immediately. Otherwise a
        // full-access snapshot can remain visible while the new permission
        // scope is still being loaded.
        loadRequestIdRef.current += 1;
        visiblePhotoIdsRef.current = undefined;
        blurryCursorRef.current = null;
        similarCursorRef.current = null;
        loadingMoreBlurryRef.current = false;
        loadingMoreSimilarRef.current = false;
        categoryUriCacheRef.current = { version: -1, entries: new Map() };
        categoryThumbnailWindowRef.current = 0;
        inFlightCategoryAssetIdsRef.current.clear();
        setBlurryPhotos([]);
        setSimilarGroups([]);
        setHasMoreBlurry(false);
        setHasMoreSimilar(false);
        setLoadingMoreBlurry(false);
        setLoadingMoreSimilar(false);
        setSelectedSimilarGroup(null);
        setSelectedCategory(null);
        setSelectedPhoto(null);
        setPreviewBlurryPhoto(null);
        setIsSelectingBlurry(false);
        setSelectedBlurryIds(new Set());
        setCategoryCoverUris({ version: -1, map: {} });
        setCategoryDetailUris({ version: -1, categoryId: '', map: {} });
        setQueueFeedback(null);

        if (permissionScope !== 'none') {
            void loadResults();
        }
        if (activeTab === 'ai' && enableAIClassification) {
            void refreshAI();
        }
    }, [activeTab, enableAIClassification, loadResults, permissionRefreshVersion, permissionScope, refreshAI]);

    // Synchronize scan result views immediately after confirmPendingDeletion
    // physically deletes one or more items from the header review modal.
    useEffect(() => {
        if (lastDeletionResult === previousLastDeletionResultRef.current) return;
        previousLastDeletionResultRef.current = lastDeletionResult;
        if (!lastDeletionResult || lastDeletionResult.deletedIds.length === 0) return;

        const deletedIdSet = new Set(lastDeletionResult.deletedIds);
        setBlurryPhotos(previous => previous.filter(item => !deletedIdSet.has(item.assetId)));
        setSimilarGroups(previous => previous
            .map(group => {
                const remainingIds = group.memberAssetIds.filter(id => !deletedIdSet.has(id));
                if (remainingIds.length === group.memberAssetIds.length) return group;
                if (remainingIds.length < 2) return null;
                return {
                    ...group,
                    memberCount: remainingIds.length,
                    memberAssetIds: remainingIds,
                    bestAssetId: group.bestAssetId && deletedIdSet.has(group.bestAssetId) ? null : group.bestAssetId,
                };
            })
            .filter((group): group is SimilarGroup => group !== null));
        setSelectedPhoto(previous => (previous && deletedIdSet.has(previous) ? null : previous));
        setPreviewBlurryPhoto(previous => (previous && deletedIdSet.has(previous.assetId) ? null : previous));
        setSelectedBlurryIds(previous => {
            if (previous.size === 0) return previous;
            const next = new Set(previous);
            for (const id of deletedIdSet) next.delete(id);
            return next;
        });

        void loadResults();
        if (activeTab === 'ai' && enableAIClassification) {
            void refreshAI();
        }
    }, [activeTab, enableAIClassification, lastDeletionResult, loadResults, refreshAI]);

    const getCategoryDisplayTitle = (title: string): string => {
        const categoryTitleKey = `ai_category_${title}`;
        const translatedTitle = t(categoryTitleKey as any);
        return translatedTitle === categoryTitleKey ? title : translatedTitle;
    };

    const currentCategoryCoverMap = categoryCoverUris.version === permissionRefreshVersion
        ? categoryCoverUris.map
        : {};
    const currentCategoryDetailMap = selectedCategory
        && categoryDetailUris.version === permissionRefreshVersion
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
                    <View style={{ flex: 1 }}>
                        {blurryPhotos.length > 0 && (
                            <View style={[styles.blurToolbar, { borderBottomColor: colors.divider }]}>
                                {!isSelectingBlurry ? (
                                    <Pressable
                                        testID="blur-multiselect-toggle"
                                        accessibilityRole="button"
                                        accessibilityLabel={t('blur_multi_select')}
                                        disabled={isDeletingBlurry}
                                        onPress={() => {
                                            setQueueFeedback(null);
                                            setIsSelectingBlurry(true);
                                        }}
                                        style={({ pressed }) => [
                                            styles.toolbarChip,
                                            { backgroundColor: pressed ? colors.surfaceHover : colors.surface },
                                        ]}
                                    >
                                        <Ionicons name="checkmark-done-outline" size={16} color={colors.text} />
                                        <Text style={[styles.toolbarChipText, { color: colors.text }]}>{t('blur_multi_select')}</Text>
                                    </Pressable>
                                ) : (
                                    <View style={styles.blurSelectionControls}>
                                        <View style={styles.blurSelectionTopRow}>
                                            <Text accessibilityLiveRegion="polite" style={[styles.metaText, { color: colors.text }]}>
                                                {t('blur_selected_count', { count: selectedBlurryIds.size })}
                                            </Text>
                                            <View style={styles.blurSelectionTopButtons}>
                                                <Pressable
                                                    accessibilityRole="button"
                                                    accessibilityLabel={selectedBlurryIds.size === blurryPhotos.length ? t('blur_deselect_all') : t('blur_select_all')}
                                                    disabled={isDeletingBlurry}
                                                    onPress={() => {
                                                        if (selectedBlurryIds.size === blurryPhotos.length) {
                                                            setSelectedBlurryIds(new Set());
                                                        } else {
                                                            setSelectedBlurryIds(new Set(blurryPhotos.map(item => item.assetId)));
                                                        }
                                                    }}
                                                    style={[styles.toolbarChip, { backgroundColor: colors.surface }]}
                                                >
                                                    <Text style={[styles.toolbarChipText, { color: colors.text }]}>
                                                        {selectedBlurryIds.size === blurryPhotos.length ? t('blur_deselect_all') : t('blur_select_all')}
                                                    </Text>
                                                </Pressable>
                                                <Pressable
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('cancel')}
                                                    disabled={isDeletingBlurry}
                                                    onPress={exitBlurrySelection}
                                                    style={[styles.toolbarChip, { backgroundColor: colors.surface }]}
                                                >
                                                    <Text style={[styles.toolbarChipText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
                                                </Pressable>
                                            </View>
                                        </View>
                                        {selectedBlurryIds.size > 0 && (
                                            <View style={styles.blurBatchRow}>
                                                <Pressable
                                                    testID="blur-batch-queue-delete"
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('blur_batch_queue_delete', { count: selectedBlurryIds.size })}
                                                    disabled={isDeletingBlurry}
                                                    onPress={() => void handleBatchQueueBlurry()}
                                                    style={[styles.batchActionButton, { backgroundColor: colors.dangerBackground, opacity: isDeletingBlurry ? 0.5 : 1 }]}
                                                >
                                                    <Text style={[styles.batchActionText, { color: colors.dangerForeground }]}>
                                                        {t('blur_batch_queue_delete', { count: selectedBlurryIds.size })}
                                                    </Text>
                                                </Pressable>
                                                <Pressable
                                                    testID="blur-batch-ignore"
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('blur_batch_ignore', { count: selectedBlurryIds.size })}
                                                    disabled={isDeletingBlurry}
                                                    onPress={() => void handleIgnoreBlurry(Array.from(selectedBlurryIds))}
                                                    style={[styles.batchActionButton, { backgroundColor: colors.surfaceHover, opacity: isDeletingBlurry ? 0.5 : 1 }]}
                                                >
                                                    <Text style={[styles.batchActionText, { color: colors.text }]}>
                                                        {t('blur_batch_ignore', { count: selectedBlurryIds.size })}
                                                    </Text>
                                                </Pressable>
                                            </View>
                                        )}
                                    </View>
                                )}
                            </View>
                        )}
                        <FlatList<BlurryPhoto>
                            testID="blurry-results-list"
                            data={blurryPhotos}
                            extraData={{ pendingDeleteIdSet, isSelectingBlurry, selectedBlurryIds, protectedAlbumIdSet, protectedAssetIdSet }}
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
                    </View>
                ) : (
                    <FlatList<SimilarGroup>
                        testID="similar-results-list"
                        data={similarGroups}
                        extraData={processedPhotoIdSet}
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
                onClose={(didChange = false) => {
                    const closedGroupId = selectedSimilarGroup?.group.groupId;
                    setSelectedSimilarGroup(null);
                    // Only refresh when the user actually changed a decision in the
                    // overlay, updating the card in place so scrolling/pagination is
                    // never jolted back to page 1 on an inspect-only close.
                    if (didChange && closedGroupId) {
                        void refreshSimilarGroupInPlace(closedGroupId);
                    }
                }}
                onComplete={() => setSelectedSimilarGroup(null)}
                onIgnore={(snapshotKey) => {
                    const closedGroupId = selectedSimilarGroup?.group.groupId;
                    ignoredSimilarKeysRef.current.add(snapshotKey);
                    setSimilarGroups(previous => previous.filter(
                        item => item.groupId !== closedGroupId && item.snapshotKey !== snapshotKey,
                    ));
                    setSelectedSimilarGroup(null);
                    setQueueFeedback(t('similar_hidden_feedback'));
                }}
            />

            {/* Zoomable Blur Photo Preview Modal */}
            <ZoomablePhotoModal
                testID="blur-zoom-preview"
                visible={!!previewBlurryPhoto}
                photo={previewBlurryPhoto?.uri ? { id: previewBlurryPhoto.assetId, uri: previewBlurryPhoto.uri } : null}
                title={t('photo_detail_title')}
                subtitle={previewBlurryPhoto
                    ? `${t('scan_blur_score', { score: previewBlurryPhoto.blurScore.toFixed(1) })} · ${t('scan_brightness', { value: previewBlurryPhoto.meanLuma.toFixed(0) })}`
                    : undefined}
                isProtected={previewBlurryPhoto
                    ? isAssetProtected({ id: previewBlurryPhoto.assetId, albumId: previewBlurryPhoto.albumId }, protectedAlbumIdSet, protectedAssetIdSet)
                    : false}
                feedback={queueFeedback}
                onClose={() => setPreviewBlurryPhoto(null)}
                actions={previewBlurryPhoto ? [
                    {
                        id: 'ignore',
                        testID: 'blur-preview-ignore',
                        label: t('blur_ignore_action'),
                        icon: 'eye-off-outline',
                        tone: 'default',
                        disabled: isDeletingBlurry,
                        onPress: () => { void handleIgnoreBlurry([previewBlurryPhoto.assetId]); },
                    },
                    {
                        id: 'delete',
                        testID: 'blur-preview-queue-delete',
                        label: pendingDeleteIdSet.has(previewBlurryPhoto.assetId) ? t('pending_already_added') : t('pending_add'),
                        icon: pendingDeleteIdSet.has(previewBlurryPhoto.assetId) ? 'trash' : 'trash-outline',
                        tone: 'danger',
                        disabled: isDeletingBlurry,
                        onPress: () => { void handleDeleteBlurry(previewBlurryPhoto.assetId); },
                    },
                ] : []}
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
                            viewabilityConfig={categoryViewabilityConfig}
                            onViewableItemsChanged={onCategoryViewableItemsChanged}
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
    photoCardBody: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    selectCheckbox: {
        width: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badgeRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    rowActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
    },
    blurToolbar: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    blurSelectionControls: {
        gap: 10,
    },
    blurSelectionTopRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    blurSelectionTopButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    blurBatchRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    toolbarChip: {
        minHeight: 36,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        alignSelf: 'flex-start',
    },
    toolbarChipText: {
        ...TYPOGRAPHY.caption,
        fontWeight: '600',
    },
    batchActionButton: {
        flex: 1,
        minWidth: 132,
        minHeight: UI_METRICS.touchTarget,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: UI_METRICS.buttonRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    batchActionText: {
        ...TYPOGRAPHY.button,
        textAlign: 'center',
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
    queuedBadge: {
        alignSelf: 'flex-start',
        marginTop: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
    },
    queuedBadgeText: {
        ...TYPOGRAPHY.caption,
        fontWeight: '600',
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
