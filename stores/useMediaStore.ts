import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { create } from 'zustand';

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

    // Actions
    loadAlbums: () => Promise<void>;
    createAlbum: (name: string, asset: PhotoAsset) => Promise<void>;
    addAssetToAlbum: (albumId: string, asset: PhotoAsset) => Promise<void>;

    loadPhotos: (count: number, randomize?: boolean) => Promise<void>;
    loadVideos: (count: number, randomize?: boolean) => Promise<void>;

    markForDeletion: (asset: PhotoAsset) => void;
    markForCollection: (asset: PhotoAsset) => void;
    markAsSkipped: (asset: PhotoAsset) => void;
    undoAction: (assetId: string) => void;

    markVideoForTrash: (asset: PhotoAsset) => void;
    markVideoAsProcessed: (asset: PhotoAsset) => void;
    restoreFromTrash: (assetId: string) => void;

    confirmDeletion: () => Promise<void>;
    confirmVideoTrash: () => Promise<void>;

    resetBatch: () => void;
    resetPhotoProgress: () => void;
    resetVideoProgress: () => void;
    setPermission: (status: boolean) => void;
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

export const useMediaStore = create<MediaState>((set, get) => ({
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

    setPermission: (status) => set({ hasPermission: status }),

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
            get().loadAlbums();
        } catch (e) {
            console.error("Failed to create album", e);
        }
    },

    addAssetToAlbum: async (albumId, asset) => {
        try {
            await MediaLibrary.addAssetsToAlbumAsync([asset], albumId);
            const { photoProcessedIds } = get();
            set({ photoProcessedIds: [...photoProcessedIds, asset.id] });
            await MediaLibrary.deleteAssetsAsync([asset]);
        } catch (e) {
            console.error("Failed to add to album (and delete original)", e);
        }
    },

    loadPhotos: async (count, randomize = false) => {
        set({ isLoading: true });
        try {
            const result = await MediaLibrary.getAssetsAsync({
                mediaType: 'photo',
                first: 500,
                sortBy: ['creationTime'],
            });

            const { photoProcessedIds } = get();
            set({ totalPhotos: result.totalCount });

            let filtered = result.assets.filter(a => !photoProcessedIds.includes(a.id));

            if (randomize) {
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

    loadVideos: async (count, randomize = false) => {
        set({ isLoading: true });
        try {
            const result = await MediaLibrary.getAssetsAsync({
                mediaType: 'video',
                first: 200,
                sortBy: ['creationTime'],
            });

            const { videoProcessedIds } = get();
            set({ totalVideos: result.totalCount });

            let filtered = result.assets.filter(a => !videoProcessedIds.includes(a.id));

            if (randomize) {
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
        set((state) => ({
            deleteQueue: [...state.deleteQueue, asset],
            photoProcessedIds: [...state.photoProcessedIds, asset.id]
        }));
    },

    markForCollection: (asset) => {
        set((state) => ({
            collectionQueue: [...state.collectionQueue, asset],
            photoProcessedIds: [...state.photoProcessedIds, asset.id]
        }));
    },

    markAsSkipped: (asset) => {
        set((state) => ({
            photoProcessedIds: [...state.photoProcessedIds, asset.id]
        }));
    },

    undoAction: (assetId) => {
        set((state) => ({
            deleteQueue: state.deleteQueue.filter(p => p.id !== assetId),
            collectionQueue: state.collectionQueue.filter(p => p.id !== assetId),
            photoProcessedIds: state.photoProcessedIds.filter(id => id !== assetId)
        }));
    },

    markVideoForTrash: (asset) => {
        set((state) => ({
            videos: state.videos.filter(v => v.id !== asset.id),
            videoTrashBin: [...state.videoTrashBin, asset],
            videoProcessedIds: [...state.videoProcessedIds, asset.id]
        }));
    },

    markVideoAsProcessed: (asset) => {
        set((state) => ({
            videoProcessedIds: [...state.videoProcessedIds, asset.id]
        }));
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

        let successCount = 0;
        let failCount = 0;

        for (const asset of deleteQueue) {
            try {
                const mlResult = await MediaLibrary.deleteAssetsAsync([asset.id]);

                try {
                    const check = await MediaLibrary.getAssetInfoAsync(asset.id);
                    if (check) {
                        const fileUri = check.localUri || check.uri;
                        if (fileUri && fileUri.startsWith('file://')) {
                            try {
                                await FileSystem.deleteAsync(fileUri, { idempotent: true });
                                const check2 = await MediaLibrary.getAssetInfoAsync(asset.id);
                                if (!check2) successCount++;
                                else failCount++;
                            } catch {
                                failCount++;
                            }
                        } else {
                            failCount++;
                        }
                    } else {
                        successCount++;
                    }
                } catch {
                    successCount++;
                }
            } catch {
                failCount++;
            }
        }

        console.log(`Deletion: ${successCount} success, ${failCount} failed`);
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
        }
    }
}));
