import * as MediaLibrary from 'expo-media-library';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { flushMediaProgress, mediaProgressStorage } from '../services/mediaProgressStorage';
import { markEncryptedStorageHydrated } from '../services/privacy/encryptedStorage';
import { mergeProtectedState } from '../services/privacy/mergeState';
import { usePrivacyStore } from './usePrivacyStore';
import { isRecordTransferActive } from '../services/recordOperationLock';
import { Platform } from 'react-native';
import { AssetRepository } from '../database';
import { deleteAssetsInBatches, getDeletionFailureKind } from '../services/mediaDeletion';
import { getReadableMediaInfos, inspectReadableMediaInfos } from '../services/readableMedia';
import { getPendingDeletionEntries, retainPendingDeletionInfo, PendingDeletionIncompleteError } from '../services/pendingDeletion';
import type { PendingDeletionInfo, PendingDeletionResult, PendingDeletionSource } from '../services/pendingDeletion';
import { advanceOrganizingSession, continueOrganizingSession, createOrganizingSession, moveOrganizingSession, removeDeletedSessionMedia, revisitDeferredMedia } from '../services/organizingSession';
import type { OrganizingSession, OrganizingOrder, SessionScope } from '../services/organizingSession';
import { loadLargestMedia, MediaSizeReadError } from '../services/largestMedia';
import { recoverOrganizingSession } from '../services/sessionRecovery';
import type { SessionRecoveryResult } from '../services/sessionRecovery';
import { appendRecentDecision, sameDecisionSnapshot } from '../services/recentDecisions';
import type { DecisionSnapshot, RecentDecision, RecentDecisionResult } from '../services/recentDecisions';
import { readRecentDecisionMedia } from '../services/recentDecisionMedia';
import { isMediaDateFilter, mediaDateQuery, mediaMatchesDate } from '../services/mediaMonth';
import type { MediaDateFilter } from '../services/mediaMonth';
import { DisplayOrder, useSettingsStore } from './useSettingsStore';

export interface PhotoAsset extends MediaLibrary.Asset {
    // Add any custom properties if needed later
}

export type MediaPermissionScope = 'none' | 'limited' | 'full';
export type MediaType = 'photo' | 'video';

/**
 * iOS exposes selected-photo access for the media feed, but its album APIs
 * require full photo-library access. Android and web do not have this
 * additional album-access restriction in the current supported runtimes.
 */
export async function hasFullPhotoLibraryAccess(): Promise<boolean> {
    if (Platform.OS !== 'ios') return true;

    try {
        const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
        return permission.granted && permission.accessPrivileges === 'all';
    } catch (error) {
        console.warn('[MediaStore] Failed to verify album access.');
        return false;
    }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return leftSet.size === rightSet.size && Array.from(leftSet).every(value => rightSet.has(value));
}

export async function getCurrentlyVisibleAssetIds(
    assetIds: readonly string[],
    mediaType: MediaType,
): Promise<ReadonlySet<string>> {
    const requestedIds = Array.from(new Set(assetIds));
    if (requestedIds.length === 0) return new Set();

    let permission: MediaLibrary.PermissionResponse;
    try {
        permission = await MediaLibrary.getPermissionsAsync(false, [mediaType]);
    } catch (error) {
        console.warn(`[MediaStore] Failed to verify ${mediaType} asset visibility.`);
        return new Set();
    }

    if (!permission.granted) return new Set();

    const visible = await getReadableMediaInfos(requestedIds, mediaType);
    return new Set(visible.keys());
}

async function getCurrentlyVisibleQueuedAssets<T extends { id: string }>(
    assets: readonly T[],
    mediaType: MediaType,
): Promise<T[]> {
    if (assets.length === 0) return [];
    const visibleIds = await getCurrentlyVisibleAssetIds(
        assets.map(asset => asset.id),
        mediaType,
    );
    return assets.filter(asset => visibleIds.has(asset.id));
}

/** SDK deletion can reject after deleting some members of one request. Only
 * a successful full-access enumeration can establish absence: a denied,
 * limited, failed or incomplete lookup must never stand for physical deletion. */
async function findGoneAfterFailedDeletion(assets: readonly PhotoAsset[], type: MediaType): Promise<PhotoAsset[]> {
    try {
        const before = await MediaLibrary.getPermissionsAsync(false, [type]);
        if (!before.granted || before.accessPrivileges !== 'all') return [];
        const permissionVersion = useMediaStore.getState().permissionRefreshVersion;
        const remaining = new Set(assets.map(asset => asset.id));
        const seenCursors = new Set<string>();
        let after: string | undefined;
        while (true) {
            const result = await MediaLibrary.getAssetsAsync({ mediaType: type, first: 200, ...(after ? { after } : {}) });
            for (const asset of result.assets) remaining.delete(asset.id);
            if (!result.hasNextPage) break;
            if (!result.endCursor || seenCursors.has(result.endCursor)) return [];
            seenCursors.add(result.endCursor);
            after = result.endCursor;
        }
        const finalPermission = await MediaLibrary.getPermissionsAsync(false, [type]);
        if (!finalPermission.granted || finalPermission.accessPrivileges !== 'all'
            || permissionVersion !== useMediaStore.getState().permissionRefreshVersion) return [];
        return assets.filter(asset => remaining.has(asset.id));
    } catch { return []; }
}

function retainHiddenQueuedAssetIds(
    hiddenIds: readonly string[] | null,
    remainingAssetIds: readonly string[],
): string[] {
    const remainingIds = new Set(remainingAssetIds);
    if (hiddenIds === null) {
        // A null hidden list means visibility has not been resolved yet. Keep
        // every remaining queue item hidden until a fresh check completes.
        return Array.from(remainingIds);
    }
    return Array.from(new Set(hiddenIds.filter(id => remainingIds.has(id))));
}

interface MediaState {
    photos: PhotoAsset[];
    videos: PhotoAsset[];
    albums: MediaLibrary.Album[];

    currentIndex: number;
    videoCurrentIndex: number;

    deleteQueue: PhotoAsset[];
    collectionQueue: PhotoAsset[];
    videoTrashBin: PhotoAsset[];
    pendingDeletionInfo: Record<string, PendingDeletionInfo>;
    deletedCounts: { photos: number; videos: number };
    lastDeletionResult: PendingDeletionResult | null;
    recentDecisions: RecentDecision[];
    organizingSessions: { photo: OrganizingSession | null; video: OrganizingSession | null };
    photoSessionRecoveryStatus: SessionRecoveryResult['status'] | null;
    photoSessionUnavailableCount: number;
    videoSessionRecoveryStatus: SessionRecoveryResult['status'] | null;
    videoSessionUnavailableCount: number;

    // Separated progress tracking
    photoProcessedIds: string[];
    videoProcessedIds: string[];

    totalPhotos: number;
    totalVideos: number;

    isLoading: boolean;
    photoLoadFailed: boolean;
    videoLoadFailed: boolean;
    isConfirmingDeletion: boolean;
    isConfirmingVideoTrash: boolean;
    hasPermission: boolean;
    permissionScope: MediaPermissionScope | null;
    permissionRefreshVersion: number;
    mediaLibraryRefreshVersion: number;
    hiddenPhotoQueuedAssetIds: string[] | null;
    hiddenVideoQueuedAssetIds: string[] | null;
    hasHydrated: boolean;

    // Actions
    startOrganizingSession: (kind: MediaType, scope: SessionScope, assetIds: readonly string[]) => OrganizingSession | null;
    deferSessionMedia: (kind: MediaType, assetId: string) => boolean;
    continueSessionBatch: (kind: MediaType, assetIds: readonly string[]) => boolean;
    revisitSessionDeferred: (kind: MediaType, assetIds?: readonly string[]) => boolean;
    resumeOrganizingSession: (kind: MediaType) => Promise<SessionRecoveryResult>;
    moveVideoSession: (assetId: string) => boolean;
    finishVideoSession: () => boolean;
    loadAlbums: () => Promise<void>;
    createAlbum: (name: string, asset: PhotoAsset) => Promise<void>;
    addAssetToAlbum: (albumId: string, asset: PhotoAsset) => Promise<void>;

    loadPhotos: (count: number, displayOrder?: OrganizingOrder, albumIds?: string[], sessionMode?: 'new' | 'continue', date?: MediaDateFilter) => Promise<void>;
    loadVideos: (count: number, displayOrder?: OrganizingOrder, albumIds?: string[], sessionMode?: 'new' | 'continue', date?: MediaDateFilter) => Promise<void>;

    markForDeletion: (asset: PhotoAsset) => void;
    enqueuePendingDeletion: (assets: readonly PhotoAsset[], source: PendingDeletionSource) => number;
    keepPendingDeletion: (assetId: string) => boolean;
    keepAllPendingDeletion: (assetIds: readonly string[]) => number;
    confirmPendingDeletion: (assetIds?: readonly string[]) => Promise<PendingDeletionResult>;
    markForCollection: (asset: PhotoAsset) => void;
    markAsSkipped: (asset: PhotoAsset) => void;
    keepPhotosFromSimilar: (assets: readonly PhotoAsset[]) => boolean;
    undoAction: (assetId: string) => void;
    changeRecentDecision: (eventId: string, action: 'undo' | 'keep' | 'pending') => Promise<RecentDecisionResult>;
    keepPhotoFromDeleteQueue: (assetId: string) => boolean;

    markVideoForTrash: (asset: PhotoAsset) => void;
    markVideoAsProcessed: (asset: PhotoAsset) => void;
    restoreFromTrash: (assetId: string) => void;
    removeDeletedAssets: (assetIds: readonly string[]) => void;
    pruneUnavailableQueuedAssets: (scope: MediaPermissionScope, mediaType?: MediaType) => void;

