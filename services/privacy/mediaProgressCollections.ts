import { LocalPrivacyError } from '../../stores/usePrivacyStore';
import type { PhotoAsset } from '../../stores/useMediaStore';
import type { PendingDeletionInfo, PendingDeletionSource } from '../pendingDeletion';

export type ProcessedMediaType = 'photo' | 'video';
export type PendingQueueType = 'photo_delete' | 'video_trash' | 'collection';

export const VALID_PENDING_DELETION_SOURCES: ReadonlySet<PendingDeletionSource> = new Set([
    'photos',
    'videos',
    'blur',
    'similar',
    'classification',
    'unknown',
]);

export interface MediaProgressCollections {
    photoProcessedIds: string[];
    videoProcessedIds: string[];
    deleteQueue: PhotoAsset[];
    videoTrashBin: PhotoAsset[];
    collectionQueue: PhotoAsset[];
    pendingDeletionInfo: Record<string, PendingDeletionInfo>;
}

export function emptyMediaProgressCollections(): MediaProgressCollections {
    return {
        photoProcessedIds: [],
        videoProcessedIds: [],
        deleteQueue: [],
        videoTrashBin: [],
        collectionQueue: [],
        pendingDeletionInfo: {},
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

export function validatePendingDeletionInfoEntry(value: unknown): PendingDeletionInfo {
    if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
        || !('source' in value)
        || !('addedAt' in value)
    ) {
        throw new LocalPrivacyError();
    }
    const source = (value as { source: unknown }).source;
    const addedAt = (value as { addedAt: unknown }).addedAt;
    if (
        typeof source !== 'string'
        || !VALID_PENDING_DELETION_SOURCES.has(source as PendingDeletionSource)
        || typeof addedAt !== 'number'
        || !Number.isSafeInteger(addedAt)
        || addedAt < 0
    ) {
        throw new LocalPrivacyError();
    }
    return {
        source: source as PendingDeletionSource,
        addedAt,
    };
}

export function normalizePendingDeletionInfoMap(
    input: unknown,
    allowedAssetIds?: ReadonlySet<string>
): Record<string, PendingDeletionInfo> {
    if (input === undefined) return {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new LocalPrivacyError();
    }
    const result: Record<string, PendingDeletionInfo> = {};
    for (const [assetId, rawEntry] of Object.entries(input as Record<string, unknown>)) {
        if (!assetId) throw new LocalPrivacyError();
        const validated = validatePendingDeletionInfoEntry(rawEntry);
        if (!allowedAssetIds || allowedAssetIds.has(assetId)) {
            result[assetId] = validated;
        }
    }
    return result;
}

export function normalizeMediaProgressCollections(
    input: Partial<MediaProgressCollections>
): MediaProgressCollections {
    const deleteQueue = dedupeMediaAssets(input.deleteQueue ?? []);
    const videoTrashBin = dedupeMediaAssets(input.videoTrashBin ?? []);
    const pendingIds = new Set<string>();
    for (const asset of deleteQueue) pendingIds.add(asset.id);
    for (const asset of videoTrashBin) pendingIds.add(asset.id);

    return {
        photoProcessedIds: dedupeMediaIds(input.photoProcessedIds ?? []),
        videoProcessedIds: dedupeMediaIds(input.videoProcessedIds ?? []),
        deleteQueue,
        videoTrashBin,
        collectionQueue: dedupeMediaAssets(input.collectionQueue ?? []),
        pendingDeletionInfo: normalizePendingDeletionInfoMap(input.pendingDeletionInfo, pendingIds),
    };
}

export function pendingDeletionInfoEqual(
    left: PendingDeletionInfo | undefined,
    right: PendingDeletionInfo | undefined
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.source === right.source && left.addedAt === right.addedAt;
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
        || left.collectionQueue.length !== right.collectionQueue.length
    ) {
        return false;
    }

    const leftInfoKeys = Object.keys(left.pendingDeletionInfo);
    const rightInfoKeys = Object.keys(right.pendingDeletionInfo);
    if (leftInfoKeys.length !== rightInfoKeys.length) return false;
    for (const key of leftInfoKeys) {
        if (!pendingDeletionInfoEqual(left.pendingDeletionInfo[key], right.pendingDeletionInfo[key])) {
            return false;
        }
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
    for (let i = 0; i < left.collectionQueue.length; i++) {
        if (JSON.stringify(left.collectionQueue[i]) !== JSON.stringify(right.collectionQueue[i])) return false;
    }
    return true;
}
