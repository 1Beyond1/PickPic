import * as MediaLibrary from 'expo-media-library';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { AssetRepository } from '../database';
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
        console.warn('[MediaStore] Failed to verify album access:', error);
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
        console.warn(`[MediaStore] Failed to verify ${mediaType} asset visibility:`, error);
        return new Set();
    }

    if (!permission.granted) return new Set();

    const visible = await Promise.all(requestedIds.map(async assetId => {
        try {
            const info = await MediaLibrary.getAssetInfoAsync(assetId, {
                shouldDownloadFromNetwork: false,
            });
            return info?.id === assetId ? assetId : null;
        } catch {
            return null;
        }
    }));

    return new Set(visible.filter((assetId): assetId is string => assetId !== null));
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

    // Separated progress tracking
    photoProcessedIds: string[];
    videoProcessedIds: string[];

    totalPhotos: number;
    totalVideos: number;

    isLoading: boolean;
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
    loadAlbums: () => Promise<void>;
    createAlbum: (name: string, asset: PhotoAsset) => Promise<void>;
    addAssetToAlbum: (albumId: string, asset: PhotoAsset) => Promise<void>;

    loadPhotos: (count: number, displayOrder?: DisplayOrder, albumIds?: string[]) => Promise<void>;
    loadVideos: (count: number, displayOrder?: DisplayOrder, albumIds?: string[]) => Promise<void>;

    markForDeletion: (asset: PhotoAsset) => void;
    markForCollection: (asset: PhotoAsset) => void;
    markAsSkipped: (asset: PhotoAsset) => void;
    undoAction: (assetId: string) => void;

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
    sortBy: MediaLibrary.SortByValue[]
): Promise<void> {
    const result = await MediaLibrary.getAssetsAsync({
        mediaType,
        first: 100,
        sortBy,
        album: state.albumId,
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
    albumIds: readonly string[]
): Promise<MediaLibrary.Asset[]> {
    const states: OrderedAlbumPage[] = Array.from(new Set(albumIds)).map(albumId => ({
        albumId,
        assets: [],
        index: 0,
        hasNextPage: true,
        endCursor: '',
    }));

    await Promise.all(states.map(state => loadAlbumPage(state, mediaType, sortBy)));

    const selected: MediaLibrary.Asset[] = [];
    const seenAssetIds = new Set<string>();

    while (selected.length < count) {
        const candidates = (await Promise.all(states.map(async state => {
            while (true) {
                if (state.index < state.assets.length) {
                    const asset = state.assets[state.index];
                    if (processed.has(asset.id) || seenAssetIds.has(asset.id)) {
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
                await loadAlbumPage(state, mediaType, sortBy);
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
    displayOrder: DisplayOrder,
    processedIds: readonly string[],
    albumIds: readonly string[]
): Promise<{ assets: MediaLibrary.Asset[]; totalCount: number | null }> {
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
            normalizedAlbumIds
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
                ...(albumId ? { album: albumId } : {}),
                ...(after ? { after } : {}),
            });

            if (result.hasNextPage && (!result.endCursor || result.endCursor === after)) {
                throw new Error('Media library returned an invalid pagination cursor');
            }

            if (totalCount === null && normalizedAlbumIds.length === 0) {
                totalCount = result.totalCount;
            }

            for (const asset of result.assets) {
                if (seenAssetIds?.has(asset.id)) continue;
                seenAssetIds?.add(asset.id);
                if (processed.has(asset.id)) continue;

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

    isLoading: false,
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

        void Promise.all(queuedAssetIds.map(async assetId => {
            try {
                const info = await MediaLibrary.getAssetInfoAsync(assetId, {
                    shouldDownloadFromNetwork: false,
                });
                return info?.id === assetId ? null : assetId;
            } catch {
                return assetId;
            }
        })).then(hiddenAssetIds => {
            const currentRequestId = mediaType === 'video'
                ? videoQueueVisibilityRequestId
                : photoQueueVisibilityRequestId;
            if (requestId !== currentRequestId) return;

            const hiddenIds = hiddenAssetIds.filter((assetId): assetId is string => assetId !== null);
            set(mediaType === 'video'
                ? { hiddenVideoQueuedAssetIds: hiddenIds }
                : { hiddenPhotoQueuedAssetIds: hiddenIds });
        });
    },
    setHasHydrated: (status) => set({ hasHydrated: status }),

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
            console.error("Failed to load albums", e);
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
            console.error("Failed to create album", e);
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
            console.error("Failed to add asset to album", e);
            throw e;
        }
    },

    loadPhotos: async (count, displayOrder = 'random', albumIds: string[] = []) => {
        const requestId = ++photoLoadRequestId;
        activeMediaLoads++;
        // Do not keep showing a batch that belongs to a previous filter while
        // the current request is loading or if it fails. The old batch could
        // otherwise make out-of-scope media appear actionable.
        set({ isLoading: true, photos: [], currentIndex: 0 });
        try {
            const { photoProcessedIds } = get();

            // Determine sort order
            const sortBy: MediaLibrary.SortByValue[] = displayOrder === 'oldest'
                ? [[MediaLibrary.SortBy.creationTime, true]]
                : [[MediaLibrary.SortBy.creationTime, false]];

            const result = await loadAssetsForReview(
                'photo',
                sortBy,
                count,
                displayOrder,
                photoProcessedIds,
                albumIds
            );

            // A newer request owns the visible list. Read processed IDs in
            // the same state update so a swipe/action that completes while
            // MediaLibrary is paging cannot put that asset back on screen.
            set((state) => {
                if (requestId !== photoLoadRequestId) return state;

                const processed = new Set(state.photoProcessedIds);
                const photos = result.assets.filter(asset => !processed.has(asset.id));

                return {
                    photos,
                    currentIndex: 0,
                    ...(albumIds.length === 0 && result.totalCount !== null
                        ? { totalPhotos: result.totalCount }
                        : {}),
                };
            });
        } catch (error) {
            console.error("Failed to load photos", error);
        } finally {
            activeMediaLoads--;
            if (activeMediaLoads === 0) set({ isLoading: false });
        }
    },

    loadVideos: async (count, displayOrder = 'random', albumIds: string[] = []) => {
        const requestId = ++videoLoadRequestId;
        activeMediaLoads++;
        // Do not keep showing a batch that belongs to a previous filter while
        // the current request is loading or if it fails. The old batch could
        // otherwise make out-of-scope media appear actionable.
        set({ isLoading: true, videos: [] });
        try {
            const permission = await MediaLibrary.getPermissionsAsync(false, ['video']);
            if (!permission.granted) {
                set((state) => requestId === videoLoadRequestId
                    ? { videos: [], totalVideos: 0 }
                    : state);
                return;
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
                videoProcessedIds,
                albumIds
            );

            set((state) => {
                if (requestId !== videoLoadRequestId) return state;

                const processed = new Set(state.videoProcessedIds);
                const videos = result.assets.filter(asset => !processed.has(asset.id));

                return {
                    videos,
                    ...(albumIds.length === 0 && result.totalCount !== null
                        ? { totalVideos: result.totalCount }
                        : {}),
                };
            });
        } catch (error) {
            console.error("Failed to load videos", error);
        } finally {
            activeMediaLoads--;
            if (activeMediaLoads === 0) set({ isLoading: false });
        }
    },

    markForDeletion: (asset) => {
        set((state) => {
            if (state.photoProcessedIds.includes(asset.id)) return state;
            return {
                deleteQueue: [...state.deleteQueue, asset],
                photoProcessedIds: [...state.photoProcessedIds, asset.id]
            };
        });
    },

    markForCollection: (asset) => {
        set((state) => {
            if (state.photoProcessedIds.includes(asset.id)) return state;
            return {
                collectionQueue: [...state.collectionQueue, asset],
                photoProcessedIds: [...state.photoProcessedIds, asset.id]
            };
        });
    },

    markAsSkipped: (asset) => {
        set((state) => state.photoProcessedIds.includes(asset.id)
            ? state
            : { photoProcessedIds: [...state.photoProcessedIds, asset.id] });
    },

    undoAction: (assetId) => {
        set((state) => state.isConfirmingDeletion
            ? state
            : {
                deleteQueue: state.deleteQueue.filter(p => p.id !== assetId),
                collectionQueue: state.collectionQueue.filter(p => p.id !== assetId),
                photoProcessedIds: state.photoProcessedIds.filter(id => id !== assetId)
            });
    },

    markVideoForTrash: (asset) => {
        set((state) => {
            if (state.videoTrashBin.some(video => video.id === asset.id)) return state;
            return {
                videos: state.videos.filter(v => v.id !== asset.id),
                videoTrashBin: [...state.videoTrashBin, asset],
                videoProcessedIds: state.videoProcessedIds.includes(asset.id)
                    ? state.videoProcessedIds
                    : [...state.videoProcessedIds, asset.id]
            };
        });
    },

    markVideoAsProcessed: (asset) => {
        set((state) => state.videoProcessedIds.includes(asset.id)
            ? state
            : { videoProcessedIds: [...state.videoProcessedIds, asset.id] });
    },

    restoreFromTrash: (assetId) => {
        const trash = get().videoTrashBin;
        const asset = trash.find(v => v.id === assetId);
        if (asset) {
            set((state) => state.isConfirmingVideoTrash
                ? state
                : {
                    videoTrashBin: state.videoTrashBin.filter(v => v.id !== assetId),
                    videos: [asset, ...state.videos],
                    videoProcessedIds: state.videoProcessedIds.filter(id => id !== assetId)
            });
        }
    },

    removeDeletedAssets: (assetIds) => {
        const deletedIds = new Set(assetIds);
        if (deletedIds.size === 0) return;

        set((state) => ({
            deleteQueue: state.deleteQueue.filter(asset => !deletedIds.has(asset.id)),
            collectionQueue: state.collectionQueue.filter(asset => !deletedIds.has(asset.id)),
            videoTrashBin: state.videoTrashBin.filter(asset => !deletedIds.has(asset.id)),
            photoProcessedIds: state.photoProcessedIds.filter(id => !deletedIds.has(id)),
            videoProcessedIds: state.videoProcessedIds.filter(id => !deletedIds.has(id)),
            hiddenPhotoQueuedAssetIds: state.hiddenPhotoQueuedAssetIds?.filter(id => !deletedIds.has(id)) ?? null,
            hiddenVideoQueuedAssetIds: state.hiddenVideoQueuedAssetIds?.filter(id => !deletedIds.has(id)) ?? null,
        }));
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

        void Promise.all(queuedAssetIds.map(async assetId => {
            try {
                const info = await MediaLibrary.getAssetInfoAsync(assetId, {
                    shouldDownloadFromNetwork: false,
                });
                return info?.id === assetId ? null : assetId;
            } catch {
                // A transient native lookup failure must not discard a queue
                // item that may still be recoverable.
                return null;
            }
        })).then(unavailableAssetIds => {
            const currentRequestId = mediaType === 'video'
                ? videoQueuePruneRequestId
                : photoQueuePruneRequestId;
            if (requestId !== currentRequestId) return;
            const idsToRemove = unavailableAssetIds.filter((assetId): assetId is string => assetId !== null);
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
        if (get().isConfirmingDeletion) return;
        photoLoadRequestId++;
        set((state) => state.isConfirmingDeletion
            ? state
            : {
                photoProcessedIds: [],
                photos: [],
                deleteQueue: [],
                collectionQueue: [],
                hiddenPhotoQueuedAssetIds: state.permissionScope === 'full'
                    ? null
                    : retainHiddenQueuedAssetIds(
                        state.hiddenPhotoQueuedAssetIds,
                        [],
                    ),
            });
    },

    resetVideoProgress: () => {
        if (get().isConfirmingVideoTrash) return;
        videoLoadRequestId++;
        set((state) => state.isConfirmingVideoTrash
            ? state
            : {
                videoProcessedIds: [],
                videos: [],
                videoTrashBin: [],
                hiddenVideoQueuedAssetIds: null,
            });
    },

    confirmDeletion: async (assetIds) => {
        if (get().isConfirmingDeletion) return [];
        const requestedIds = assetIds === undefined ? null : new Set(assetIds);
        if (requestedIds?.size === 0) return [];
        set({ isConfirmingDeletion: true });
        try {
            const state = get();
            const queueToVerify = requestedIds === null
                ? state.deleteQueue
                : state.deleteQueue.filter(asset => requestedIds.has(asset.id));
            const visibleDeleteQueue = await getCurrentlyVisibleQueuedAssets(queueToVerify, 'photo');
            const verifiedIds = new Set(visibleDeleteQueue.map(asset => asset.id));
            // The queue can change while native visibility checks are in
            // flight. Re-read it before selecting so an undo/removal wins
            // over this confirmation, while newly-added entries are not
            // deleted without having gone through the preflight.
            const currentDeleteQueue = get().deleteQueue;
            const selectedDeleteQueue = currentDeleteQueue.filter(asset => (
                verifiedIds.has(asset.id)
                && (requestedIds === null || requestedIds.has(asset.id))
            ));
            const ids = Array.from(new Set(selectedDeleteQueue.map(asset => asset.id)));
            if (ids.length === 0) return [];

            // Batch delete all at once - system will show ONE permission dialog
            const deleted = await MediaLibrary.deleteAssetsAsync(ids);
            if (!deleted) {
                throw new Error('Media library did not confirm photo deletion');
            }
            for (const id of ids) {
                try {
                    await AssetRepository.removeAssetAndDerivedData(id);
                } catch (cleanupError) {
                    // The media is already deleted; a later scanner sync can
                    // repair the local index if this best-effort cleanup fails.
                    console.error("Failed to clean deleted photo from scan index", cleanupError);
                }
            }
            console.log(`Batch deletion: ${ids.length} items deleted`);

            // Deleted media no longer needs review progress. Removing its IDs
            // keeps the progress count meaningful and prevents the persisted
            // list from growing forever as the user cleans up their library.
            get().removeDeletedAssets(ids);
            return ids;
        } catch (e) {
            // Keep the queue so the user can retry after fixing permissions or
            // another temporary media-library failure.
            console.error("Batch deletion failed", e);
            throw e;
        } finally {
            set({ isConfirmingDeletion: false });
        }

    },

    confirmVideoTrash: async (assetIds) => {
        if (get().isConfirmingVideoTrash) return [];
        const requestedIds = assetIds === undefined ? null : new Set(assetIds);
        if (requestedIds?.size === 0) return [];
        set({ isConfirmingVideoTrash: true });
        try {
            const state = get();
            const queueToVerify = requestedIds === null
                ? state.videoTrashBin
                : state.videoTrashBin.filter(video => requestedIds.has(video.id));
            const visibleVideoTrashBin = await getCurrentlyVisibleQueuedAssets(queueToVerify, 'video');
            const verifiedIds = new Set(visibleVideoTrashBin.map(video => video.id));
            const currentVideoTrashBin = get().videoTrashBin;
            const selectedVideoTrashBin = currentVideoTrashBin.filter(video => (
                verifiedIds.has(video.id)
                && (requestedIds === null || requestedIds.has(video.id))
            ));
            const deletedIds = new Set(selectedVideoTrashBin.map(video => video.id));
            if (deletedIds.size === 0) return [];

            const deleted = await MediaLibrary.deleteAssetsAsync(selectedVideoTrashBin);
            if (!deleted) {
                throw new Error('Media library did not confirm video deletion');
            }
            get().removeDeletedAssets(Array.from(deletedIds));
            return Array.from(deletedIds);
        } catch (e) {
            console.error("Video deletion failed", e);
            throw e;
        } finally {
            set({ isConfirmingVideoTrash: false });
        }
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
            console.error("Failed to refresh total counts", e);
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
            storage: createJSONStorage(() => AsyncStorage),
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
            }),
            onRehydrateStorage: () => (state, error) => {
                // A storage read error must not leave the media screens behind
                // their hydration gate forever; continue with default queues.
                if (error && typeof window !== 'undefined') {
                    console.error('[MediaStore] Failed to rehydrate progress:', error);
                }
                // AsyncStorage's web adapter cannot access window during Expo's
                // server-side/static render. Avoid a persisted write there.
                if (!state && typeof window === 'undefined') return;
                (state ?? useMediaStore.getState()).setHasHydrated(true);
            },
        }
    )
);
