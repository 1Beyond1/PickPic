import { LocalPrivacyError } from '../../stores/usePrivacyStore';
import type { PhotoAsset } from '../../stores/useMediaStore';

export type ProcessedMediaType = 'photo' | 'video';
export type PendingQueueType = 'photo_delete' | 'video_trash';

export interface MediaProgressCollections {
    photoProcessedIds: string[];
    videoProcessedIds: string[];
    deleteQueue: PhotoAsset[];
    videoTrashBin: PhotoAsset[];
}

export function emptyMediaProgressCollections(): MediaProgressCollections {
    return {
        photoProcessedIds: [],
        videoProcessedIds: [],
        deleteQueue: [],
        videoTrashBin: [],
    };
}

export function dedupeMediaIds(ids: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of ids) {
        if (typeof id !== 'string' || id.length === 0) throw new LocalPrivacyError();
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

export function dedupeMediaAssets(assets: readonly PhotoAsset[]): PhotoAsset[] {
    const seen = new Set<string>();
    const result: PhotoAsset[] = [];
    for (const asset of assets) {
        if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string' || asset.id.length === 0) {
            throw new LocalPrivacyError();
        }
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        result.push(asset);
    }
    return result;
}

export function normalizeMediaProgressCollections(
    input: Partial<MediaProgressCollections>
): MediaProgressCollections {
    return {
        photoProcessedIds: dedupeMediaIds(input.photoProcessedIds ?? []),
        videoProcessedIds: dedupeMediaIds(input.videoProcessedIds ?? []),
        deleteQueue: dedupeMediaAssets(input.deleteQueue ?? []),
        videoTrashBin: dedupeMediaAssets(input.videoTrashBin ?? []),
    };
}

export function mediaProgressCollectionsEqual(
    left: MediaProgressCollections,
    right: MediaProgressCollections
): boolean {
    if (
        left.photoProcessedIds.length !== right.photoProcessedIds.length
        || left.videoProcessedIds.length !== right.videoProcessedIds.length
        || left.deleteQueue.length !== right.deleteQueue.length
        || left.videoTrashBin.length !== right.videoTrashBin.length
    ) {
        return false;
    }

    for (let i = 0; i < left.photoProcessedIds.length; i++) {
        if (left.photoProcessedIds[i] !== right.photoProcessedIds[i]) return false;
    }
    for (let i = 0; i < left.videoProcessedIds.length; i++) {
        if (left.videoProcessedIds[i] !== right.videoProcessedIds[i]) return false;
    }
    for (let i = 0; i < left.deleteQueue.length; i++) {
        if (JSON.stringify(left.deleteQueue[i]) !== JSON.stringify(right.deleteQueue[i])) return false;
    }
    for (let i = 0; i < left.videoTrashBin.length; i++) {
        if (JSON.stringify(left.videoTrashBin[i]) !== JSON.stringify(right.videoTrashBin[i])) return false;
    }
    return true;
}
