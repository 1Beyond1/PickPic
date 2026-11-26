import { SimilarReviewRepository } from '../database/repositories/SimilarReviewRepository';
import { getReadableMediaInfos } from './readableMedia';
import { flushMediaProgress } from './mediaProgressStorage';
import { isRecordTransferActive } from './recordOperationLock';
import { getCurrentlyVisibleAssetIds, useMediaStore } from '../stores/useMediaStore';
import { usePrivacyStore } from '../stores/usePrivacyStore';

export type SimilarActionResult = 'saved' | 'stale' | 'unavailable' | 'incomplete' | 'busy' | 'failed';
function busy() {
    const state = useMediaStore.getState();
    return !state.hasHydrated || state.isConfirmingDeletion || state.isConfirmingVideoTrash
        || isRecordTransferActive() || Object.keys(usePrivacyStore.getState().failures).length > 0;
}
function captureCurrent(isCurrent: () => boolean) {
    const state = useMediaStore.getState();
    const { permissionRefreshVersion, mediaLibraryRefreshVersion } = state;
    return () => isCurrent() && !busy()
        && permissionRefreshVersion === useMediaStore.getState().permissionRefreshVersion
        && mediaLibraryRefreshVersion === useMediaStore.getState().mediaLibraryRefreshVersion;
}
async function readVisiblePhotos(ids: readonly string[], current: () => boolean) {
    // Fresh permission check plus exact ID/type matching: stale URIs are not
    // sufficient authority for making a new media decision.
    const visible = await getCurrentlyVisibleAssetIds(ids, 'photo');
    if (!current() || visible.size !== new Set(ids).size) return null;
    const photos = await getReadableMediaInfos(ids, 'photo');
    if (!current() || ids.some(id => !photos.has(id) || photos.get(id)?.mediaType !== 'photo'
        || !(photos.get(id)?.localUri || photos.get(id)?.uri))) return null;
    return ids.map(id => photos.get(id)!);
}

export async function keepSimilarPhotos(groupId: string, key: string, ids: readonly string[],
    isCurrent: () => boolean): Promise<SimilarActionResult> {
    if (busy()) return 'busy';
    const current = captureCurrent(isCurrent);
    try {
        const snapshot = await SimilarReviewRepository.getSnapshot(groupId);
        if (!current() || snapshot?.key !== key) return 'stale';
        const members = new Set(snapshot.assets.map(asset => asset.asset_id));
        const requested = [...new Set(ids)];
        if (!requested.length || requested.some(id => !members.has(id))) return 'incomplete';
        const photos = await readVisiblePhotos(requested, current);
        if (!current()) return 'stale';
        if (!photos) return 'unavailable';
        if (!useMediaStore.getState().keepPhotosFromSimilar(photos)) return 'busy';
        await flushMediaProgress();
        if (!current()) return 'stale';
        const state = useMediaStore.getState();
        return requested.every(id => state.photoProcessedIds.includes(id)
            && !state.deleteQueue.some(asset => asset.id === id)) ? 'saved' : 'stale';
    } catch { return 'failed'; }
}

export async function completeSimilarGroup(groupId: string, key: string, explicitKeptIds: readonly string[],
    isCurrent: () => boolean): Promise<SimilarActionResult> {
    if (busy()) return 'busy';
    const current = captureCurrent(isCurrent);
    try {
        const snapshot = await SimilarReviewRepository.getSnapshot(groupId);
        if (!current() || snapshot?.key !== key) return 'stale';
        const ids = snapshot.assets.map(asset => asset.asset_id);
        const keptIds = [...new Set(explicitKeptIds)];
        if (!keptIds.length || keptIds.some(id => !ids.includes(id))) return 'incomplete';
        const photos = await readVisiblePhotos(ids, current);
        if (!current()) return 'stale';
        if (!photos) return 'unavailable';
        const state = useMediaStore.getState();
        const pending = new Set(state.deleteQueue.map(asset => asset.id));
        const processed = new Set(state.photoProcessedIds);
        const pendingIds = ids.filter(id => !keptIds.includes(id));
        const agree = () => {
            const latest = useMediaStore.getState();
            return keptIds.every(id => latest.photoProcessedIds.includes(id) && !latest.deleteQueue.some(asset => asset.id === id))
                && pendingIds.every(id => latest.photoProcessedIds.includes(id) && latest.deleteQueue.some(asset => asset.id === id));
        };
        if (keptIds.some(id => !processed.has(id) || pending.has(id))
            || pendingIds.some(id => !processed.has(id) || !pending.has(id))) return 'incomplete';
        await flushMediaProgress();
        if (!current() || !agree()) return 'stale';
        const saved = await SimilarReviewRepository.save(groupId, key, keptIds, pendingIds, () => current() && agree());
        // Two independent encrypted stores, not a distributed transaction:
        // decisions are flushed FIRST. Failed confirmation leaves valid media
        // decisions intact but the group stays unconfirmed and can be retried.
        return saved && current() && agree() ? 'saved' : 'stale';
    } catch { return 'failed'; }
}