    confirmDeletion: (assetIds?: readonly string[]) => Promise<string[]>;
    confirmVideoTrash: (assetIds?: readonly string[]) => Promise<string[]>;

    refreshTotalCounts: () => Promise<void>;

    clearLoadedMedia: () => void;

    resetBatch: (assetIds?: readonly string[]) => void;
    resetPhotoProgress: () => void;
    resetVideoProgress: () => void;
    setPermission: (status: boolean) => void;
    setPermissionScope: (scope: MediaPermissionScope) => void;
    notifyPermissionRefresh: () => void;
    notifyMediaLibraryRefresh: () => void;
    refreshQueuedAssetVisibility: (scope: MediaPermissionScope, mediaType?: MediaType) => void;
    getVisibleProcessedCounts: () => Promise<{ photos: number; videos: number }>;
    setHasHydrated: (status: boolean) => void;
}

interface OrderedAlbumPage {
    albumId: string;
    after?: string;
    assets: MediaLibrary.Asset[];
    index: number;
    hasNextPage: boolean;
    endCursor: string;
}

function advancePhotoSession(state: MediaState, processed: ReadonlySet<string>): MediaState['organizingSessions'] {
    let session = state.organizingSessions.photo;
    if (!session || session.phase !== 'organizing') return state.organizingSessions;
    const original = session;
    while (session.phase === 'organizing' && (processed.has(session.assetIds[session.position])
        || session.deferredIds.includes(session.assetIds[session.position]))) {
        const assetId = session.assetIds[session.position];
        session = advanceOrganizingSession(session, assetId, processed.has(assetId) ? 'processed' : 'skip');
    }
    return session === original ? state.organizingSessions : { ...state.organizingSessions, photo: session };
}

/** Video navigation can go backwards. Completion must check every member,
 * rather than treating a later readable video's position as proof of review. */
function advanceVideoSession(state: MediaState, processed: ReadonlySet<string>): MediaState['organizingSessions'] {
    const session = state.organizingSessions.video;
    if (!session || session.phase !== 'organizing') return state.organizingSessions;
    const unresolved = session.assetIds.filter(id => !processed.has(id) && !session.deferredIds.includes(id));
    if (!unresolved.length) return { ...state.organizingSessions, video: moveOrganizingSession(session, session.assetIds.length) };
    if (unresolved.includes(session.assetIds[session.position])) return state.organizingSessions;
    const next = session.assetIds.slice(session.position).find(id => unresolved.includes(id)) ?? unresolved[0];
    return { ...state.organizingSessions, video: moveOrganizingSession(session, session.assetIds.indexOf(next)) };
}

function currentVideoIndex(videos: readonly PhotoAsset[], session: OrganizingSession | null, fallback: number): number {
    const wanted = session?.assetIds.slice(session.position).find(id => videos.some(asset => asset.id === id));
    return wanted ? videos.findIndex(asset => asset.id === wanted) : Math.max(0, Math.min(fallback, videos.length - 1));
}

function decisionSnapshot(state: MediaState, kind: MediaType, assetId: string): DecisionSnapshot {
    const queue = kind === 'photo' ? state.deleteQueue : state.videoTrashBin;
    return {
        processed: (kind === 'photo' ? state.photoProcessedIds : state.videoProcessedIds).includes(assetId),
        pending: queue.some(asset => asset.id === assetId) ? state.pendingDeletionInfo[assetId] ?? { source: 'unknown', addedAt: 0 } : null,
        collected: kind === 'photo' && state.collectionQueue.some(asset => asset.id === assetId),
        deferred: !!state.organizingSessions[kind]?.deferredIds.includes(assetId),
    };
}
function clearDeferredDecision(sessions: MediaState['organizingSessions'], kind: MediaType, assetId: string): MediaState['organizingSessions'] {
    const session = sessions[kind];
    if (!session?.deferredIds.includes(assetId)) return sessions;
    return { ...sessions, [kind]: { ...session, deferredIds: session.deferredIds.filter(id => id !== assetId),
        updatedAt: Math.max(session.startedAt, Date.now()) } };
}
function withRecentDecision(state: MediaState, next: Partial<MediaState>, kind: MediaType, assetId: string): Partial<MediaState> {
    const before = decisionSnapshot(state, kind, assetId), after = decisionSnapshot({ ...state, ...next }, kind, assetId);
    if (sameDecisionSnapshot(before, after)) return next;
    const session = state.organizingSessions[kind];
    const inSession = !!session?.assetIds.includes(assetId);
    const at = Date.now();
    let eventId: string;
    do { eventId = `decision-${at}-${++recentDecisionSequence}`; } while (state.recentDecisions.some(entry => entry.eventId === eventId));
    return { ...next, recentDecisions: appendRecentDecision(next.recentDecisions ?? state.recentDecisions, {
        version: 1, eventId, assetId, kind,
        action: after.pending ? 'pending' : after.collected ? 'collect' : after.deferred ? 'defer' : 'keep',
        before, after, at, sessionId: inSession ? session!.sessionId : null, position: inSession ? session!.position : null,
    }) };
}

export function recentDecisionIsCurrent(state: MediaState, entry: RecentDecision): boolean {
    const latest = state.recentDecisions.find(item => item.assetId === entry.assetId && item.kind === entry.kind);
    // A skip belongs to one round. Never recreate an old round's exclusion in
    // a different round just because the global keep flags happen to match.
    return latest === entry && sameDecisionSnapshot(decisionSnapshot(state, entry.kind, entry.assetId), entry.after)
        && (!(entry.before.deferred || entry.after.deferred) || state.organizingSessions[entry.kind]?.sessionId === entry.sessionId);
}
function applyDecisionSnapshot(state: MediaState, entry: RecentDecision, snapshot: DecisionSnapshot, asset: PhotoAsset): Partial<MediaState> {
    const id = entry.assetId, kind = entry.kind;
    const deleteQueue = kind === 'photo' ? state.deleteQueue.filter(item => item.id !== id) : state.deleteQueue;
    const videoTrashBin = kind === 'video' ? state.videoTrashBin.filter(item => item.id !== id) : state.videoTrashBin;
    const collectionQueue = kind === 'photo' ? state.collectionQueue.filter(item => item.id !== id) : state.collectionQueue;
    if (snapshot.pending) (kind === 'photo' ? deleteQueue : videoTrashBin).push(asset);
    if (snapshot.collected && kind === 'photo') collectionQueue.push(asset);
    const originalProcessed = kind === 'photo' ? state.photoProcessedIds : state.videoProcessedIds;
    const processed = snapshot.processed ? originalProcessed.includes(id) ? originalProcessed : [...originalProcessed, id]
        : originalProcessed.filter(value => value !== id);
    const info = { ...state.pendingDeletionInfo };
    delete info[id];
    if (snapshot.pending) info[id] = { ...snapshot.pending };
    let sessions = clearDeferredDecision(state.organizingSessions, kind, id);
    let session = sessions[kind];
    if (session) {
        if (snapshot.deferred) session = { ...session, deferredIds: [...new Set([...session.deferredIds, id])] };
        const index = session.assetIds.indexOf(id);
        // Returning an unreviewed member cannot abandon other members or
        // rewind to a numeric position belonging to a different batch.
        if (index >= 0 && !snapshot.processed && !snapshot.deferred) session = moveOrganizingSession(session, kind === 'video' ? index : Math.min(index, session.position));
        sessions = { ...sessions, [kind]: session };
        sessions = kind === 'photo' ? advancePhotoSession({ ...state, organizingSessions: sessions }, new Set(processed))
            : advanceVideoSession({ ...state, organizingSessions: sessions }, new Set(processed));
    }
    const videos = kind === 'video' && (snapshot.pending || snapshot.deferred) ? state.videos.filter(item => item.id !== id) : state.videos;
    return { deleteQueue, videoTrashBin, collectionQueue, pendingDeletionInfo: info, organizingSessions: sessions, lastDeletionResult: null,
        ...(kind === 'video' ? { videos, videoCurrentIndex: currentVideoIndex(videos, sessions.video, state.videoCurrentIndex) } : {}),
        ...(kind === 'photo' ? { photoProcessedIds: processed } : { videoProcessedIds: processed }),
        // The target was just verified; no other hidden queue is made visible.
        ...(kind === 'photo' ? { hiddenPhotoQueuedAssetIds: state.permissionScope === 'full' ? null
            : (state.hiddenPhotoQueuedAssetIds ?? [...deleteQueue, ...collectionQueue].map(item => item.id)).filter(value => value !== id) }
            : { hiddenVideoQueuedAssetIds: state.hiddenVideoQueuedAssetIds === null ? null : state.hiddenVideoQueuedAssetIds.filter(value => value !== id) }),
    };
}

function removeDeletedState(state: MediaState, deletedIds: ReadonlySet<string>): Partial<MediaState> {
    const deleteQueue = state.deleteQueue.filter(asset => !deletedIds.has(asset.id));
    const videoTrashBin = state.videoTrashBin.filter(asset => !deletedIds.has(asset.id));
    return { deleteQueue, videoTrashBin,
        recentDecisions: state.recentDecisions.filter(entry => !deletedIds.has(entry.assetId)),
        organizingSessions: { photo: removeDeletedSessionMedia(state.organizingSessions.photo, deletedIds),
            video: removeDeletedSessionMedia(state.organizingSessions.video, deletedIds) },
        collectionQueue: state.collectionQueue.filter(asset => !deletedIds.has(asset.id)),
        pendingDeletionInfo: retainPendingDeletionInfo({ ...state, deleteQueue, videoTrashBin }),
        photoProcessedIds: state.photoProcessedIds.filter(id => !deletedIds.has(id)),
        videoProcessedIds: state.videoProcessedIds.filter(id => !deletedIds.has(id)),
        hiddenPhotoQueuedAssetIds: state.hiddenPhotoQueuedAssetIds?.filter(id => !deletedIds.has(id)) ?? null,
        hiddenVideoQueuedAssetIds: state.hiddenVideoQueuedAssetIds?.filter(id => !deletedIds.has(id)) ?? null };
}

