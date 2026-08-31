import * as MediaLibrary from 'expo-media-library';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AssetRepository } from '../database';
import { DisplayOrder } from './useSettingsStore';

export interface PhotoAsset extends MediaLibrary.Asset {
    // Add any custom properties if needed later
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

    confirmDeletion: () => Promise<void>;
    confirmVideoTrash: () => Promise<void>;

    refreshTotalCounts: () => Promise<void>;

    resetBatch: () => void;
    resetPhotoProgress: () => void;
    resetVideoProgress: () => void;
    setPermission: (status: boolean) => void;
    setHasHydrated: (status: boolean) => void;
}

type MediaType = 'photo' | 'video';

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
    const seenAssetIds = albumIds.length > 0 ? new Set<string>() : null;
    const selected: MediaLibrary.Asset[] = [];
    let eligibleCount = 0;
    let totalCount: number | null = null;

    const queryAlbums: Array<string | undefined> = albumIds.length > 0
        ? Array.from(new Set(albumIds))
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

            if (totalCount === null && albumIds.length === 0) {
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
            if (!result.hasNextPage || !nextCursor || nextCursor === after) {
                break;
            }
            after = nextCursor;
        }

        if (displayOrder !== 'random' && selected.length >= count) {
            break;
        }
    }

    return { assets: selected.slice(0, count), totalCount };
}

let activeMediaLoads = 0;
let photoLoadRequestId = 0;
let videoLoadRequestId = 0;

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
    hasHydrated: false,

    setPermission: (status) => set({ hasPermission: status }),
    setHasHydrated: (status) => set({ hasHydrated: status }),

    loadAlbums: async () => {
        try {
            const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
            set({ albums });
        } catch (e) {
            console.error("Failed to load albums", e);
        }
    },

    createAlbum: async (name, asset) => {
        try {
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
        set({ isLoading: true });
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
        set({ isLoading: true });
        try {
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

    resetBatch: () => {
        if (get().isConfirmingDeletion) return;
        // Invalidate a load that may still be paging before clearing the
        // current batch, otherwise its completion can repopulate this list.
        photoLoadRequestId++;
        set((state) => state.isConfirmingDeletion
            ? state
            : { photos: [], currentIndex: 0, deleteQueue: [], collectionQueue: [] });
    },

    resetPhotoProgress: () => {
        if (get().isConfirmingDeletion) return;
        photoLoadRequestId++;
        set((state) => state.isConfirmingDeletion
            ? state
            : { photoProcessedIds: [], photos: [], deleteQueue: [], collectionQueue: [] });
    },

    resetVideoProgress: () => {
        if (get().isConfirmingVideoTrash) return;
        videoLoadRequestId++;
        set((state) => state.isConfirmingVideoTrash
            ? state
            : { videoProcessedIds: [], videos: [], videoTrashBin: [] });
    },

    confirmDeletion: async () => {
        if (get().isConfirmingDeletion) return;
        const { deleteQueue } = get();
        if (deleteQueue.length === 0) return;

        set({ isConfirmingDeletion: true });
        try {
            // Batch delete all at once - system will show ONE permission dialog
            const ids = deleteQueue.map(a => a.id);
            const deleted = await MediaLibrary.deleteAssetsAsync(ids);
            if (!deleted) {
                throw new Error('Media library did not confirm photo deletion');
            }
            const deletedIds = new Set(ids);
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
            set((state) => ({
                deleteQueue: state.deleteQueue.filter(asset => !deletedIds.has(asset.id)),
                photoProcessedIds: state.photoProcessedIds.filter(id => !deletedIds.has(id)),
            }));
        } catch (e) {
            // Keep the queue so the user can retry after fixing permissions or
            // another temporary media-library failure.
            console.error("Batch deletion failed", e);
            throw e;
        } finally {
            set({ isConfirmingDeletion: false });
        }

    },

    confirmVideoTrash: async () => {
        if (get().isConfirmingVideoTrash) return;
        const { videoTrashBin } = get();
        if (videoTrashBin.length === 0) return;

        set({ isConfirmingVideoTrash: true });
        try {
            const deletedIds = new Set(videoTrashBin.map(video => video.id));
            const deleted = await MediaLibrary.deleteAssetsAsync(videoTrashBin);
            if (!deleted) {
                throw new Error('Media library did not confirm video deletion');
            }
            set((state) => ({
                videoTrashBin: state.videoTrashBin.filter(video => !deletedIds.has(video.id)),
                videoProcessedIds: state.videoProcessedIds.filter(id => !deletedIds.has(id)),
            }));
        } catch (e) {
            console.error("Video deletion failed", e);
            throw e;
        } finally {
            set({ isConfirmingVideoTrash: false });
        }
    },

    refreshTotalCounts: async () => {
        try {
            const photoResult = await MediaLibrary.getAssetsAsync({
                mediaType: 'photo',
                first: 1,
            });
            const videoResult = await MediaLibrary.getAssetsAsync({
                mediaType: 'video',
                first: 1,
            });
            set({
                totalPhotos: photoResult.totalCount,
                totalVideos: videoResult.totalCount,
            });
            console.log(`[MediaStore] Refreshed counts: ${photoResult.totalCount} photos, ${videoResult.totalCount} videos`);
        } catch (e) {
            console.error("Failed to refresh total counts", e);
        }
    }
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
            onRehydrateStorage: () => (state) => {
                state?.setHasHydrated(true);
            },
        }
    )
);
