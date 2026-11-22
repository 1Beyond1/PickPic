import type { PhotoAsset } from '../stores/useMediaStore';

export type PendingDeletionSource = 'photos' | 'videos' | 'blur' | 'similar' | 'classification' | 'unknown';
export interface PendingDeletionInfo { source: PendingDeletionSource; addedAt: number; }
export interface PendingDeletionEntry extends PendingDeletionInfo { asset: PhotoAsset; type: 'photo' | 'video'; }
export interface PendingDeletionQueues {
    deleteQueue: readonly PhotoAsset[];
    videoTrashBin: readonly PhotoAsset[];
    pendingDeletionInfo?: Readonly<Record<string, PendingDeletionInfo>>;
}
export interface PendingDeletionResult {
    status: 'success' | 'partial' | 'cancelled' | 'failed' | 'unavailable' | 'busy';
    requestedIds: string[];
    deletedIds: string[];
    remainingIds: string[];
    failureKind: 'cancelled' | 'failed' | null;
    protectedSkippedIds?: string[];
}

/** Existing photo/video arrays remain compatible with password backups. This
 * single projection and mutation API is shared by every review entry point. */
export function getPendingDeletionEntries(state: PendingDeletionQueues): PendingDeletionEntry[] {
    const seen = new Set<string>();
    const entries: PendingDeletionEntry[] = [];
    for (const [type, assets] of [['photo', state.deleteQueue], ['video', state.videoTrashBin]] as const) {
        for (const asset of assets) {
            if (seen.has(asset.id)) continue;
            seen.add(asset.id);
            entries.push({ asset, type, ...(state.pendingDeletionInfo?.[asset.id] ?? { source: 'unknown', addedAt: 0 }) });
        }
    }
    return entries;
}
export function retainPendingDeletionInfo(state: PendingDeletionQueues): Record<string, PendingDeletionInfo> {
    const retained: Record<string, PendingDeletionInfo> = {};
    for (const entry of getPendingDeletionEntries(state)) {
        if (state.pendingDeletionInfo?.[entry.asset.id]) retained[entry.asset.id] = state.pendingDeletionInfo[entry.asset.id];
    }
    return retained;
}
export class PendingDeletionIncompleteError extends Error {
    constructor(public readonly result: PendingDeletionResult) {
        super('Some media was not confirmed deleted; review unresolved items');
    }
}