async function normalizeAlbumIds(albumIds: readonly string[]): Promise<string[]> {
    const requestedAlbumIds = Array.from(new Set(albumIds));
    if (requestedAlbumIds.length === 0) return [];

    if (!(await hasFullPhotoLibraryAccess())) {
        throw new Error('Full photo-library access is required for album filters on iOS');
    }

    // Album IDs are owned by the device media library and can disappear
    // outside the app. Validate them before querying assets because iOS
    // treats an unknown album as an unscoped query, while Android returns no
    // matching assets.
    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    const availableAlbumIds = new Set(albums.map(album => album.id));
    const validAlbumIds = requestedAlbumIds.filter(albumId => availableAlbumIds.has(albumId));

    // An empty selection means "all albums". If every previously selected
    // album disappeared, keep the stale IDs so this filter remains an empty
    // scope until the user explicitly clears it. Collapsing it to [] here
    // would silently widen the query to the whole library.
    // This helper is asynchronous. Do not let an older album validation
    // overwrite a newer selection made while the native query was pending.
    const currentSelectedAlbumIds = useSettingsStore.getState().selectedAlbumIds;
    if (
        validAlbumIds.length > 0
        && validAlbumIds.length !== requestedAlbumIds.length
        && sameStringSet(currentSelectedAlbumIds, requestedAlbumIds)
    ) {
        useSettingsStore.getState().setSelectedAlbums(validAlbumIds);
    }

    return validAlbumIds;
}

async function assertAlbumsStillAvailable(albumIds: readonly string[]): Promise<void> {
    if (albumIds.length === 0) return;

    if (!(await hasFullPhotoLibraryAccess())) {
        throw new Error('Full photo-library access is required for album filters on iOS');
    }

    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    const availableAlbumIds = new Set(albums.map(album => album.id));
    if (albumIds.some(albumId => !availableAlbumIds.has(albumId))) {
        throw new Error('One or more selected albums are no longer available');
    }
}

async function loadAlbumPage(
    state: OrderedAlbumPage,
    mediaType: MediaType,
    sortBy: MediaLibrary.SortByValue[],
    date?: MediaDateFilter,
): Promise<void> {
    const result = await MediaLibrary.getAssetsAsync({
        mediaType,
        first: 100,
        sortBy,
        album: state.albumId,
        ...mediaDateQuery(date),
        ...(state.after ? { after: state.after } : {}),
    });

    state.assets = result.assets;
    state.index = 0;
    state.hasNextPage = result.hasNextPage;
    state.endCursor = result.endCursor;
}

/**
 * Merge several already-sorted album streams so ordered review modes use the
 * same global order as a single-library query. Fetching only the first album
 * until it fills the batch would otherwise hide newer/older assets in later
 * selected albums.
 */
async function loadOrderedAlbumAssets(
    mediaType: MediaType,
    sortBy: MediaLibrary.SortByValue[],
    count: number,
    displayOrder: DisplayOrder,
    processed: ReadonlySet<string>,
    albumIds: readonly string[],
    date?: MediaDateFilter,
): Promise<MediaLibrary.Asset[]> {
    const states: OrderedAlbumPage[] = Array.from(new Set(albumIds)).map(albumId => ({
        albumId,
        assets: [],
        index: 0,
        hasNextPage: true,
        endCursor: '',
    }));

    await Promise.all(states.map(state => loadAlbumPage(state, mediaType, sortBy, date)));

    const selected: MediaLibrary.Asset[] = [];
    const seenAssetIds = new Set<string>();

    while (selected.length < count) {
        const candidates = (await Promise.all(states.map(async state => {
            while (true) {
                if (state.index < state.assets.length) {
                    const asset = state.assets[state.index];
                    if (processed.has(asset.id) || seenAssetIds.has(asset.id) || !mediaMatchesDate(asset.creationTime, date)) {
                        state.index++;
                        continue;
                    }
                    return { state, asset };
                }

                if (!state.hasNextPage) return null;

                const nextCursor = state.endCursor;
                if (!nextCursor || nextCursor === state.after) {
                    throw new Error(`Media library returned an invalid pagination cursor for album ${state.albumId}`);
                }
                state.after = nextCursor;
                await loadAlbumPage(state, mediaType, sortBy, date);
            }
        }))).filter((candidate): candidate is { state: OrderedAlbumPage; asset: MediaLibrary.Asset } => (
            candidate !== null
        ));

        if (candidates.length === 0) break;

        candidates.sort((a, b) => {
            const timeDifference = a.asset.creationTime - b.asset.creationTime;
            if (timeDifference !== 0) {
                return displayOrder === 'oldest' ? timeDifference : -timeDifference;
            }
            return a.asset.id.localeCompare(b.asset.id);
        });

        const next = candidates[0];
        next.state.index++;
        seenAssetIds.add(next.asset.id);
        selected.push(next.asset);
    }

    return selected;
}

/**
 * Load enough pages to fill the current review batch. Random mode uses
 * reservoir sampling so it does not need to retain the whole media library
 * in memory.
 */
async function loadAssetsForReview(
    mediaType: MediaType,
    sortBy: MediaLibrary.SortByValue[],
    count: number,
    displayOrder: OrganizingOrder,
    processedIds: readonly string[],
    albumIds: readonly string[],
    date?: MediaDateFilter,
    isCurrent: () => boolean = () => true,
): Promise<{ assets: MediaLibrary.Asset[]; totalCount: number | null }> {
    if (displayOrder === 'largest') return loadLargestMedia(mediaType, count, albumIds, new Set(processedIds), date, isCurrent);
    if (count <= 0) {
        return { assets: [], totalCount: 0 };
    }

    const processed = new Set(processedIds);
    const normalizedAlbumIds = await normalizeAlbumIds(albumIds);
    // An empty selection means "all albums" in persisted settings, but a
    // non-empty selection whose IDs all disappeared means "nothing in scope".
    // Keep those two states distinct so stale album IDs cannot widen a query.
    const hasAlbumFilter = new Set(albumIds).size > 0;

    if (hasAlbumFilter && normalizedAlbumIds.length === 0) {
        return { assets: [], totalCount: null };
    }

    if (normalizedAlbumIds.length > 0 && displayOrder !== 'random') {
        const assets = await loadOrderedAlbumAssets(
            mediaType,
            sortBy,
            count,
            displayOrder,
            processed,
            normalizedAlbumIds,
            date,
        );
        // iOS falls back to an unscoped query if an album disappears while a
        // page is being fetched. Do not publish that page to the feed.
        await assertAlbumsStillAvailable(normalizedAlbumIds);
        return {
            assets,
            totalCount: null,
        };
    }

    const seenAssetIds = normalizedAlbumIds.length > 0 ? new Set<string>() : null;
    const selected: MediaLibrary.Asset[] = [];
    let eligibleCount = 0;
    let totalCount: number | null = null;

    const queryAlbums: Array<string | undefined> = normalizedAlbumIds.length > 0
        ? normalizedAlbumIds
        : hasAlbumFilter
            ? []
            : [undefined];

    for (const albumId of queryAlbums) {
        let after: string | undefined;

        while (true) {
            const result = await MediaLibrary.getAssetsAsync({
                mediaType,
                first: 100,
                sortBy,
                ...mediaDateQuery(date),
                ...(albumId ? { album: albumId } : {}),
                ...(after ? { after } : {}),
            });

            if (result.hasNextPage && (!result.endCursor || result.endCursor === after)) {
                throw new Error('Media library returned an invalid pagination cursor');
            }

            if (totalCount === null && normalizedAlbumIds.length === 0 && date === undefined) {
                totalCount = result.totalCount;
            }

            for (const asset of result.assets) {
                if (seenAssetIds?.has(asset.id)) continue;
                seenAssetIds?.add(asset.id);
                if (processed.has(asset.id) || !mediaMatchesDate(asset.creationTime, date)) continue;

                if (displayOrder === 'random') {
                    eligibleCount++;
                    if (selected.length < count) {
                        selected.push(asset);
                    } else {
                        const replacementIndex = Math.floor(Math.random() * eligibleCount);
                        if (replacementIndex < count) {
                            selected[replacementIndex] = asset;
                        }
                    }
                } else if (selected.length < count) {
                    selected.push(asset);
                }
            }

            // Ordered queries can stop as soon as this batch is full. Random
            // queries must inspect every page to sample uniformly.
            if (displayOrder !== 'random' && selected.length >= count) {
                break;
            }

            const nextCursor = result.endCursor;
            if (!result.hasNextPage) {
                break;
            }
            after = nextCursor;
        }

        if (displayOrder !== 'random' && selected.length >= count) {
            break;
        }
    }

    await assertAlbumsStillAvailable(normalizedAlbumIds);
    if (displayOrder === 'random') {
        // Reservoir sampling chooses which assets to show, but keeps library
        // order when the eligible set fits within one batch. Shuffle the
        // selected batch so "random" also changes the viewing order.
        for (let index = selected.length - 1; index > 0; index--) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            [selected[index], selected[swapIndex]] = [selected[swapIndex], selected[index]];
        }
    }
    return { assets: selected.slice(0, count), totalCount };
}

async function getVisibleAssetIds(mediaType: MediaType): Promise<Set<string>> {
    const permission = await MediaLibrary.getPermissionsAsync(false, [mediaType]);
    if (!permission.granted) return new Set();

    const visibleIds = new Set<string>();
    let after: string | undefined;

    while (true) {
        const result = await MediaLibrary.getAssetsAsync({
            mediaType,
            first: 100,
            ...(after ? { after } : {}),
        });

        for (const asset of result.assets) {
            visibleIds.add(asset.id);
        }

        if (!result.hasNextPage) break;
        if (!result.endCursor || result.endCursor === after) {
            throw new Error(`Media library returned an invalid pagination cursor while reading visible ${mediaType} assets`);
        }
        after = result.endCursor;
    }

    return visibleIds;
}

