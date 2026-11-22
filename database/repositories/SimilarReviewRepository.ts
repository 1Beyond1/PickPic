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
    group_id?: string;
    member_id: string;
    status: number | null;
    best_asset_id: string | null;
}
interface ReviewRow {
    snapshot_key?: string;
    kept_ids_json: string;
    pending_ids_json: string;
    reviewed_at: number;
}
class ReviewChangedError extends Error {}

const SQLITE_BATCH_SIZE = 500;

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

function buildSnapshotFromRows(rows: readonly SnapshotRow[]): SimilarGroupSnapshot | null {
    if (rows.length < 2 || rows.some(row => !row.asset_id || row.status !== AssetStatus.DONE)) return null;
    const assets = rows.map(row => ({ asset_id: row.asset_id, taken_at: row.taken_at,
        width: row.width, height: row.height, file_signature: row.file_signature,
        phash: row.phash, blur_score: row.blur_score, mean_luma: row.mean_luma }));
    const recommendation = rows[0].best_asset_id;
    return { key: snapshotKey(assets), assets,
        recommendedAssetId: assets.some(asset => asset.asset_id === recommendation) ? recommendation : null };
}

function parseReviewRow(snapshot: SimilarGroupSnapshot, row: ReviewRow): SimilarReview {
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
    return buildSnapshotFromRows(rows);
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
    async getSnapshotsBatch(groupIds: readonly string[]): Promise<Map<string, SimilarGroupSnapshot>> {
        const uniqueGroupIds = Array.from(new Set(groupIds));
        const snapshots = new Map<string, SimilarGroupSnapshot>();
        if (uniqueGroupIds.length === 0) return snapshots;

        const db = await getDatabase();
        const rowsByGroupId = new Map<string, SnapshotRow[]>();
        for (let i = 0; i < uniqueGroupIds.length; i += SQLITE_BATCH_SIZE) {
            const batch = uniqueGroupIds.slice(i, i + SQLITE_BATCH_SIZE);
            const placeholders = batch.map(() => '?').join(', ');
            const rows = await db.getAllAsync<SnapshotRow>(`
                SELECT groups.group_id, member.asset_id AS member_id, asset.asset_id, asset.taken_at,
                       asset.width, asset.height, asset.file_signature, asset.phash,
                       asset.blur_score, asset.mean_luma, asset.status, groups.best_asset_id
                FROM dup_groups AS groups
                JOIN dup_members AS member ON member.group_id = groups.group_id
                LEFT JOIN assets AS asset ON asset.asset_id = member.asset_id
                WHERE groups.group_id IN (${placeholders})
                ORDER BY groups.group_id ASC, member.asset_id ASC`, batch);
            for (const row of rows) {
                if (!row.group_id) continue;
                const list = rowsByGroupId.get(row.group_id);
                if (list) list.push(row);
                else rowsByGroupId.set(row.group_id, [row]);
            }
        }

        for (const [groupId, rows] of rowsByGroupId) {
            const snapshot = buildSnapshotFromRows(rows);
            if (snapshot) snapshots.set(groupId, snapshot);
        }
        return snapshots;
    },
    async getReview(snapshot: SimilarGroupSnapshot): Promise<SimilarReview | null> {
        const db = await getDatabase();
        const row = await db.getFirstAsync<ReviewRow>('SELECT * FROM similar_reviews WHERE snapshot_key = ?', [snapshot.key]);
        if (!row) return null;
        return parseReviewRow(snapshot, row);
    },
    async getReviewsBatch(snapshots: readonly SimilarGroupSnapshot[]): Promise<Map<string, SimilarReview>> {
        const byKey = new Map<string, SimilarGroupSnapshot>();
        for (const snapshot of snapshots) {
            if (!byKey.has(snapshot.key)) byKey.set(snapshot.key, snapshot);
        }
        const reviews = new Map<string, SimilarReview>();
        const keys = Array.from(byKey.keys());
        if (keys.length === 0) return reviews;

        const db = await getDatabase();
        for (let i = 0; i < keys.length; i += SQLITE_BATCH_SIZE) {
            const batch = keys.slice(i, i + SQLITE_BATCH_SIZE);
            const placeholders = batch.map(() => '?').join(', ');
            const rows = await db.getAllAsync<ReviewRow>(
                `SELECT snapshot_key, kept_ids_json, pending_ids_json, reviewed_at
                 FROM similar_reviews
                 WHERE snapshot_key IN (${placeholders})`,
                batch
            );
            for (const row of rows) {
                const key = row.snapshot_key;
                if (!key) continue;
                const snapshot = byKey.get(key);
                if (!snapshot) continue;
                reviews.set(key, parseReviewRow(snapshot, row));
            }
        }
        return reviews;
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
export function isSimilarReviewCurrent(
    review: SimilarReview | null,
    processedIds: readonly string[] | ReadonlySet<string>,
    pendingIds: readonly string[] | ReadonlySet<string>,
): boolean {
    if (!review) return false;
    const processed = processedIds instanceof Set ? processedIds : new Set(processedIds);
    const pending = pendingIds instanceof Set ? pendingIds : new Set(pendingIds);
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
