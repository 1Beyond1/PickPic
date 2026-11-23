import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

export class MediaDeletionError extends Error {
    constructor(public readonly kind: 'cancelled' | 'failed') {
        super(kind === 'cancelled' ? 'System deletion was cancelled' : 'System deletion failed');
    }
}
export function getDeletionFailureKind(error: unknown): 'cancelled' | 'failed' {
    if (error instanceof MediaDeletionError) return error.kind;
    // SDK 54 Android DeleteContract rejects with this exact constant when
    // its system confirmation is declined; do not classify every permission
    // or provider error as a user cancellation.
    if (error instanceof Error && error.message.trim().endsWith("User didn't grant write permission to requested files.")) return 'cancelled';
    return 'failed';
}

export interface DeleteAssetsProtectionOptions {
    protectedAssetIds?: ReadonlySet<string>;
    protectedAlbumIds?: ReadonlySet<string>;
    onProtectedSkipped?: (skippedIds: string[]) => void;
}

function getAssetId<T extends MediaLibrary.Asset | string>(item: T): string {
    return typeof item === 'string' ? item : item.id;
}

function isProtectedItem<T extends MediaLibrary.Asset | string>(
    item: T,
    options?: DeleteAssetsProtectionOptions,
): boolean {
    if (!options) return false;
    const id = getAssetId(item);
    if (options.protectedAssetIds?.has(id)) return true;
    if (
        typeof item !== 'string'
        && typeof item.albumId === 'string'
        && item.albumId.length > 0
        && options.protectedAlbumIds?.has(item.albumId)
    ) {
        return true;
    }
    return false;
}

/**
 * MediaStore.createDeleteRequest on Android 11+ (API 30+) packs all requested
 * URIs into a Binder transaction (and Android 16+ caps requests at 2000 URIs).
 * Limiting each Android API 30+ batch to at most 1000 items avoids Android 11-15
 * Binder TransactionTooLargeException and stays within Android 16+'s cap.
 * Reconcile each successful batch before requesting the next one: a later
 * cancellation must not leave already-deleted items in the pending list.
 * No retries or fallback deletion bypass the user's system confirmation.
 */
export async function deleteAssetsInBatches<T extends MediaLibrary.Asset | string>(
    assets: readonly T[],
    onBatchDeleted: (batch: T[]) => void | Promise<void>,
    protection?: DeleteAssetsProtectionOptions,
): Promise<void> {
    const safeAssets: T[] = [];
    const skippedProtectedIds: string[] = [];
    for (const item of assets) {
        if (isProtectedItem(item, protection)) {
            skippedProtectedIds.push(getAssetId(item));
        } else {
            safeAssets.push(item);
        }
    }
    if (skippedProtectedIds.length > 0) {
        protection?.onProtectedSkipped?.(skippedProtectedIds);
    }

    const batchSize = Platform.OS === 'android' && Number(Platform.Version) >= 30
        ? 1000
        : safeAssets.length;
    if (safeAssets.length === 0) return;

    for (let offset = 0; offset < safeAssets.length; offset += batchSize) {
        const batch = safeAssets.slice(offset, offset + batchSize);
        try {
            if (!await MediaLibrary.deleteAssetsAsync(batch)) throw new MediaDeletionError('cancelled');
        } catch (error) { throw new MediaDeletionError(getDeletionFailureKind(error)); }
        await onBatchDeleted(batch);
    }
}
