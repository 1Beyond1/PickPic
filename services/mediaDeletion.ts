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

/**
 * MediaStore.createDeleteRequest limits each request to 2000 URIs on
 * Android 16+ for apps targeting API 36+. Our target SDK is 36.
 * Reconcile each successful batch before requesting the next one: a later
 * cancellation must not leave already-deleted items in the pending list.
 * No retries or fallback deletion bypass the user's system confirmation.
 */
export async function deleteAssetsInBatches<T extends MediaLibrary.Asset | string>(
    assets: readonly T[],
    onBatchDeleted: (batch: T[]) => void | Promise<void>,
): Promise<void> {
    const batchSize = Platform.OS === 'android' && Number(Platform.Version) >= 36
        ? 2000
        : assets.length;
    if (assets.length === 0) return;

    for (let offset = 0; offset < assets.length; offset += batchSize) {
        const batch = assets.slice(offset, offset + batchSize);
        try {
            if (!await MediaLibrary.deleteAssetsAsync(batch)) throw new MediaDeletionError('cancelled');
        } catch (error) { throw new MediaDeletionError(getDeletionFailureKind(error)); }
        await onBatchDeleted(batch);
    }
}
