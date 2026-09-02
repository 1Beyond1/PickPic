/**
 * Asset Repository - CRUD operations for scanned assets
 */

import { getDatabase, withTransaction } from '../db';
import {
    addAssetToMatchingGroupsInDatabase,
    repairDuplicateGroupsInDatabase,
} from './DupGroupRepository';
import type { SimilarityCandidate } from './DupGroupRepository';
import { AssetStatus, AssetStatusType, GLOBAL_ALGO_VERSION, MetaKeys } from '../schema';

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

export interface BlurryAsset {
    asset_id: string;
    blur_score: number;
    mean_luma: number;
}

const BATCH_SIZE = 20;

interface AssetScope {
    clause: string;
    params: string[];
}

/**
 * Build a parameterized asset-id filter for scoped scanner operations.
 * Undefined means the whole local index; an empty list means no assets.
 */
function createAssetScope(assetIds?: readonly string[]): AssetScope {
    if (assetIds === undefined) {
        return { clause: '', params: [] };
    }

    const uniqueAssetIds = Array.from(new Set(assetIds));
    return {
        clause: ` AND asset_id IN (${uniqueAssetIds.map(() => '?').join(', ')})`,
        params: uniqueAssetIds,
    };
}

function splitAssetIds(assetIds?: readonly string[]): Array<readonly string[] | undefined> {
    if (assetIds === undefined) return [undefined];

    const uniqueAssetIds = Array.from(new Set(assetIds));
    const batches: Array<readonly string[]> = [];
    for (let i = 0; i < uniqueAssetIds.length; i += 500) {
        batches.push(uniqueAssetIds.slice(i, i + 500));
    }
    return batches;
}

async function removeAssetsAndDerivedDataInDatabase(
    db: Awaited<ReturnType<typeof getDatabase>>,
    assetIds: readonly string[]
): Promise<void> {
    const uniqueAssetIds = Array.from(new Set(assetIds));
    for (let i = 0; i < uniqueAssetIds.length; i += 500) {
        const batch = uniqueAssetIds.slice(i, i + 500);
        const placeholders = batch.map(() => '?').join(', ');

        await db.runAsync(
            `DELETE FROM dup_members WHERE asset_id IN (${placeholders})`,
            batch
        );
        await db.runAsync(
            `DELETE FROM face_instances WHERE asset_id IN (${placeholders})`,
            batch
        );
        await db.runAsync(
            `DELETE FROM assets WHERE asset_id IN (${placeholders})`,
            batch
        );
    }

    await repairDuplicateGroupsInDatabase(db);
    await db.runAsync(
        'DELETE FROM face_groups WHERE face_id NOT IN (SELECT DISTINCT face_id FROM face_instances)'
    );
}

async function markDoneInDatabase(
    db: Awaited<ReturnType<typeof getDatabase>>,
    assetId: string,
    blurScore: number,
    meanLuma: number,
    phash: string,
    algoVersion: number,
    faceCount: number,
    labelsJson: string | null,
    preserveSingletonGroups: boolean
): Promise<void> {
    await db.runAsync(
        `UPDATE assets SET
 status = ?, blur_score = ?, mean_luma = ?, phash = ?,
 algo_version = ?, face_count = ?, labels_json = ?,
 error_message = NULL, updated_at = ?
WHERE asset_id = ?`,
        [
            AssetStatus.DONE,
            blurScore,
            meanLuma,
            phash,
            algoVersion,
            faceCount,
            labelsJson,
            Date.now(),
            assetId,
        ]
    );

    // Remove the old membership while committing the new result so stale
    // groups cannot survive a rescan. Scoped scans keep one-member groups as
    // recovery seeds for members outside the current scope.
    const removedDuplicateMembers = await db.runAsync(
        'DELETE FROM dup_members WHERE asset_id = ?',
        [assetId]
    );
    if (removedDuplicateMembers.changes > 0) {
        await repairDuplicateGroupsInDatabase(db, {
            removeSingletonGroups: !preserveSingletonGroups,
        });
    }
}

