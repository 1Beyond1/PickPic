import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase, withTransaction } from '../db';
import { AssetStatus } from '../schema';
import type { BestShotAsset } from '../bestShotScoring';

export interface SimilarReviewAsset extends BestShotAsset {
    taken_at: number | null;
    file_signature: string | null;
    phash: string | null;
}
export interface SimilarGroupSnapshot {
    key: string;
    assets: SimilarReviewAsset[];
    recommendedAssetId: string | null;
}
export interface SimilarReview {
    keptIds: string[];
    pendingIds: string[];
    reviewedAt: number;
}
interface SnapshotRow extends SimilarReviewAsset {
    member_id: string;
    status: number | null;
    best_asset_id: string | null;
}
interface ReviewRow {
    kept_ids_json: string;
    pending_ids_json: string;
    reviewed_at: number;
}
class ReviewChangedError extends Error {}

/** An indexed-media fingerprint, NOT proof of byte-for-byte equality.
 * Scan timestamps, scores and group IDs are deliberately excluded. When an
 * indexed file signature exists it is the source identity; perceptual hash
 * is only the fallback for older entries with no such signature. */
function snapshotKey(assets: readonly SimilarReviewAsset[]): string {
    const source = assets.map(asset => [asset.asset_id, asset.taken_at,
        asset.width, asset.height, asset.file_signature,
        asset.file_signature === null ? asset.phash : null]);
    return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(['similar-review-v1', source]))));
}

async function readSnapshot(db: SQLiteDatabase, groupId: string): Promise<SimilarGroupSnapshot | null> {
    // One statement observes membership and source metadata together. LEFT
    // JOIN detects incomplete/orphaned members instead of confirming a subset.
    const rows = await db.getAllAsync<SnapshotRow>(`
        SELECT member.asset_id AS member_id, asset.asset_id, asset.taken_at,
               asset.width, asset.height, asset.file_signature, asset.phash,
               asset.blur_score, asset.mean_luma, asset.status, groups.best_asset_id
        FROM dup_groups AS groups
        JOIN dup_members AS member ON member.group_id = groups.group_id
        LEFT JOIN assets AS asset ON asset.asset_id = member.asset_id
        WHERE groups.group_id = ? ORDER BY member.asset_id ASC`, [groupId]);
    if (rows.length < 2 || rows.some(row => !row.asset_id || row.status !== AssetStatus.DONE)) return null;
    const assets = rows.map(row => ({ asset_id: row.asset_id, taken_at: row.taken_at,
        width: row.width, height: row.height, file_signature: row.file_signature,
        phash: row.phash, blur_score: row.blur_score, mean_luma: row.mean_luma }));
    const recommendation = rows[0].best_asset_id;
    return { key: snapshotKey(assets), assets,
        recommendedAssetId: assets.some(asset => asset.asset_id === recommendation) ? recommendation : null };
}

function isPartition(memberIds: readonly string[], keptIds: unknown, pendingIds: unknown): boolean {
    if (!Array.isArray(keptIds) || !Array.isArray(pendingIds) || keptIds.length === 0) return false;
    const decisions = [...keptIds, ...pendingIds];
    const members = new Set(memberIds);
    return decisions.length === members.size && new Set(decisions).size === decisions.length
        && decisions.every(id => typeof id === 'string' && members.has(id));
}

export const SimilarReviewRepository = {
    async getSnapshot(groupId: string): Promise<SimilarGroupSnapshot | null> {
        return readSnapshot(await getDatabase(), groupId);
    },
    async getReview(snapshot: SimilarGroupSnapshot): Promise<SimilarReview | null> {
        const db = await getDatabase();
        const row = await db.getFirstAsync<ReviewRow>('SELECT * FROM similar_reviews WHERE snapshot_key = ?', [snapshot.key]);
        if (!row) return null;
        // Corrupt records must not silently become a successful review.
        let keptIds: unknown;
        let pendingIds: unknown;
        try {
            keptIds = JSON.parse(row.kept_ids_json);
            pendingIds = JSON.parse(row.pending_ids_json);
        } catch { throw new Error('Similar review record is invalid'); }
        if (!isPartition(snapshot.assets.map(asset => asset.asset_id), keptIds, pendingIds)
            || !Number.isSafeInteger(row.reviewed_at) || row.reviewed_at < 0) {
            throw new Error('Similar review record is invalid');
        }
        return { keptIds: keptIds as string[], pendingIds: pendingIds as string[], reviewedAt: row.reviewed_at };
    },
    async save(groupId: string, expectedKey: string, keptIds: readonly string[], pendingIds: readonly string[],
        isCurrent: () => boolean = () => true): Promise<boolean> {
        // Defensively copy before waiting for the transaction queue. Caller
        // mutations cannot turn an already validated request into another one.
        const kept = [...keptIds];
        const pending = [...pendingIds];
        try { return await withTransaction(async db => {
            const snapshot = await readSnapshot(db, groupId);
            if (!isCurrent() || !snapshot || snapshot.key !== expectedKey
                || !isPartition(snapshot.assets.map(asset => asset.asset_id), kept, pending)) return false;
            await db.runAsync(`INSERT OR REPLACE INTO similar_reviews
                (snapshot_key, kept_ids_json, pending_ids_json, reviewed_at) VALUES (?, ?, ?, ?)`,
            [snapshot.key, JSON.stringify(kept.sort()), JSON.stringify(pending.sort()), Date.now()]);
            // Store decisions / permission generation can change while the
            // native SQL promise is pending. Roll back this confirmation only.
            if (!isCurrent()) throw new ReviewChangedError();
            return true;
        }); } catch (error) {
            if (error instanceof ReviewChangedError) return false;
            throw error;
        }
    },
};

/** Current decisions must still agree: undoing a decision or changing a
 * queued photo to keep reopens the group until explicitly confirmed again.
 * Caller must use hydrated records; unresolved permissions are not deletion. */
export function isSimilarReviewCurrent(review: SimilarReview | null, processedIds: readonly string[], pendingIds: readonly string[]): boolean {
    if (!review) return false;
    const processed = new Set(processedIds);
    const pending = new Set(pendingIds);
    return review.keptIds.every(id => processed.has(id) && !pending.has(id))
        && review.pendingIds.every(id => processed.has(id) && pending.has(id));
}

/** Do not retain references to physically removed media in old snapshots.
 * Parameter batches are bounded by the caller, matching asset cleanup. */
export async function removeSimilarReviewsForAssets(db: SQLiteDatabase, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    await db.runAsync(`DELETE FROM similar_reviews WHERE EXISTS (
        SELECT 1 FROM json_each(kept_ids_json) WHERE value IN (${placeholders})
    ) OR EXISTS (
        SELECT 1 FROM json_each(pending_ids_json) WHERE value IN (${placeholders})
    )`, [...ids, ...ids]);
}
