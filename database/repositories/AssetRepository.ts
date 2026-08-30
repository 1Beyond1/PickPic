/**
 * Asset Repository - CRUD operations for scanned assets
 */

import { getDatabase, withTransaction } from '../db';
import { AssetStatus, AssetStatusType, GLOBAL_ALGO_VERSION } from '../schema';

export interface AssetRecord {
    asset_id: string;
    taken_at: number | null;
    width: number | null;
    height: number | null;
    face_count: number | null;
    file_signature: string | null;
    algo_version: number | null;
    blur_score: number | null;
    mean_luma: number | null;
    phash: string | null;
    labels_json: string | null;
    status: AssetStatusType;
    error_message: string | null;
    updated_at: number | null;
}

export interface PendingAsset {
    asset_id: string;
    taken_at: number | null;
}

const BATCH_SIZE = 20;

export const AssetRepository = {
    /**
     * Upsert an asset (insert or update)
     */
    async upsert(asset: Partial<AssetRecord> & { asset_id: string }): Promise<void> {
        const db = await getDatabase();

        const now = Date.now();
        await db.runAsync(
            `INSERT INTO assets (
        asset_id, taken_at, width, height, file_signature,
        algo_version, blur_score, mean_luma, phash, labels_json,
        status, error_message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        taken_at = COALESCE(excluded.taken_at, taken_at),
        width = COALESCE(excluded.width, width),
        height = COALESCE(excluded.height, height),
        file_signature = COALESCE(excluded.file_signature, file_signature),
        algo_version = COALESCE(excluded.algo_version, algo_version),
        blur_score = COALESCE(excluded.blur_score, blur_score),
        mean_luma = COALESCE(excluded.mean_luma, mean_luma),
        phash = COALESCE(excluded.phash, phash),
        labels_json = COALESCE(excluded.labels_json, labels_json),
        status = COALESCE(excluded.status, status),
        error_message = COALESCE(excluded.error_message, error_message),
        updated_at = ?`,
            [
                asset.asset_id,
                asset.taken_at ?? null,
                asset.width ?? null,
                asset.height ?? null,
                asset.file_signature ?? null,
                asset.algo_version ?? null,
                asset.blur_score ?? null,
                asset.mean_luma ?? null,
                asset.phash ?? null,
                asset.labels_json ?? null,
                asset.status ?? AssetStatus.PENDING,
                asset.error_message ?? null,
                now,
                now,
            ]
        );
    },

    /**
     * Get asset by ID
     */
    async getById(assetId: string): Promise<AssetRecord | null> {
        const db = await getDatabase();
        return db.getFirstAsync<AssetRecord>(
            'SELECT * FROM assets WHERE asset_id = ?',
            [assetId]
        );
    },

    /**
     * Remove database records for assets that are no longer visible in the
     * media library. This is called only after a complete library sync.
     */
    async removeMissingAssets(keepAssetIds: ReadonlySet<string>): Promise<string[]> {
        const db = await getDatabase();
        const existing = await db.getAllAsync<{ asset_id: string }>(
            'SELECT asset_id FROM assets'
        );
        const missing = existing
            .map(row => row.asset_id)
            .filter(assetId => !keepAssetIds.has(assetId));

        if (missing.length === 0) {
            return [];
        }

        await withTransaction(async transactionDb => {
            // Keep batches below SQLite's bind-parameter limit.
            for (let i = 0; i < missing.length; i += 500) {
                const batch = missing.slice(i, i + 500);
                const placeholders = batch.map(() => '?').join(', ');

                // Remove dependent scan results before removing the asset rows.
                await transactionDb.runAsync(
                    `DELETE FROM dup_members WHERE asset_id IN (${placeholders})`,
                    batch
                );
                await transactionDb.runAsync(
                    `DELETE FROM face_instances WHERE asset_id IN (${placeholders})`,
                    batch
                );
                await transactionDb.runAsync(
                    `DELETE FROM assets WHERE asset_id IN (${placeholders})`,
                    batch
                );
            }

            // Repair groups whose representative/best asset was removed, then
            // delete groups that no longer have any members.
            await transactionDb.runAsync(
                'DELETE FROM dup_groups WHERE group_id NOT IN (SELECT DISTINCT group_id FROM dup_members)'
            );
            await transactionDb.runAsync(
                `UPDATE dup_groups
                 SET representative_asset_id = (
                     SELECT asset_id FROM dup_members
                     WHERE dup_members.group_id = dup_groups.group_id
                     ORDER BY distance ASC
                     LIMIT 1
                 ),
                 best_asset_id = CASE
                     WHEN best_asset_id IS NULL OR EXISTS (
                         SELECT 1 FROM dup_members
                         WHERE dup_members.group_id = dup_groups.group_id
                           AND dup_members.asset_id = dup_groups.best_asset_id
                     ) THEN best_asset_id
                     ELSE (
                         SELECT asset_id FROM dup_members
                         WHERE dup_members.group_id = dup_groups.group_id
                         ORDER BY distance ASC
                         LIMIT 1
                     )
                 END`
            );
            await transactionDb.runAsync(
                'DELETE FROM face_groups WHERE face_id NOT IN (SELECT DISTINCT face_id FROM face_instances)'
            );
        });

        return missing;
    },

    /**
     * Remove one asset from the local scan index after the media itself was
     * deleted by the user.
     */
    async removeAssetAndDerivedData(assetId: string): Promise<void> {
        await withTransaction(async transactionDb => {
            await transactionDb.runAsync('DELETE FROM dup_members WHERE asset_id = ?', [assetId]);
            await transactionDb.runAsync('DELETE FROM face_instances WHERE asset_id = ?', [assetId]);
            await transactionDb.runAsync('DELETE FROM assets WHERE asset_id = ?', [assetId]);

            await transactionDb.runAsync(
                'DELETE FROM dup_groups WHERE group_id NOT IN (SELECT DISTINCT group_id FROM dup_members)'
            );
            await transactionDb.runAsync(
                `UPDATE dup_groups
                 SET representative_asset_id = (
                     SELECT asset_id FROM dup_members
                     WHERE dup_members.group_id = dup_groups.group_id
                     ORDER BY distance ASC
                     LIMIT 1
                 ),
                 best_asset_id = CASE
                     WHEN best_asset_id IS NULL OR EXISTS (
                         SELECT 1 FROM dup_members
                         WHERE dup_members.group_id = dup_groups.group_id
                           AND dup_members.asset_id = dup_groups.best_asset_id
                     ) THEN best_asset_id
                     ELSE (
                         SELECT asset_id FROM dup_members
                         WHERE dup_members.group_id = dup_groups.group_id
                         ORDER BY distance ASC
                         LIMIT 1
                     )
                 END`
            );
            await transactionDb.runAsync(
                'DELETE FROM face_groups WHERE face_id NOT IN (SELECT DISTINCT face_id FROM face_instances)'
            );
        });
    },

    /**
     * Get pending assets for scanning (cursor-based pagination)
     */
    async getPendingBatch(
        cursorTakenAt: number | null,
        cursorAssetId: string | null,
        limit: number = BATCH_SIZE
    ): Promise<PendingAsset[]> {
        const db = await getDatabase();

        if (cursorTakenAt === null || cursorAssetId === null) {
            // Start from beginning
            return db.getAllAsync<PendingAsset>(
                `SELECT asset_id, taken_at FROM assets
         WHERE status = ?
         ORDER BY taken_at ASC, asset_id ASC
         LIMIT ?`,
                [AssetStatus.PENDING, limit]
            );
        }

        // Continue from cursor (composite key pagination)
        return db.getAllAsync<PendingAsset>(
            `SELECT asset_id, taken_at FROM assets
       WHERE status = ?
         AND (taken_at > ? OR (taken_at = ? AND asset_id > ?))
       ORDER BY taken_at ASC, asset_id ASC
       LIMIT ?`,
            [AssetStatus.PENDING, cursorTakenAt, cursorTakenAt, cursorAssetId, limit]
        );
    },

    /**
     * Get pending assets from a selected set of media-library IDs.
     *
     * Album scans use this instead of the global cursor so scanning one album
     * cannot move the cursor past pending assets in other albums.
     */
    async getPendingBatchForAssetIds(
        assetIds: readonly string[],
        limit: number = BATCH_SIZE
    ): Promise<PendingAsset[]> {
        if (assetIds.length === 0 || limit <= 0) {
            return [];
        }

        const pending: PendingAsset[] = [];
        for (let i = 0; i < assetIds.length; i += 500) {
            const batch = assetIds.slice(i, i + 500);
            const placeholders = batch.map(() => '?').join(', ');
            const db = await getDatabase();
            pending.push(...await db.getAllAsync<PendingAsset>(
                `SELECT asset_id, taken_at FROM assets
                 WHERE status = ? AND asset_id IN (${placeholders})
                 ORDER BY taken_at ASC, asset_id ASC
                 LIMIT ?`,
                [AssetStatus.PENDING, ...batch, limit]
            ));
        }

        pending.sort((a, b) => {
            if (a.taken_at === null && b.taken_at !== null) return -1;
            if (a.taken_at !== null && b.taken_at === null) return 1;
            if (a.taken_at !== b.taken_at) {
                return (a.taken_at ?? 0) - (b.taken_at ?? 0);
            }
            return a.asset_id.localeCompare(b.asset_id);
        });

        return pending.slice(0, limit);
    },

    /**
     * Mark asset as done with scan results
     */
    async markDone(
        assetId: string,
        blurScore: number,
        meanLuma: number,
        phash: string,
        algoVersion: number = GLOBAL_ALGO_VERSION
    ): Promise<void> {
        const db = await getDatabase();
        await db.runAsync(
            `UPDATE assets SET
        status = ?, blur_score = ?, mean_luma = ?, phash = ?,
        algo_version = ?, error_message = NULL, updated_at = ?
       WHERE asset_id = ?`,
            [AssetStatus.DONE, blurScore, meanLuma, phash, algoVersion, Date.now(), assetId]
        );
    },

    /**
     * Mark asset as error
     */
    async markError(assetId: string, errorMessage: string): Promise<void> {
        const db = await getDatabase();
        await db.runAsync(
            `UPDATE assets SET status = ?, error_message = ?, updated_at = ? WHERE asset_id = ?`,
            [AssetStatus.ERROR, errorMessage, Date.now(), assetId]
        );
    },

    /**
     * Reset outdated assets to pending (algo_version mismatch)
     */
    async resetOutdatedAssets(currentAlgoVersion: number): Promise<number> {
        const db = await getDatabase();
        const result = await db.runAsync(
            `UPDATE assets SET
       status = ?, blur_score = NULL, mean_luma = NULL, phash = NULL,
       face_count = 0, labels_json = NULL, error_message = NULL, updated_at = ?
       WHERE status = ? AND (algo_version IS NULL OR algo_version < ?)`,
            [AssetStatus.PENDING, Date.now(), AssetStatus.DONE, currentAlgoVersion]
        );
        return result.changes;
    },

    /**
     * Reset asset to pending if file_signature changed
     */
    async resetIfSignatureChanged(assetId: string, newSignature: string | null): Promise<boolean> {
        if (newSignature === null) {
            return false;
        }

        const db = await getDatabase();
        const existing = await this.getById(assetId);

        if (existing && existing.file_signature !== newSignature) {
            await db.runAsync(
                `UPDATE assets SET
           status = ?, file_signature = ?, algo_version = NULL,
           blur_score = NULL, mean_luma = NULL, phash = NULL,
           face_count = 0, labels_json = NULL, error_message = NULL,
           updated_at = ?
         WHERE asset_id = ?`,
                [AssetStatus.PENDING, newSignature, Date.now(), assetId]
            );
            return true;
        }
        return false;
    },

    /**
     * Get recent done assets within time window for similarity matching
     */
    async getRecentDoneAssets(
        takenAt: number,
        windowSeconds: number = 120,
        limit: number = 10,
        excludeAssetId?: string
    ): Promise<AssetRecord[]> {
        const db = await getDatabase();
        const minTime = takenAt - windowSeconds * 1000;
        const maxTime = takenAt + windowSeconds * 1000;

        const exclusion = excludeAssetId ? ' AND asset_id != ?' : '';
        const params: (string | number)[] = [AssetStatus.DONE, minTime, maxTime];
        if (excludeAssetId) params.push(excludeAssetId);
        params.push(limit);

        return db.getAllAsync<AssetRecord>(
            `SELECT * FROM assets
       WHERE status = ? AND taken_at BETWEEN ? AND ?${exclusion}
       ORDER BY taken_at DESC
       LIMIT ?`,
            params
        );
    },

    /**
     * Get count of assets by status
     */
    async getStatusCounts(): Promise<{ pending: number; done: number; error: number }> {
        const db = await getDatabase();
        const result = await db.getFirstAsync<{
            pending: number;
            done: number;
            error: number;
        }>(
            `SELECT
        COALESCE(SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0) as done,
        COALESCE(SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END), 0) as error
       FROM assets`
        );
        return result ?? { pending: 0, done: 0, error: 0 };
    },

    /**
     * Get recent assets containing faces
     */
    async getPeopleAssets(limit: number = 100): Promise<AssetRecord[]> {
        const db = await getDatabase();
        return db.getAllAsync<AssetRecord>(
            `SELECT * FROM assets
             WHERE status = ? AND face_count > 0
             ORDER BY taken_at DESC LIMIT ?`,
            [AssetStatus.DONE, limit]
        );
    },

    /**
     * Get all processed assets (for classification)
     */
    async getLabeledAssets(limit: number = 5000): Promise<AssetRecord[]> {
        const db = await getDatabase();
        // Return ALL Done assets, even if labels_json is null (Uncategorized)
        return db.getAllAsync<AssetRecord>(
            `SELECT * FROM assets WHERE status = 1 ORDER BY taken_at DESC LIMIT ?`,
            [limit]
        );
    },

    /**
     * Reset ALL assets to PENDING state (Force Rescan)
     */
    async resetAll(): Promise<void> {
        const db = await getDatabase();
        await db.runAsync(
            `UPDATE assets SET 
             status = ?, 
             algo_version = NULL,
             blur_score = NULL,
             mean_luma = NULL,
             phash = NULL,
             face_count = NULL, 
             labels_json = NULL,
             error_message = NULL,
             updated_at = ?`,
            [AssetStatus.PENDING, Date.now()]
        );
    },

    /**
     * Make failed assets eligible for an explicit resume/retry action.
     */
    async resetErrors(): Promise<number> {
        const db = await getDatabase();
        const result = await db.runAsync(
            `UPDATE assets SET
             status = ?, blur_score = NULL, mean_luma = NULL, phash = NULL,
             face_count = NULL, labels_json = NULL, error_message = NULL,
             updated_at = ?
             WHERE status = ?`,
            [AssetStatus.PENDING, Date.now(), AssetStatus.ERROR]
        );
        return result.changes;
    },
};