async function getVisibleTotalCount(mediaType: MediaType): Promise<number> {
    const permission = await MediaLibrary.getPermissionsAsync(false, [mediaType]);
    if (!permission.granted) return 0;

    const result = await MediaLibrary.getAssetsAsync({
        mediaType,
        first: 1,
    });
    return result.totalCount;
}

let activeMediaLoads = 0;
let albumLoadRequestId = 0;
let photoLoadRequestId = 0;
let totalCountsRequestId = 0;
let videoLoadRequestId = 0;
let photoQueueVisibilityRequestId = 0;
let videoQueueVisibilityRequestId = 0;
let photoQueuePruneRequestId = 0;
let videoQueuePruneRequestId = 0;
let organizingSessionSequence = 0; // Identity only, never a cryptographic key.
let recentDecisionSequence = 0; // Local event identity, not a key or media identifier.
let recentDecisionRequest = 0;

export const useMediaStore = create<MediaState>()(
    persist(
        (set, get) => ({
    photos: [],
    videos: [],
    albums: [],
    photoProcessedIds: [],
    videoProcessedIds: [],
    totalPhotos: 0,
    totalVideos: 0,

    currentIndex: 0,
    videoCurrentIndex: 0,

    deleteQueue: [],
    collectionQueue: [],
    videoTrashBin: [],
    pendingDeletionInfo: {},
    deletedCounts: { photos: 0, videos: 0 },
    lastDeletionResult: null,
    recentDecisions: [],
    organizingSessions: { photo: null, video: null },
    photoSessionRecoveryStatus: null,
    photoSessionUnavailableCount: 0,
    videoSessionRecoveryStatus: null,
    videoSessionUnavailableCount: 0,

    isLoading: false,
    photoLoadFailed: false,
    videoLoadFailed: false,
    isConfirmingDeletion: false,
    isConfirmingVideoTrash: false,
    hasPermission: false,
    permissionScope: null,
    permissionRefreshVersion: 0,
    mediaLibraryRefreshVersion: 0,
    hiddenPhotoQueuedAssetIds: null,
    hiddenVideoQueuedAssetIds: null,
    hasHydrated: false,

    setPermission: (status) => set({ hasPermission: status }),
    setPermissionScope: (scope) => set((state) => (
        state.permissionScope === scope ? state : { permissionScope: scope }
    )),
    notifyPermissionRefresh: () => set((state) => ({
        permissionRefreshVersion: state.permissionRefreshVersion + 1,
        mediaLibraryRefreshVersion: state.mediaLibraryRefreshVersion + 1,
    })),
    notifyMediaLibraryRefresh: () => set((state) => ({
        mediaLibraryRefreshVersion: state.mediaLibraryRefreshVersion + 1,
    })),
    refreshQueuedAssetVisibility: (scope, mediaType = 'photo') => {
        const requestId = mediaType === 'video'
            ? ++videoQueueVisibilityRequestId
            : ++photoQueueVisibilityRequestId;
        const queuedAssetIds = mediaType === 'video'
            ? Array.from(new Set(get().videoTrashBin.map(asset => asset.id)))
            : Array.from(new Set([
                ...get().deleteQueue,
                ...get().collectionQueue,
            ].map(asset => asset.id)));

        if (scope === 'full') {
            set(mediaType === 'video'
                ? { hiddenVideoQueuedAssetIds: null }
                : { hiddenPhotoQueuedAssetIds: null });
            return;
        }

        // Hide the current queue conservatively until every queued asset has
        // been checked under the new permission scope. Assets queued from the
        // current visible feed are not in this snapshot and remain actionable
        // for the current scope.
        set(mediaType === 'video'
            ? { hiddenVideoQueuedAssetIds: queuedAssetIds }
            : { hiddenPhotoQueuedAssetIds: queuedAssetIds });
        if (scope === 'none' || queuedAssetIds.length === 0) return;

        void getReadableMediaInfos(queuedAssetIds, mediaType, {
            shouldDownloadFromNetwork: false,
        }).then(readable => {
            const currentRequestId = mediaType === 'video'
                ? videoQueueVisibilityRequestId
                : photoQueueVisibilityRequestId;
            if (requestId !== currentRequestId) return;

            const hiddenIds = queuedAssetIds.filter(assetId => !readable.has(assetId));
            set(mediaType === 'video'
                ? { hiddenVideoQueuedAssetIds: hiddenIds }
                : { hiddenPhotoQueuedAssetIds: hiddenIds });
        });
    },
    setHasHydrated: (status) => set({ hasHydrated: status }),

    startOrganizingSession: (kind, scope, assetIds) => {
        const state = get();
        if (!state.hasHydrated || isRecordTransferActive() || state.isConfirmingDeletion || state.isConfirmingVideoTrash) return null;
        const now = Date.now();
        const session = createOrganizingSession(kind, scope, assetIds, `${kind}-${now}-${++organizingSessionSequence}`, now);
        set({ organizingSessions: { ...state.organizingSessions, [kind]: session },
            ...(kind === 'photo' ? { photoSessionRecoveryStatus: session.phase === 'complete' ? 'complete' as const : 'ready' as const,
                photoSessionUnavailableCount: 0 } : { videoSessionRecoveryStatus: session.phase === 'complete' ? 'complete' as const : 'ready' as const,
                videoSessionUnavailableCount: 0, videoCurrentIndex: 0 }) });
        return session;
    },
    deferSessionMedia: (kind, assetId) => {
        const state = get(), session = state.organizingSessions[kind];
        const visibleCurrent = kind === 'photo' ? state.photos.find(asset => !state.photoProcessedIds.includes(asset.id))?.id
            : state.videos[state.videoCurrentIndex]?.id;
        if (!state.hasHydrated || !session || session.phase !== 'organizing'
            || (session.assetIds[session.position] !== assetId && (visibleCurrent !== assetId
                || !(kind === 'photo' ? session.assetIds.slice(session.position) : session.assetIds).includes(assetId))) || isRecordTransferActive()
            || state.isConfirmingDeletion || state.isConfirmingVideoTrash
            || (kind === 'photo' ? state.photoProcessedIds : state.videoProcessedIds).includes(assetId)
            || getPendingDeletionEntries(state).some(entry => entry.asset.id === assetId)) return false;
        // A preceding member can be inaccessible after permission changes.
        // Deferring a readable later member must not abandon that earlier ID.
        const deferred = kind === 'photo' && session.assetIds[session.position] === assetId ? advanceOrganizingSession(session, assetId, 'skip')
            : { ...session, deferredIds: [...new Set([...session.deferredIds, assetId])], updatedAt: Math.max(session.startedAt, Date.now()) };
        const sessions = { ...state.organizingSessions, [kind]: deferred };
        const nextSessions = kind === 'photo' ? advancePhotoSession({ ...state, organizingSessions: sessions }, new Set(state.photoProcessedIds))
            : advanceVideoSession({ ...state, organizingSessions: sessions }, new Set(state.videoProcessedIds));
        const videos = state.videos.filter(asset => asset.id !== assetId);
        set(withRecentDecision(state, { organizingSessions: nextSessions,
            ...(kind === 'photo' ? { photos: state.photos.filter(asset => asset.id !== assetId) }
                : { videos, videoCurrentIndex: currentVideoIndex(videos, nextSessions.video, state.videoCurrentIndex) }) }, kind, assetId));
        return true;
    },
    moveVideoSession: assetId => {
        const state = get(), session = state.organizingSessions.video;
        const position = session?.assetIds.indexOf(assetId) ?? -1;
        const index = state.videos.findIndex(asset => asset.id === assetId);
        if (!state.hasHydrated || !session || position < 0 || index < 0 || isRecordTransferActive()
            || state.isConfirmingDeletion || state.isConfirmingVideoTrash || session.deferredIds.includes(assetId)
            || state.videoTrashBin.some(asset => asset.id === assetId)) return false;
        if (session.position === position && state.videoCurrentIndex === index) return true;
        set({ organizingSessions: { ...state.organizingSessions, video: moveOrganizingSession(session, position) }, videoCurrentIndex: index });
        return true;
    },
    finishVideoSession: () => {
        const state = get(), session = state.organizingSessions.video;
        if (!state.hasHydrated || !session || isRecordTransferActive() || state.isConfirmingDeletion || state.isConfirmingVideoTrash
            || session.assetIds.some(id => !state.videoProcessedIds.includes(id) && !session.deferredIds.includes(id))) return false;
        if (session.phase === 'organizing') set({ organizingSessions: advanceVideoSession(state, new Set(state.videoProcessedIds)) });
        return true;
    },
    continueSessionBatch: (kind, assetIds) => {
        const state = get(), session = state.organizingSessions[kind];
        if (!state.hasHydrated || !session || session.phase === 'organizing' || isRecordTransferActive() || state.isConfirmingDeletion || state.isConfirmingVideoTrash) return false;
        set({ organizingSessions: { ...state.organizingSessions, [kind]: continueOrganizingSession(session, assetIds) } });
        return true;
    },
    revisitSessionDeferred: (kind, assetIds) => {
        const state = get(), session = state.organizingSessions[kind];
        if (!state.hasHydrated || !session || isRecordTransferActive() || state.isConfirmingDeletion || state.isConfirmingVideoTrash) return false;
        const next = revisitDeferredMedia(session, assetIds, Date.now(), new Set(kind === 'photo' ? state.photoProcessedIds : state.videoProcessedIds));
        if (next === session) return false;
        set({ organizingSessions: { ...state.organizingSessions, [kind]: next } });
        return true;
    },
    resumeOrganizingSession: async kind => {
        const initial = get(), session = initial.organizingSessions[kind];
        const empty = (status: SessionRecoveryResult['status']): SessionRecoveryResult => ({ status, assets: [], unavailableCount: 0, position: 0 });
        if (!initial.hasHydrated || isRecordTransferActive() || initial.isConfirmingDeletion || initial.isConfirmingVideoTrash) return empty('busy');
        if (!session) return empty('unavailable');
        const requestId = kind === 'photo' ? ++photoLoadRequestId : ++videoLoadRequestId;
        const generation = initial.mediaLibraryRefreshVersion, permissionGeneration = initial.permissionRefreshVersion;
        const current = () => get().organizingSessions[kind] === session
            && get().mediaLibraryRefreshVersion === generation && get().permissionRefreshVersion === permissionGeneration
            && (kind === 'photo' ? get().photoProcessedIds === initial.photoProcessedIds && get().deleteQueue === initial.deleteQueue
                : get().videoProcessedIds === initial.videoProcessedIds && get().videoTrashBin === initial.videoTrashBin)
            && requestId === (kind === 'photo' ? photoLoadRequestId : videoLoadRequestId);
        activeMediaLoads++;
        set({ isLoading: true, ...(kind === 'photo' ? { photos: [], photoLoadFailed: false, photoSessionRecoveryStatus: null, photoSessionUnavailableCount: 0 }
            : { videos: [], videoLoadFailed: false, videoSessionRecoveryStatus: null, videoSessionUnavailableCount: 0 }) });
        try {
            const result = await recoverOrganizingSession(session,
                new Set(kind === 'photo' ? initial.photoProcessedIds : initial.videoProcessedIds), current,
                new Set(getPendingDeletionEntries(initial).filter(entry => entry.type === kind).map(entry => entry.asset.id)));
            if (!current()) return empty('stale');
            if (kind === 'photo') set({ photoSessionRecoveryStatus: result.status, photoSessionUnavailableCount: result.unavailableCount });
            else set({ videoSessionRecoveryStatus: result.status, videoSessionUnavailableCount: result.unavailableCount, videoLoadFailed: result.status === 'failed' });
            if (result.status === 'ready' || result.status === 'review' || result.status === 'complete') {
                set(state => !current() ? state : kind === 'photo' ? { photos: result.assets, currentIndex: result.position, photoLoadFailed: false,
                    organizingSessions: advancePhotoSession(state, new Set([...state.photoProcessedIds, ...state.deleteQueue.map(asset => asset.id)])) }
                    : { videos: result.assets, videoCurrentIndex: result.position, videoLoadFailed: false });
            }
            return result;
        } finally {
            activeMediaLoads--;
            if (activeMediaLoads === 0) set({ isLoading: false });
        }
    },

    loadAlbums: async () => {
        const requestId = ++albumLoadRequestId;
        const selectedAlbumIdsAtStart = useSettingsStore.getState().selectedAlbumIds;
        try {
            if (!(await hasFullPhotoLibraryAccess())) {
                if (requestId === albumLoadRequestId) set({ albums: [] });
                return;
            }

            const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
            if (requestId !== albumLoadRequestId) return;

            set({ albums });

            const selectedAlbumIds = useSettingsStore.getState().selectedAlbumIds;
            const availableAlbumIds = new Set(albums.map(album => album.id));
            const validSelectedAlbumIds = selectedAlbumIds.filter(albumId => availableAlbumIds.has(albumId));
            // Do not turn an all-invalid non-empty selection into []: [] means
            // "all albums" everywhere else in the app and would widen the
            // user's scope after an external album deletion. Keep the stale
            // IDs until the user clears or replaces the filter.
            if (
                sameStringSet(selectedAlbumIds, selectedAlbumIdsAtStart)
                && validSelectedAlbumIds.length > 0
                && !sameStringSet(validSelectedAlbumIds, selectedAlbumIds)
            ) {
                useSettingsStore.getState().setSelectedAlbums(validSelectedAlbumIds);
            }
        } catch (e) {
            if (requestId === albumLoadRequestId) set({ albums: [] });
            console.error('[MediaStore] Failed to load albums.');
        }
    },

    createAlbum: async (name, asset) => {
        try {
            if (!(await hasFullPhotoLibraryAccess())) {
                throw new Error('Full photo-library access is required to manage albums on iOS');
            }

            // Collection actions should keep the asset in its original
            // albums. On Android, `false` moves it instead of copying it.
            await MediaLibrary.createAlbumAsync(name, asset, true);
            await get().loadAlbums();
        } catch (e) {
            console.error('[MediaStore] Failed to create album.');
            throw e;
        }
    },

    addAssetToAlbum: async (albumId, asset) => {
        try {
            if (!(await hasFullPhotoLibraryAccess())) {
                throw new Error('Full photo-library access is required to manage albums on iOS');
            }

            const added = await MediaLibrary.addAssetsToAlbumAsync([asset], albumId);
            if (!added) {
                throw new Error('Media library did not confirm adding the asset to the album');
            }
        } catch (e) {
            console.error('[MediaStore] Failed to add asset to album.');
            throw e;
        }
    },

    loadPhotos: async (count, displayOrder = 'random', albumIds: string[] = [], sessionMode, date) => {
        const initial = get(), initialSession = initial.organizingSessions.photo;
        if (!sessionMode && initialSession) {
            await get().resumeOrganizingSession('photo');
            return;
        }
        if (sessionMode && (!get().hasHydrated || isRecordTransferActive() || get().isConfirmingDeletion || get().isConfirmingVideoTrash)) return;
        if (sessionMode === 'continue') {
            if (!initialSession || initialSession.phase === 'organizing') return;
            displayOrder = initialSession.scope.order;
            albumIds = initialSession.scope.albumIds;
            date = initialSession.scope.date;
        }
        if (date !== undefined && !isMediaDateFilter(date)) { set({ photoLoadFailed: true }); return; }
        date = typeof date === 'object' ? { ...date } : date;
        albumIds = [...albumIds];
        const requestId = ++photoLoadRequestId;
        const isCurrent = () => requestId === photoLoadRequestId && get().mediaLibraryRefreshVersion === initial.mediaLibraryRefreshVersion
            && get().permissionRefreshVersion === initial.permissionRefreshVersion
            && (!sessionMode || (get().organizingSessions.photo === initialSession && !isRecordTransferActive()
                && !get().isConfirmingDeletion && !get().isConfirmingVideoTrash));
        activeMediaLoads++;
        // Do not keep showing a batch that belongs to a previous filter while
        // the current request is loading or if it fails. The old batch could
        // otherwise make out-of-scope media appear actionable.
        set({ isLoading: true, photos: [], currentIndex: 0, photoLoadFailed: false, photoSessionRecoveryStatus: null, photoSessionUnavailableCount: 0 });
        try {
            const { photoProcessedIds } = get();
            let sessionPermission: MediaLibrary.PermissionResponse | undefined;
            if (sessionMode) {
                const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
                sessionPermission = permission;
                if (!isCurrent()) return;
                if (!permission.granted) {
                    if (isCurrent()) set({ photoSessionRecoveryStatus: 'permission' });
                    return;
                }
                if (albumIds.length) {
                    if (Platform.OS === 'ios' && permission.accessPrivileges !== 'all') {
                        if (isCurrent()) set({ photoSessionRecoveryStatus: 'unavailable' });
                        return;
                    }
                    const availableAlbums = new Set((await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true })).map(album => album.id));
                    if (albumIds.some(id => !availableAlbums.has(id))) {
                        if (isCurrent()) set({ photoSessionRecoveryStatus: 'unavailable' });
                        return;
                    }
                }
            }

            // Determine sort order
            const sortBy: MediaLibrary.SortByValue[] = displayOrder === 'oldest'
                ? [[MediaLibrary.SortBy.creationTime, true]]
                : [[MediaLibrary.SortBy.creationTime, false]];

            const result = await loadAssetsForReview(
                'photo',
                sortBy,
                count,
                displayOrder,
                sessionMode === 'continue' ? [...photoProcessedIds, ...initialSession!.deferredIds] : photoProcessedIds,
                albumIds,
                date,
                isCurrent,
            );
            if (sessionPermission) {
                const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
                if (!permission.granted || permission.accessPrivileges !== sessionPermission.accessPrivileges) {
                    if (isCurrent()) set({ photoSessionRecoveryStatus: 'permission' });
                    return;
                }
                await assertAlbumsStillAvailable(albumIds);
            }

            // A newer request owns the visible list. Read processed IDs in
            // the same state update so a swipe/action that completes while
            // MediaLibrary is paging cannot put that asset back on screen.
            set((state) => {
                if (!isCurrent()) return state;

                const processed = new Set(state.photoProcessedIds);
                const deferred = new Set(sessionMode === 'continue' ? initialSession!.deferredIds : []);
                const photos = result.assets.filter(asset => !processed.has(asset.id) && !deferred.has(asset.id));
                const now = Date.now();
                const session = sessionMode === 'new' ? createOrganizingSession('photo', { albumIds, order: displayOrder, ...(date !== undefined ? { date } : {}) },
                    photos.map(asset => asset.id), `photo-${now}-${++organizingSessionSequence}`, now)
                    : sessionMode === 'continue' ? continueOrganizingSession(initialSession!, photos.map(asset => asset.id), now) : undefined;

                return {
                    photos,
                    currentIndex: 0,
                    ...(session ? { organizingSessions: { ...state.organizingSessions, photo: session },
                        photoSessionRecoveryStatus: session.phase === 'complete' ? 'complete' as const : 'ready' as const } : {}),
                    ...(albumIds.length === 0 && result.totalCount !== null
                        ? { totalPhotos: result.totalCount }
                        : {}),
                };
            });
        } catch (error) {
            console.error('Failed to load photos.');
            // Only the current request owns feedback, just as it owns the list.
            const permissionFailed = error instanceof MediaSizeReadError && error.reason === 'permission';
            set((state) => isCurrent() ? { photoLoadFailed: !permissionFailed,
                ...(permissionFailed ? { photoSessionRecoveryStatus: 'permission' as const } : {}) } : state);
        } finally {
            activeMediaLoads--;
            if (activeMediaLoads === 0) set({ isLoading: false });
        }
    },

    loadVideos: async (count, displayOrder = 'random', albumIds: string[] = [], sessionMode, date) => {
        if (!sessionMode && get().organizingSessions.video) {
            await get().resumeOrganizingSession('video');
            return;
        }
        if (!get().hasHydrated || isRecordTransferActive() || get().isConfirmingDeletion || get().isConfirmingVideoTrash) return;
        if (sessionMode === 'continue' && !get().finishVideoSession()) return;
        const initial = get(), initialSession = initial.organizingSessions.video;
        if (sessionMode === 'continue') {
            if (!initialSession) return;
            displayOrder = initialSession.scope.order;
            albumIds = initialSession.scope.albumIds;
            date = initialSession.scope.date;
        }
        if (date !== undefined && !isMediaDateFilter(date)) { set({ videoLoadFailed: true }); return; }
        date = typeof date === 'object' ? { ...date } : date;
        albumIds = [...albumIds];
        const requestId = ++videoLoadRequestId;
        const mediaGeneration = initial.mediaLibraryRefreshVersion, permissionGeneration = initial.permissionRefreshVersion;
        const isCurrent = () => requestId === videoLoadRequestId && get().organizingSessions.video === initialSession
            && get().mediaLibraryRefreshVersion === mediaGeneration && get().permissionRefreshVersion === permissionGeneration
            && !isRecordTransferActive() && !get().isConfirmingDeletion && !get().isConfirmingVideoTrash;
        activeMediaLoads++;
        // Do not keep showing a batch that belongs to a previous filter while
        // the current request is loading or if it fails. The old batch could
        // otherwise make out-of-scope media appear actionable.
        set({ isLoading: true, videos: [], videoCurrentIndex: 0, videoLoadFailed: false,
            videoSessionRecoveryStatus: null, videoSessionUnavailableCount: 0 });
        try {
            const permission = await MediaLibrary.getPermissionsAsync(false, ['video']);
            if (!permission.granted) {
                set((state) => isCurrent()
                    ? { videos: [], totalVideos: 0, videoSessionRecoveryStatus: 'permission' as const }
                    : state);
                return;
            }
            if (!isCurrent()) return;
            if (albumIds.length) {
                if (Platform.OS === 'ios' && permission.accessPrivileges !== 'all') {
                    if (isCurrent()) set({ videoSessionRecoveryStatus: 'unavailable' });
                    return;
                }
                const albums = new Set((await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true })).map(album => album.id));
                if (albumIds.some(id => !albums.has(id))) {
                    if (isCurrent()) set({ videoSessionRecoveryStatus: 'unavailable' });
                    return;
                }
            }

            const { videoProcessedIds } = get();

            const sortBy: MediaLibrary.SortByValue[] = displayOrder === 'oldest'
                ? [[MediaLibrary.SortBy.creationTime, true]]
                : [[MediaLibrary.SortBy.creationTime, false]];

            const result = await loadAssetsForReview(
                'video',
                sortBy,
                count,
                displayOrder,
                sessionMode === 'continue' ? [...videoProcessedIds, ...initialSession!.deferredIds] : videoProcessedIds,
                albumIds,
                date,
                isCurrent,
            );
            const latestPermission = await MediaLibrary.getPermissionsAsync(false, ['video']);
            if (!isCurrent()) return;
            if (!latestPermission.granted || latestPermission.accessPrivileges !== permission.accessPrivileges) {
                set({ videoSessionRecoveryStatus: 'permission' });
                return;
            }
            await assertAlbumsStillAvailable(albumIds);

            set((state) => {
                if (!isCurrent()) return state;

                const processed = new Set([...state.videoProcessedIds, ...state.videoTrashBin.map(asset => asset.id)]);
                const deferred = new Set(sessionMode === 'continue' ? initialSession!.deferredIds : []);
                const videos = result.assets.filter(asset => !processed.has(asset.id) && !deferred.has(asset.id));
                const now = Date.now();
                const session = sessionMode === 'continue' ? continueOrganizingSession(initialSession!, videos.map(asset => asset.id), now)
                    : createOrganizingSession('video', { albumIds, order: displayOrder, ...(date !== undefined ? { date } : {}) }, videos.map(asset => asset.id), `video-${now}-${++organizingSessionSequence}`, now);

                return {
                    videos, videoCurrentIndex: 0,
                    organizingSessions: { ...state.organizingSessions, video: session },
                    videoSessionRecoveryStatus: session.phase === 'complete' ? 'complete' as const : 'ready' as const,
                    ...(albumIds.length === 0 && result.totalCount !== null
                        ? { totalVideos: result.totalCount }
                        : {}),
                };
            });
        } catch (error) {
            console.error('Failed to load videos.');
            const permissionFailed = error instanceof MediaSizeReadError && error.reason === 'permission';
            set((state) => isCurrent() ? { videoLoadFailed: !permissionFailed,
                videoSessionRecoveryStatus: permissionFailed ? 'permission' as const : 'failed' as const } : state);
        } finally {
            activeMediaLoads--;
            if (activeMediaLoads === 0) set({ isLoading: false });
        }
    },

    enqueuePendingDeletion: (assets, source) => {
        if (isRecordTransferActive()) return 0;
        let added = 0;
        set(state => {
            if (!state.hasHydrated) return state;
            const alreadyQueued = new Set(getPendingDeletionEntries(state).map(entry => entry.asset.id));
            const deleteQueue = [...state.deleteQueue], videoTrashBin = [...state.videoTrashBin];
            const photoProcessed = new Set(state.photoProcessedIds), videoProcessed = new Set(state.videoProcessedIds);
            const pendingDeletionInfo = { ...state.pendingDeletionInfo };
            const newlyQueued = new Set<string>();
            for (const asset of assets) {
                if (!asset.id || (asset.mediaType !== 'photo' && asset.mediaType !== 'video') || alreadyQueued.has(asset.id)) continue;
                alreadyQueued.add(asset.id); newlyQueued.add(asset.id); added++;
                pendingDeletionInfo[asset.id] = { source, addedAt: Date.now() };
                if (asset.mediaType === 'video') { videoTrashBin.push(asset); videoProcessed.add(asset.id); }
                else { deleteQueue.push(asset); photoProcessed.add(asset.id); }
            }
            if (!added) return state;
            let clearedSessions = state.organizingSessions;
            for (const asset of [...deleteQueue, ...videoTrashBin]) if (newlyQueued.has(asset.id)) {
                clearedSessions = clearDeferredDecision(clearedSessions, asset.mediaType === 'video' ? 'video' : 'photo', asset.id);
            }
            const photoSessions = advancePhotoSession({ ...state, organizingSessions: clearedSessions }, photoProcessed);
            const sessions = advanceVideoSession({ ...state, organizingSessions: photoSessions }, videoProcessed);
            const videos = state.videos.filter(asset => !newlyQueued.has(asset.id));
            let next: Partial<MediaState> = { deleteQueue, videoTrashBin, pendingDeletionInfo, lastDeletionResult: null,
                organizingSessions: sessions,
                collectionQueue: state.collectionQueue.filter(asset => !newlyQueued.has(asset.id)),
                videos, videoCurrentIndex: currentVideoIndex(videos, sessions.video, state.videoCurrentIndex),
                photoProcessedIds: [...photoProcessed], videoProcessedIds: [...videoProcessed] };
            for (const asset of [...deleteQueue, ...videoTrashBin]) if (newlyQueued.has(asset.id)) {
                next = withRecentDecision(state, next, asset.mediaType === 'video' ? 'video' : 'photo', asset.id);
            }
            return next;
        });
        return added;
    },
    markForDeletion: asset => { get().enqueuePendingDeletion([asset], 'photos'); },

    markForCollection: (asset) => {
        set((state) => {
            if (!state.hasHydrated || isRecordTransferActive() || state.photoProcessedIds.includes(asset.id)) return state;
            const sessions = clearDeferredDecision(state.organizingSessions, 'photo', asset.id);
            return withRecentDecision(state, {
                collectionQueue: [...state.collectionQueue, asset],
                photoProcessedIds: [...state.photoProcessedIds, asset.id],
                organizingSessions: advancePhotoSession({ ...state, organizingSessions: sessions }, new Set([...state.photoProcessedIds, asset.id]))
            }, 'photo', asset.id);
        });
    },

    markAsSkipped: (asset) => {
        set(state => {
            if (!state.hasHydrated || isRecordTransferActive() || state.photoProcessedIds.includes(asset.id)) return state;
            const sessions = clearDeferredDecision(state.organizingSessions, 'photo', asset.id);
            return withRecentDecision(state, { photoProcessedIds: [...state.photoProcessedIds, asset.id],
                organizingSessions: advancePhotoSession({ ...state, organizingSessions: sessions }, new Set([...state.photoProcessedIds, asset.id])) }, 'photo', asset.id);
        });
    },

    keepPhotosFromSimilar: (assets) => {
        if (!assets.length || assets.some(asset => !asset?.id || asset.mediaType !== 'photo')) return false;
        const ids = new Set(assets.map(asset => asset.id));
        let accepted = false;
        set(state => {
            if (!state.hasHydrated || state.isConfirmingDeletion || state.isConfirmingVideoTrash
                || isRecordTransferActive() || usePrivacyStore.getState().failures.records) return state;
            accepted = true;
            const processed = new Set([...state.photoProcessedIds, ...ids]);
            const deleteQueue = state.deleteQueue.filter(asset => !ids.has(asset.id));
            let sessions = state.organizingSessions;
            for (const id of ids) sessions = clearDeferredDecision(sessions, 'photo', id);
            let next: Partial<MediaState> = {
                photoProcessedIds: [...processed], deleteQueue,
                pendingDeletionInfo: retainPendingDeletionInfo({ ...state, deleteQueue }),
                organizingSessions: advancePhotoSession({ ...state, organizingSessions: sessions }, processed),
                hiddenPhotoQueuedAssetIds: state.permissionScope === 'full' ? null
                    : retainHiddenQueuedAssetIds(state.hiddenPhotoQueuedAssetIds, [
                        ...deleteQueue.map(asset => asset.id), ...state.collectionQueue.map(asset => asset.id),
                    ]),
                lastDeletionResult: null,
            };
            // Keep existing collection choices; this action cancels deletion,
            // not collection. Each changed decision remains individually undoable.
            for (const id of ids) next = withRecentDecision(state, next, 'photo', id);
            return next;
        });
        return accepted;
    },

    keepPendingDeletion: (assetId) => get().keepAllPendingDeletion([assetId]) > 0,
    keepAllPendingDeletion: (assetIds) => {
        const requested = new Set(assetIds);
        if (requested.size === 0) return 0;
        let keptCount = 0;
        set((state) => {
            if (!state.hasHydrated || state.isConfirmingDeletion || state.isConfirmingVideoTrash || isRecordTransferActive()) return state;
            const matched = getPendingDeletionEntries(state).filter(item => requested.has(item.asset.id));
            if (matched.length === 0) return state;
            keptCount = matched.length;
            const matchedIds = new Set(matched.map(entry => entry.asset.id));
            const photoProcessed = new Set(state.photoProcessedIds);
            const videoProcessed = new Set(state.videoProcessedIds);
            let sessions = state.organizingSessions;
            for (const entry of matched) {
                sessions = clearDeferredDecision(sessions, entry.type, entry.asset.id);
                if (entry.type === 'photo') photoProcessed.add(entry.asset.id);
                else videoProcessed.add(entry.asset.id);
            }
            const deleteQueue = state.deleteQueue.filter(photo => !matchedIds.has(photo.id));
            const videoTrashBin = state.videoTrashBin.filter(video => !matchedIds.has(video.id));
            let next: Partial<MediaState> = {
                deleteQueue,
                videoTrashBin,
                organizingSessions: sessions,
                pendingDeletionInfo: retainPendingDeletionInfo({ ...state, deleteQueue, videoTrashBin }),
                lastDeletionResult: null,
                photoProcessedIds: photoProcessed.size === state.photoProcessedIds.length
                    ? state.photoProcessedIds
                    : [...photoProcessed],
                videoProcessedIds: videoProcessed.size === state.videoProcessedIds.length
                    ? state.videoProcessedIds
                    : [...videoProcessed],
                hiddenPhotoQueuedAssetIds: state.permissionScope === 'full'
                    ? null
                    : retainHiddenQueuedAssetIds(state.hiddenPhotoQueuedAssetIds, [
                        ...deleteQueue.map(photo => photo.id),
                        ...state.collectionQueue.map(photo => photo.id),
                    ]),
                hiddenVideoQueuedAssetIds: state.hiddenVideoQueuedAssetIds === null
                    ? null
                    : retainHiddenQueuedAssetIds(state.hiddenVideoQueuedAssetIds, videoTrashBin.map(asset => asset.id)),
            };
            for (const entry of matched) {
                next = withRecentDecision(state, next, entry.type, entry.asset.id);
            }
            return next;
        });
        return keptCount;
    },
    keepPhotoFromDeleteQueue: assetId => get().deleteQueue.some(asset => asset.id === assetId) && get().keepPendingDeletion(assetId),

    changeRecentDecision: async (eventId, action) => {
        const initial = get();
        const busy = () => !get().hasHydrated || isRecordTransferActive() || get().isConfirmingDeletion || get().isConfirmingVideoTrash
            || !!usePrivacyStore.getState().failures.records;
        if (busy()) return 'busy';
        const entry = initial.recentDecisions.find(item => item.eventId === eventId);
        if (!entry) return 'nothing';
        const latest = (state: MediaState) => state.recentDecisions.find(item => item.kind === entry.kind && item.assetId === entry.assetId) === entry;
        if (!latest(initial) || (action === 'undo' && !recentDecisionIsCurrent(initial, entry))) return 'stale';
        const request = ++recentDecisionRequest;
        const session = initial.organizingSessions[entry.kind];
        const current = () => request === recentDecisionRequest && !busy()
            && get().mediaLibraryRefreshVersion === initial.mediaLibraryRefreshVersion
            && get().permissionRefreshVersion === initial.permissionRefreshVersion
            && get().organizingSessions[entry.kind] === session && latest(get())
            && (action !== 'undo' || recentDecisionIsCurrent(get(), entry));
        const read = await readRecentDecisionMedia(entry.kind, [entry.assetId], current);
        if (!current()) return 'stale';
        if (read.status === 'stale') return 'stale';
        if (read.status === 'failed') return 'failed';
        if (read.status !== 'ready') return 'unavailable';
        const asset = read.assets.get(entry.assetId);
        if (!asset) return 'unavailable';
        const target: DecisionSnapshot = action === 'undo' ? entry.before
            : { processed: true, pending: action === 'pending' ? { source: 'unknown', addedAt: Date.now() } : null, collected: false, deferred: false };
        const actual = decisionSnapshot(get(), entry.kind, entry.assetId);
        if (action !== 'undo' && (action === 'pending' ? !!actual.pending : sameDecisionSnapshot(actual, target))) return 'unchanged';
        let applied = false;
        set(state => {
            if (!current()) return state;
            const next = applyDecisionSnapshot(state, entry, target, asset);
            applied = true;
            if (action === 'undo') return { ...next, recentDecisions: state.recentDecisions.filter(item => item.eventId !== eventId) };
            return withRecentDecision(state, next, entry.kind, entry.assetId);
        });
        if (applied) {
            try { await flushMediaProgress(); }
            catch { return 'failed'; } // Keep the unsaved inverse in memory behind the privacy gate.
        }
        return applied ? 'changed' : 'stale';
    },

    undoAction: (assetId) => {
        if (get().isConfirmingDeletion || isRecordTransferActive()) return;
        set((state) => {
            if (state.isConfirmingDeletion || isRecordTransferActive()) return state;
            const deleteQueue = state.deleteQueue.filter(p => p.id !== assetId);
            return {
                deleteQueue,
                collectionQueue: state.collectionQueue.filter(p => p.id !== assetId),
                pendingDeletionInfo: retainPendingDeletionInfo({ ...state, deleteQueue }),
                lastDeletionResult: null,
                recentDecisions: state.recentDecisions.filter(entry => entry.kind !== 'photo' || entry.assetId !== assetId),
                photoProcessedIds: state.photoProcessedIds.filter(id => id !== assetId),
            };
        });
    },

    markVideoForTrash: asset => { get().enqueuePendingDeletion([asset], 'videos'); },

    markVideoAsProcessed: (asset) => {
        set((state) => {
            if (!state.hasHydrated || isRecordTransferActive() || state.isConfirmingDeletion || state.isConfirmingVideoTrash
                || asset.mediaType !== 'video') return state;
            const processed = new Set([...state.videoProcessedIds, asset.id]);
            const sessions = clearDeferredDecision(state.organizingSessions, 'video', asset.id);
            return withRecentDecision(state, { videoProcessedIds: state.videoProcessedIds.includes(asset.id) ? state.videoProcessedIds : [...processed],
                organizingSessions: advanceVideoSession({ ...state, organizingSessions: sessions }, processed) }, 'video', asset.id);
        });
    },

    restoreFromTrash: (assetId) => {
        if (get().videoTrashBin.some(asset => asset.id === assetId)) get().keepPendingDeletion(assetId);
    },

    removeDeletedAssets: (assetIds) => {
        const deletedIds = new Set(assetIds);
        if (deletedIds.size === 0) return;

        set(state => removeDeletedState(state, deletedIds));
    },

    pruneUnavailableQueuedAssets: (scope, mediaType = 'photo') => {
        const requestId = mediaType === 'video'
            ? ++videoQueuePruneRequestId
            : ++photoQueuePruneRequestId;
        if (scope !== 'full') return;

        const queuedAssetIds = mediaType === 'video'
            ? Array.from(new Set(get().videoTrashBin.map(asset => asset.id)))
            : Array.from(new Set([
                ...get().deleteQueue,
                ...get().collectionQueue,
            ].map(asset => asset.id)));
        if (queuedAssetIds.length === 0) return;

        void inspectReadableMediaInfos(queuedAssetIds, mediaType, {
            shouldDownloadFromNetwork: false,
        }).then(({ unavailableIds }) => {
            const currentRequestId = mediaType === 'video'
                ? videoQueuePruneRequestId
                : photoQueuePruneRequestId;
            if (requestId !== currentRequestId) return;
            const idsToRemove = queuedAssetIds.filter(assetId => unavailableIds.has(assetId));
            if (idsToRemove.length > 0) {
                get().removeDeletedAssets(idsToRemove);
            }
        });
    },

    getVisibleProcessedCounts: async () => {
        const [visiblePhotoIds, visibleVideoIds] = await Promise.all([
            getVisibleAssetIds('photo'),
            getVisibleAssetIds('video'),
        ]);
        const state = get();

        return {
            photos: state.photoProcessedIds.filter(id => visiblePhotoIds.has(id)).length,
            videos: state.videoProcessedIds.filter(id => visibleVideoIds.has(id)).length,
        };
    },

    resetBatch: (assetIds) => {
        if (get().isConfirmingDeletion) return;
        // Invalidate a load that may still be paging before clearing the
        // current batch, otherwise its completion can repopulate this list.
        photoLoadRequestId++;
        const selectedIds = assetIds === undefined ? null : new Set(assetIds);
        set((state) => {
            if (state.isConfirmingDeletion) return state;
            if (selectedIds === null) {
                return {
                    photos: [],
                    currentIndex: 0,
                    deleteQueue: [],
                    collectionQueue: [],
                    hiddenPhotoQueuedAssetIds: state.permissionScope === 'full'
                        ? null
                        : retainHiddenQueuedAssetIds(
                            state.hiddenPhotoQueuedAssetIds,
                            [],
                        ),
                };
            }

            const deleteQueue = state.deleteQueue.filter(asset => !selectedIds.has(asset.id));
            const collectionQueue = state.collectionQueue.filter(asset => !selectedIds.has(asset.id));
            return {
                photos: [],
                currentIndex: 0,
                deleteQueue,
                collectionQueue,
                hiddenPhotoQueuedAssetIds: state.permissionScope === 'full'
                    ? null
                    : retainHiddenQueuedAssetIds(
                        state.hiddenPhotoQueuedAssetIds,
                        [
                            ...deleteQueue.map(asset => asset.id),
                            ...collectionQueue.map(asset => asset.id),
                        ],
                    ),
            };
        });
    },

    resetPhotoProgress: () => {
        if (get().isConfirmingDeletion || isRecordTransferActive()) return;
        photoLoadRequestId++;
        set((state) => state.isConfirmingDeletion || isRecordTransferActive()
            ? state
            : {
                photoProcessedIds: [],
                recentDecisions: state.recentDecisions.filter(entry => entry.kind !== 'photo'),
                organizingSessions: { ...state.organizingSessions, photo: null },
                photoSessionRecoveryStatus: null,
                photoSessionUnavailableCount: 0,
                currentIndex: 0,
                photos: [],
                deleteQueue: [],
                collectionQueue: [],
                pendingDeletionInfo: retainPendingDeletionInfo({ ...state, deleteQueue: [] }),
                lastDeletionResult: null,
                hiddenPhotoQueuedAssetIds: state.permissionScope === 'full'
                    ? null
                    : retainHiddenQueuedAssetIds(
                        state.hiddenPhotoQueuedAssetIds,
                        [],
                    ),
            });
    },

    resetVideoProgress: () => {
        if (get().isConfirmingVideoTrash || isRecordTransferActive()) return;
        videoLoadRequestId++;
        set((state) => state.isConfirmingVideoTrash || isRecordTransferActive()
            ? state
            : {
                videoProcessedIds: [],
                recentDecisions: state.recentDecisions.filter(entry => entry.kind !== 'video'),
                organizingSessions: { ...state.organizingSessions, video: null },
                videoSessionRecoveryStatus: null, videoSessionUnavailableCount: 0, videoCurrentIndex: 0,
                videos: [],
                videoTrashBin: [],
                pendingDeletionInfo: retainPendingDeletionInfo({ ...state, videoTrashBin: [] }),
                lastDeletionResult: null,
                hiddenVideoQueuedAssetIds: null,
            });
    },

    confirmPendingDeletion: async assetIds => {
        const requested = assetIds === undefined ? null : new Set(assetIds);
        const snapshot = getPendingDeletionEntries(get()).filter(entry => requested === null || requested.has(entry.asset.id));
        const requestedIds = snapshot.map(entry => entry.asset.id);
        if (isRecordTransferActive() || get().isConfirmingDeletion || get().isConfirmingVideoTrash) {
            return { status: 'busy', requestedIds, deletedIds: [], remainingIds: requestedIds, failureKind: null };
        }
        const deleted = new Set<string>();
        let failed: 'cancelled' | 'failed' | null = null;
        // One lock across photo/video requests prevents overlapping OS dialogs
        // and keeps changes to a decision frozen while it is being confirmed.
        set({ isConfirmingDeletion: true, isConfirmingVideoTrash: true, lastDeletionResult: null });
        const settle = async (assets: readonly PhotoAsset[], type: MediaType) => {
            const newAssets = assets.filter(asset => !deleted.has(asset.id));
            if (!newAssets.length) return;
            newAssets.forEach(asset => deleted.add(asset.id));
            set(state => ({ ...removeDeletedState(state, new Set(newAssets.map(asset => asset.id))), deletedCounts: {
                photos: (state.deletedCounts?.photos ?? 0) + (type === 'photo' ? newAssets.length : 0),
                videos: (state.deletedCounts?.videos ?? 0) + (type === 'video' ? newAssets.length : 0),
            } }));
            if (type === 'photo') {
                try { await AssetRepository.removeAssetsAndDerivedData(newAssets.map(asset => asset.id)); }
                catch { console.error('[PendingDeletion] Confirmed deletion index cleanup failed.'); }
            }
        };
        try {
            for (const type of ['photo', 'video'] as const) {
                const assets = snapshot.filter(entry => entry.type === type).map(entry => entry.asset);
                if (!assets.length) continue;
                const visible = await getCurrentlyVisibleQueuedAssets(assets, type);
                const stillQueued = new Set(getPendingDeletionEntries(get()).map(entry => entry.asset.id));
                const selected = visible.filter(asset => stillQueued.has(asset.id));
                try {
                    if (type === 'photo') {
                        const byId = new Map(selected.map(asset => [asset.id, asset]));
                        await deleteAssetsInBatches(selected.map(asset => asset.id), batch => settle(batch.map(id => byId.get(id)!), type));
                    } else await deleteAssetsInBatches(selected, batch => settle(batch, type));
                } catch (error) {
                    failed = getDeletionFailureKind(error);
                    if (failed === 'failed') {
                        const unresolved = selected.filter(asset => !deleted.has(asset.id));
                        await settle(await findGoneAfterFailedDeletion(unresolved, type), type);
                    }
                    break; // Never retry deletion or open another type's prompt after a refusal.
                }
            }
            const remainingIds = requestedIds.filter(id => !deleted.has(id));
            const status = remainingIds.length === 0 ? 'success'
                : deleted.size > 0 ? 'partial' : failed ?? 'unavailable';
            const result: PendingDeletionResult = { status, requestedIds, deletedIds: [...deleted], remainingIds, failureKind: failed };
            set({ lastDeletionResult: result });
            return result;
        } finally { set({ isConfirmingDeletion: false, isConfirmingVideoTrash: false }); }
    },
    confirmDeletion: async assetIds => {
        const result = await get().confirmPendingDeletion(assetIds ?? get().deleteQueue.map(asset => asset.id));
        if (result.status !== 'success' && result.failureKind) throw new PendingDeletionIncompleteError(result);
        return result.deletedIds;
    },
    confirmVideoTrash: async assetIds => {
        const result = await get().confirmPendingDeletion(assetIds ?? get().videoTrashBin.map(asset => asset.id));
        if (result.status !== 'success' && result.failureKind) throw new PendingDeletionIncompleteError(result);
        return result.deletedIds;
    },

    refreshTotalCounts: async () => {
        const requestId = ++totalCountsRequestId;
        try {
            // expo-media-library exposes a web permission shim, but asset
            // queries are native-only. Keep app startup quiet and preserve
            // the zero-count initial state on platforms without a media
            // library implementation.
            if (!(await MediaLibrary.isAvailableAsync())) {
                return;
            }

            const [photoResult, videoResult] = await Promise.allSettled([
                getVisibleTotalCount('photo'),
                getVisibleTotalCount('video'),
            ]);
            if (requestId !== totalCountsRequestId) return;

            const previousState = get();
            const totalPhotos = photoResult.status === 'fulfilled'
                ? photoResult.value
                : previousState.totalPhotos;
            const totalVideos = videoResult.status === 'fulfilled'
                ? videoResult.value
                : previousState.totalVideos;
            set({
                totalPhotos,
                totalVideos,
            });
            console.log(`[MediaStore] Refreshed counts: ${totalPhotos} photos, ${totalVideos} videos`);
        } catch (e) {
            console.error('[MediaStore] Failed to refresh total counts.');
        }
        },

    clearLoadedMedia: () => {
        // Invalidate in-flight requests so a result fetched under an older
        // permission scope cannot repopulate the feed after it is cleared.
        albumLoadRequestId++;
        photoLoadRequestId++;
        totalCountsRequestId++;
        videoLoadRequestId++;
        set({
            photos: [],
            videos: [],
            albums: [],
            currentIndex: 0,
            videoCurrentIndex: 0,
            totalPhotos: 0,
            totalVideos: 0,
        });
    },
        }),
        {
            name: 'photoapp-media-progress',
            storage: createJSONStorage(() => mediaProgressStorage),
            merge: mergeProtectedState,
            partialize: (state) => ({
                photoProcessedIds: state.photoProcessedIds,
                videoProcessedIds: state.videoProcessedIds,
                // Keep in-flight decisions recoverable. The processed ID
                // lists are updated immediately to hide items from the
                // current session, so dropping these queues on restart would
                // silently skip media that was never actually deleted.
                deleteQueue: state.deleteQueue,
                collectionQueue: state.collectionQueue,
                videoTrashBin: state.videoTrashBin,
                pendingDeletionInfo: retainPendingDeletionInfo(state),
                deletedCounts: state.deletedCounts,
                organizingSessions: state.organizingSessions,
                recentDecisions: state.recentDecisions,
            }),
            onRehydrateStorage: () => (state, error) => {
                if (error) { usePrivacyStore.getState().block('records', 'read'); return; }
                if (!state) return;
                markEncryptedStorageHydrated('records', 'photoapp-media-progress');
                state.setHasHydrated(true);
            },
        }
    )
);
