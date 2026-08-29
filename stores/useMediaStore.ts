import * as MediaLibrary from 'expo-media-library';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
 * Load every page for a media query. The old implementation only requested
 * the first page, which silently hid assets in larger libraries.
 */
async function loadAllAssets(
    mediaType: MediaType,
    sortBy: MediaLibrary.SortByValue[],
    albumId?: string
): Promise<MediaLibrary.Asset[]> {
    const assets: MediaLibrary.Asset[] = [];
    let after: string | undefined;

    while (true) {
        const result = await MediaLibrary.getAssetsAsync({
            mediaType,
            first: 100,
            sortBy,
            ...(albumId ? { album: albumId } : {}),
            ...(after ? { after } : {}),
        });

        assets.push(...result.assets);

        if (!result.hasNextPage || !result.endCursor || result.endCursor === after) {
            break;
        }

        after = result.endCursor;
    }

    return assets;
}

function deduplicateAssets(assets: MediaLibrary.Asset[]): MediaLibrary.Asset[] {
    return Array.from(new Map(assets.map(asset => [asset.id, asset])).values());
}

// Fisher-Yates shuffle algorithm
function shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

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
            await MediaLibrary.createAlbumAsync(name, asset, false);
            await get().loadAlbums();
        } catch (e) {
            console.error("Failed to create album", e);
            throw e;
        }
    },

    addAssetToAlbum: async (albumId, asset) => {
        try {
            await MediaLibrary.addAssetsToAlbumAsync([asset], albumId);
        } catch (e) {
            console.error("Failed to add asset to album", e);
            throw e;
        }
    },

    loadPhotos: async (count, displayOrder = 'random', albumIds: string[] = []) => {
        set({ isLoading: true });
        try {
            const { photoProcessedIds } = get();
            let allAssets: MediaLibrary.Asset[] = [];

            // Determine sort order
            const sortBy: MediaLibrary.SortByValue[] = displayOrder === 'oldest'
                ? [[MediaLibrary.SortBy.creationTime, true]]
                : [[MediaLibrary.SortBy.creationTime, false]];

            if (albumIds.length > 0) {
                // Load from specific albums
                for (const albumId of albumIds) {
                    allAssets.push(...await loadAllAssets('photo', sortBy, albumId));
                }
            } else {
                // Load from all albums
                allAssets = await loadAllAssets('photo', sortBy);
            }

            allAssets = deduplicateAssets(allAssets);
            if (albumIds.length === 0) {
                set({ totalPhotos: allAssets.length });
            }

            let filtered = allAssets.filter(a => !photoProcessedIds.includes(a.id));

            if (displayOrder === 'random') {
                filtered = shuffleArray(filtered);
            }

            const newPhotos = filtered.slice(0, count);
            set({ photos: newPhotos, currentIndex: 0, deleteQueue: [], collectionQueue: [] });
        } catch (error) {
            console.error("Failed to load photos", error);
        } finally {
            set({ isLoading: false });
        }
    },

    loadVideos: async (count, displayOrder = 'random', albumIds: string[] = []) => {
        set({ isLoading: true });
        try {
            const { videoProcessedIds } = get();
            let allAssets: MediaLibrary.Asset[] = [];

            const sortBy: MediaLibrary.SortByValue[] = displayOrder === 'oldest'
                ? [[MediaLibrary.SortBy.creationTime, true]]
                : [[MediaLibrary.SortBy.creationTime, false]];

            if (albumIds.length > 0) {
                for (const albumId of albumIds) {
                    allAssets.push(...await loadAllAssets('video', sortBy, albumId));
                }
            } else {
                allAssets = await loadAllAssets('video', sortBy);
            }

            allAssets = deduplicateAssets(allAssets);
            if (albumIds.length === 0) {
                set({ totalVideos: allAssets.length });
            }

            let filtered = allAssets.filter(a => !videoProcessedIds.includes(a.id));

            if (displayOrder === 'random') {
                filtered = shuffleArray(filtered);
            }

            set({ videos: filtered.slice(0, count) });
        } catch (error) {
            console.error("Failed to load videos", error);
        } finally {
            set({ isLoading: false });
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
        set((state) => ({
            deleteQueue: state.deleteQueue.filter(p => p.id !== assetId),
            collectionQueue: state.collectionQueue.filter(p => p.id !== assetId),
            photoProcessedIds: state.photoProcessedIds.filter(id => id !== assetId)
        }));
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
            set((state) => ({
                videoTrashBin: state.videoTrashBin.filter(v => v.id !== assetId),
                videos: [asset, ...state.videos],
                videoProcessedIds: state.videoProcessedIds.filter(id => id !== assetId)
            }));
        }
    },

    resetBatch: () => {
        set({ photos: [], currentIndex: 0, deleteQueue: [], collectionQueue: [] });
    },

    resetPhotoProgress: () => {
        set({ photoProcessedIds: [], photos: [], deleteQueue: [], collectionQueue: [] });
    },

    resetVideoProgress: () => {
        set({ videoProcessedIds: [], videos: [], videoTrashBin: [] });
    },

    confirmDeletion: async () => {
        const { deleteQueue } = get();
        if (deleteQueue.length === 0) return;

        try {
            // Batch delete all at once - system will show ONE permission dialog
            const ids = deleteQueue.map(a => a.id);
            await MediaLibrary.deleteAssetsAsync(ids);
            console.log(`Batch deletion: ${ids.length} items deleted`);
        } catch (e) {
            // Keep the queue so the user can retry after fixing permissions or
            // another temporary media-library failure.
            console.error("Batch deletion failed", e);
            throw e;
        }

        set({ deleteQueue: [] });
    },

    confirmVideoTrash: async () => {
        const { videoTrashBin } = get();
        if (videoTrashBin.length === 0) return;
        try {
            await MediaLibrary.deleteAssetsAsync(videoTrashBin);
            set({ videoTrashBin: [] });
        } catch (e) {
            console.error("Video deletion failed", e);
            throw e;
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
            }),
            onRehydrateStorage: () => (state) => {
                state?.setHasHydrated(true);
            },
        }
    )
);