export const AssetRepository = {
    /**
     * Upsert an asset (insert or update)
     */
    async upsert(asset: Partial<AssetRecord> & { asset_id: string }): Promise<void> {
        await withTransaction(async db => {
            const now = Date.now();
            const updateClauses = [
                'taken_at = COALESCE(excluded.taken_at, taken_at)',
                'width = COALESCE(excluded.width, width)',
                'height = COALESCE(excluded.height, height)',
                'file_signature = COALESCE(excluded.file_signature, file_signature)',
                'algo_version = COALESCE(excluded.algo_version, algo_version)',
                'blur_score = COALESCE(excluded.blur_score, blur_score)',
                'mean_luma = COALESCE(excluded.mean_luma, mean_luma)',
                'phash = COALESCE(excluded.phash, phash)',
            ];

            // Omitted optional fields must not overwrite existing scan
            // results. They still receive defaults for a new row.
            if (asset.face_count !== undefined && asset.face_count !== null) {
                updateClauses.push('face_count = excluded.face_count');
            }
            updateClauses.push('labels_json = COALESCE(excluded.labels_json, labels_json)');
            if (asset.status !== undefined && asset.status !== null) {
                updateClauses.push('status = excluded.status');
            }
            updateClauses.push(
                'error_message = COALESCE(excluded.error_message, error_message)',
                'updated_at = ?'
            );

            await db.runAsync(
                `INSERT INTO assets (
        asset_id, taken_at, width, height, file_signature,
        algo_version, blur_score, mean_luma, phash, face_count, labels_json,
        status, error_message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        ${updateClauses.map(clause => `        ${clause}`).join(',\n')}`,
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
                    asset.face_count ?? 0,
                    asset.labels_json ?? null,
                    asset.status ?? AssetStatus.PENDING,
                    asset.error_message ?? null,
                    now,
                    now,
                ]
            );
        });
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

            await repairDuplicateGroupsInDatabase(transactionDb);
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
            await removeAssetsAndDerivedDataInDatabase(transactionDb, [assetId]);
        });
    },

    /**
     * Remove several assets from the local scan index after the media itself
     * was deleted outside the app. The media-library listener can provide a
     * batch of deleted IDs, so keep the dependent rows and group repair in one
     * transaction instead of exposing a partially cleaned index.
     */
    async removeAssetsAndDerivedData(assetIds: readonly string[]): Promise<void> {
        const uniqueAssetIds = Array.from(new Set(assetIds));
        if (uniqueAssetIds.length === 0) return;

        await withTransaction(async transactionDb => {
            await removeAssetsAndDerivedDataInDatabase(transactionDb, uniqueAssetIds);
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
     * Get the next assets that need scanner work, including failed assets and
     * completed assets produced by an older algorithm version. This lets a
     * bounded scan choose its exact work set before resetting any records.
     */
    async getScanCandidateBatch(
        currentAlgoVersion: number,
        limit: number = BATCH_SIZE,
        assetIds?: readonly string[]
    ): Promise<PendingAsset[]> {
        if (limit <= 0) return [];

        const candidateClause = `(
            status = ?
            OR status = ?
            OR (status = ? AND (algo_version IS NULL OR algo_version != ?))
        )`;
        const candidateParams: (string | number)[] = [
            AssetStatus.PENDING,
            AssetStatus.ERROR,
            AssetStatus.DONE,
            currentAlgoVersion,
        ];

        if (assetIds === undefined) {
            const db = await getDatabase();
            return db.getAllAsync<PendingAsset>(
                `SELECT asset_id, taken_at FROM assets
                 WHERE ${candidateClause}
                 ORDER BY taken_at ASC, asset_id ASC
                 LIMIT ?`,
                [...candidateParams, limit]
            );
        }

        const candidateBatches = splitAssetIds(assetIds);
        if (candidateBatches.length === 0) return [];

        const db = await getDatabase();
        const candidates: PendingAsset[] = [];
        for (const candidateBatch of candidateBatches) {
            const scope = createAssetScope(candidateBatch);
            candidates.push(...await db.getAllAsync<PendingAsset>(
                `SELECT asset_id, taken_at FROM assets
                 WHERE ${candidateClause}${scope.clause}
                 ORDER BY taken_at ASC, asset_id ASC
                 LIMIT ?`,
                [...candidateParams, ...scope.params, limit]
            ));
        }

        candidates.sort((a, b) => {
            if (a.taken_at === null && b.taken_at !== null) return -1;
            if (a.taken_at !== null && b.taken_at === null) return 1;
            if (a.taken_at !== b.taken_at) {
                return (a.taken_at ?? 0) - (b.taken_at ?? 0);
            }
            return a.asset_id.localeCompare(b.asset_id);
        });

        return candidates.slice(0, limit);
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
     * Detect a pending asset that sorts at or before the persisted
     * incremental cursor. This is a recovery guard for a process exit
     * between writing an asset as PENDING and persisting the cursor rewind
     * for that change. Equality matters when the cursor asset itself was
     * edited after the previous scan.
     */
    async hasPendingAtOrBeforeCursor(
        cursorTakenAt: number | null,
        cursorAssetId: string | null
    ): Promise<boolean> {
        if (cursorTakenAt === null || cursorAssetId === null) {
            return false;
        }

        const db = await getDatabase();
        const pending = await db.getFirstAsync<{ asset_id: string }>(
            `SELECT asset_id FROM assets
             WHERE status = ?
               AND (
                   taken_at IS NULL
                   OR taken_at < ?
                   OR (taken_at = ? AND asset_id <= ?)
               )
             LIMIT 1`,
            [AssetStatus.PENDING, cursorTakenAt, cursorTakenAt, cursorAssetId]
        );

        return pending !== null;
    },

    /**
     * Mark asset as done with scan results
     */
    async markDone(
        assetId: string,
        blurScore: number,
        meanLuma: number,
        phash: string,
        algoVersion: number = GLOBAL_ALGO_VERSION,
        faceCount: number = 0,
        labelsJson: string | null = null
    ): Promise<void> {
        await withTransaction(async db => {
            await markDoneInDatabase(
                db,
                assetId,
                blurScore,
                meanLuma,
                phash,
                algoVersion,
                faceCount,
                labelsJson,
                false
            );
        });
    },

    /**
     * Commit a scan result and its duplicate membership atomically. The
     * similarity query happens before this call, but all database writes that
     * publish the result are part of one transaction, so a restart cannot see
     * a current DONE asset without the group update that was computed for it.
     */
    async markDoneWithDuplicateGroups(
        assetId: string,
        blurScore: number,
        meanLuma: number,
        phash: string,
        algoVersion: number,
        faceCount: number,
        labelsJson: string | null,
        matches: readonly SimilarityCandidate[],
        newGroupId: string,
        preserveSingletonGroups = false
    ): Promise<string | null> {
        return withTransaction(async db => {
            await markDoneInDatabase(
                db,
                assetId,
                blurScore,
                meanLuma,
                phash,
                algoVersion,
                faceCount,
                labelsJson,
                preserveSingletonGroups
            );

            return addAssetToMatchingGroupsInDatabase(
                db,
                assetId,
                matches,
                newGroupId,
                preserveSingletonGroups
            );
        });
    },

    /**
     * Mark asset as error
     */
    async markError(
        assetId: string,
        errorMessage: string,
        preserveSingletonGroups = false
    ): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                `UPDATE assets SET
             status = ?, algo_version = NULL, blur_score = NULL,
             mean_luma = NULL, phash = NULL, face_count = NULL,
             labels_json = NULL, error_message = ?, updated_at = ?
             WHERE asset_id = ?`,
                [AssetStatus.ERROR, errorMessage, Date.now(), assetId]
            );

            // An error must not leave an incomplete asset attached to a
            // duplicate group. Keep one-member groups during scoped scans so
            // inaccessible/out-of-scope members remain recoverable.
            await db.runAsync('DELETE FROM dup_members WHERE asset_id = ?', [assetId]);
            await db.runAsync('DELETE FROM face_instances WHERE asset_id = ?', [assetId]);
            await repairDuplicateGroupsInDatabase(db, {
                removeSingletonGroups: !preserveSingletonGroups,
            });
            await db.runAsync(
                'DELETE FROM face_groups WHERE face_id NOT IN (SELECT DISTINCT face_id FROM face_instances)'
            );
        });
    },

    /**
     * Reset assets whose analysis was produced by a different algorithm
     * version. A future version can remain in a database after downgrading
     * the app and is just as incompatible as an older version.
     */
    async resetOutdatedAssets(
        currentAlgoVersion: number,
        assetIds?: readonly string[]
    ): Promise<string[]> {
        const assetIdBatches = splitAssetIds(assetIds);
        if (assetIdBatches.length === 0) return [];

        return withTransaction(async db => {
            const resetAssetIds: string[] = [];

            for (const assetIdBatch of assetIdBatches) {
                const scope = createAssetScope(assetIdBatch);
                const outdated = await db.getAllAsync<{ asset_id: string }>(
                    `SELECT asset_id FROM assets
                     WHERE status = ? AND (algo_version IS NULL OR algo_version != ?)${scope.clause}`,
                    [AssetStatus.DONE, currentAlgoVersion, ...scope.params]
                );

                if (outdated.length === 0) continue;

                await db.runAsync(
                    `UPDATE assets SET
                     status = ?, blur_score = NULL, mean_luma = NULL, phash = NULL,
                     face_count = 0, labels_json = NULL, error_message = NULL, updated_at = ?
                     WHERE status = ? AND (algo_version IS NULL OR algo_version != ?)${scope.clause}`,
                    [
                        AssetStatus.PENDING,
                        Date.now(),
                        AssetStatus.DONE,
                        currentAlgoVersion,
                        ...scope.params,
                    ]
                );

                resetAssetIds.push(...outdated.map(asset => asset.asset_id));
            }

            return resetAssetIds;
        });
    },

    /**
     * Refresh media-library metadata and reset derived results when the
     * underlying content or its scan-order metadata changes.
     *
     * Similarity matching uses taken_at as part of its candidate window, so a
     * changed creation time must be rescanned even when the file signature is
     * unchanged. Some platforms expose library-only URIs that cannot be
     * inspected by the file system; metadata still needs to be refreshed in
     * that case, while a non-null signature is required before invalidating
     * results for content changes.
     */
    async refreshLibraryMetadata(
        assetId: string,
        metadata: {
            takenAt: number;
            width: number;
            height: number;
            fileSignature: string | null;
        }
    ): Promise<boolean> {
        return withTransaction(async db => {
            const existing = await db.getFirstAsync<AssetRecord>(
                'SELECT * FROM assets WHERE asset_id = ?',
                [assetId]
            );
            if (!existing) return false;

            const signatureChanged = metadata.fileSignature !== null
                && existing.file_signature !== metadata.fileSignature;
            const metadataChanged = existing.taken_at !== metadata.takenAt
                || existing.width !== metadata.width
                || existing.height !== metadata.height
                || (metadata.fileSignature !== null && existing.file_signature !== metadata.fileSignature);

            if (!metadataChanged) return false;

            const scanOrderChanged = existing.taken_at !== metadata.takenAt;

            if (signatureChanged || scanOrderChanged) {
                await db.runAsync(
                    `UPDATE assets SET
                 taken_at = ?, width = ?, height = ?, file_signature = COALESCE(?, file_signature),
                 status = ?, algo_version = NULL, blur_score = NULL,
                 mean_luma = NULL, phash = NULL, face_count = 0,
                 labels_json = NULL, error_message = NULL, updated_at = ?
                 WHERE asset_id = ?`,
                    [
                        metadata.takenAt,
                        metadata.width,
                        metadata.height,
                        metadata.fileSignature,
                        AssetStatus.PENDING,
                        Date.now(),
                        assetId,
                    ]
                );
                return true;
            }

            await db.runAsync(
                `UPDATE assets SET
             taken_at = ?, width = ?, height = ?,
             file_signature = COALESCE(?, file_signature), updated_at = ?
             WHERE asset_id = ?`,
                [
                    metadata.takenAt,
                    metadata.width,
                    metadata.height,
                    metadata.fileSignature,
                    Date.now(),
                    assetId,
                ]
            );
            return false;
        });
    },

    /**
     * Get recent done assets within time window for similarity matching
     */
    async getRecentDoneAssets(
        takenAt: number,
        windowSeconds: number = 120,
        limit: number = 10,
        excludeAssetId?: string,
        candidateAssetIds?: readonly string[]
    ): Promise<AssetRecord[]> {
        const db = await getDatabase();
        const minTime = takenAt - windowSeconds * 1000;
        const maxTime = takenAt + windowSeconds * 1000;

        const exclusion = excludeAssetId ? ' AND asset_id != ?' : '';
        const recentAssets: AssetRecord[] = [];

        // Limited permission keeps inaccessible records in the local index
        // for recovery, so scope candidate reads to the current visible set.
        // Query each SQLite-safe chunk with the same limit; the global top N
        // must be present in the top N of at least one chunk.
        for (const candidateBatch of splitAssetIds(candidateAssetIds)) {
            if (candidateBatch !== undefined && candidateBatch.length === 0) continue;

            const scope = createAssetScope(candidateBatch);
            const params: (string | number)[] = [AssetStatus.DONE, minTime, maxTime];
            if (excludeAssetId) params.push(excludeAssetId);
            params.push(...scope.params, takenAt, limit);

            recentAssets.push(...await db.getAllAsync<AssetRecord>(
                `SELECT * FROM assets
                 WHERE status = ? AND taken_at BETWEEN ? AND ?${exclusion}${scope.clause}
                 ORDER BY ABS(taken_at - ?) ASC, taken_at DESC, asset_id ASC
                 LIMIT ?`,
                params
            ));
        }

        if (candidateAssetIds === undefined) return recentAssets;

        recentAssets.sort((a, b) => {
            const distanceDifference = Math.abs((a.taken_at ?? 0) - takenAt)
                - Math.abs((b.taken_at ?? 0) - takenAt);
            if (distanceDifference !== 0) return distanceDifference;
            if (a.taken_at !== b.taken_at) {
                return (b.taken_at ?? 0) - (a.taken_at ?? 0);
            }
            return a.asset_id.localeCompare(b.asset_id);
        });

        return recentAssets.slice(0, limit);
    },

    /**
     * Get the lowest-scoring completed assets, optionally restricted to a
     * permission-visible set. Apply the scope before LIMIT so hidden local
     * index rows cannot crowd visible results out of the result window.
     */
    async getBlurryAssets(
        assetIds?: readonly string[],
        limit: number = 50
    ): Promise<BlurryAsset[]> {
        if (limit <= 0) return [];

        const db = await getDatabase();
        const blurryAssets: BlurryAsset[] = [];

        for (const assetIdBatch of splitAssetIds(assetIds)) {
            if (assetIdBatch !== undefined && assetIdBatch.length === 0) continue;

            const scope = createAssetScope(assetIdBatch);
            blurryAssets.push(...await db.getAllAsync<BlurryAsset>(
                `SELECT asset_id, blur_score, mean_luma FROM assets
                 WHERE status = ? AND blur_score < ?${scope.clause}
                 ORDER BY blur_score ASC, asset_id ASC
                 LIMIT ?`,
                [AssetStatus.DONE, 100, ...scope.params, limit]
            ));
        }

        if (assetIds === undefined) return blurryAssets;

        blurryAssets.sort((a, b) => {
            if (a.blur_score !== b.blur_score) return a.blur_score - b.blur_score;
            return a.asset_id.localeCompare(b.asset_id);
        });
        return blurryAssets.slice(0, limit);
    },

    /**
     * Get count of assets by status
     */
    async getStatusCounts(assetIds?: readonly string[]): Promise<{ pending: number; done: number; error: number }> {
        const db = await getDatabase();
        const counts = { pending: 0, done: 0, error: 0 };

        // Limited media access can leave hidden assets in the local index.
        // Query scoped IDs in SQLite-safe chunks so callers can report status
        // for only the assets currently visible to the user.
        for (const batch of splitAssetIds(assetIds)) {
            if (batch !== undefined && batch.length === 0) continue;

            const scope = createAssetScope(batch);
            const result = await db.getFirstAsync<{
                pending: number;
                done: number;
                error: number;
            }>(
                `SELECT
            COALESCE(SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0) as done,
            COALESCE(SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END), 0) as error
           FROM assets
           WHERE 1 = 1${scope.clause}`,
                scope.params
            );

            counts.pending += result?.pending ?? 0;
            counts.done += result?.done ?? 0;
            counts.error += result?.error ?? 0;
        }

        return counts;
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
     * Get every completed asset for a consistent AI-category snapshot.
     * Unlike the bounded query above, this is intentionally unbounded; callers
     * that render the complete category detail need accurate counts.
     */
    async getAllDoneAssets(): Promise<AssetRecord[]> {
        const db = await getDatabase();
        return db.getAllAsync<AssetRecord>(
            `SELECT * FROM assets
             WHERE status = ?
             ORDER BY taken_at DESC, asset_id ASC`,
            [AssetStatus.DONE]
        );
    },

    /**
     * Reset every scanner-derived record and return all assets to PENDING.
     */
    async resetAll(): Promise<void> {
        await withTransaction(async db => {
            // Keep cursor, derived groups, and asset statuses in one commit so
            // a failed reset cannot leave the scanner in a half-reset state.
            await db.runAsync('DELETE FROM dup_members');
            await db.runAsync('DELETE FROM dup_groups');
            await db.runAsync('DELETE FROM face_instances');
            await db.runAsync('DELETE FROM face_groups');
            await db.runAsync(
                'DELETE FROM meta WHERE key IN (?, ?)',
                [MetaKeys.SCAN_CURSOR_TAKEN_AT, MetaKeys.SCAN_CURSOR_ASSET_ID]
            );
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
        });
    },

    /**
     * Make failed assets eligible for an explicit resume/retry action.
     */
    async resetErrors(assetIds?: readonly string[]): Promise<number> {
        const assetIdBatches = splitAssetIds(assetIds);
        if (assetIdBatches.length === 0) return 0;

        return withTransaction(async db => {
            // Repair legacy partial writes before retrying. Current group
            // creation is atomic, but older app versions could leave an ERROR
            // asset attached to one or more groups.
            for (const assetIdBatch of assetIdBatches) {
                const scope = createAssetScope(assetIdBatch);
                await db.runAsync(
                    `DELETE FROM dup_members
                     WHERE asset_id IN (
                         SELECT asset_id FROM assets WHERE status = ?${scope.clause}
                     )`,
                    [AssetStatus.ERROR, ...scope.params]
                );
                await db.runAsync(
                    `DELETE FROM face_instances
                     WHERE asset_id IN (
                         SELECT asset_id FROM assets WHERE status = ?${scope.clause}
                     )`,
                    [AssetStatus.ERROR, ...scope.params]
                );
            }
            await repairDuplicateGroupsInDatabase(db);
            await db.runAsync(
                'DELETE FROM face_groups WHERE face_id NOT IN (SELECT DISTINCT face_id FROM face_instances)'
            );

            let resetCount = 0;
            for (const assetIdBatch of assetIdBatches) {
                const scope = createAssetScope(assetIdBatch);
                const result = await db.runAsync(
                    `UPDATE assets SET
                     status = ?, blur_score = NULL, mean_luma = NULL, phash = NULL,
                     face_count = NULL, labels_json = NULL, error_message = NULL,
                     updated_at = ?
                     WHERE status = ?${scope.clause}`,
                    [AssetStatus.PENDING, Date.now(), AssetStatus.ERROR, ...scope.params]
                );
                resetCount += result.changes;
            }
            return resetCount;
        });
    },
};
