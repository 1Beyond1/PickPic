/**
 * Face Repository - Manages face detection data and clustering
 */

import { getDatabase, withTransaction } from '../db';
import { AssetStatus } from '../schema';

const FACE_ASSET_BATCH_SIZE = 500;

/**
 * Remove face instances for a set of assets inside an existing transaction.
 * Face instances are scanner-derived data, so they must not survive while an
 * asset is being reprocessed or after its media row is deleted.
 */
export async function removeFaceInstancesInDatabase(
    db: Awaited<ReturnType<typeof getDatabase>>,
    assetIds: readonly string[]
): Promise<number> {
    const uniqueAssetIds = Array.from(new Set(assetIds));
    let removedCount = 0;
    for (let i = 0; i < uniqueAssetIds.length; i += FACE_ASSET_BATCH_SIZE) {
        const batch = uniqueAssetIds.slice(i, i + FACE_ASSET_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        const result = await db.runAsync(
            `DELETE FROM face_instances WHERE asset_id IN (${placeholders})`,
            batch
        );
        removedCount += result.changes;
    }
    return removedCount;
}

/**
 * Restore the face-data invariants after asset or instance mutations.
 * `photo_count` counts distinct assets (not faces), and pointers to a removed
 * first-seen asset are replaced with a remaining member. A replacement URI
 * cannot be reconstructed from the local index, so clear it rather than
 * retaining a URI that may point to deleted media.
 */
export async function repairFaceDataInDatabase(
    db: Awaited<ReturnType<typeof getDatabase>>
): Promise<void> {
    await db.runAsync(
        `DELETE FROM face_instances AS instance
         WHERE NOT EXISTS (
             SELECT 1 FROM face_groups AS group_row
             WHERE group_row.face_id = instance.face_id
         )
         OR NOT EXISTS (
             SELECT 1 FROM assets AS asset
             WHERE asset.asset_id = instance.asset_id
               AND asset.status = ?
         )`,
        [AssetStatus.DONE]
    );

    await db.runAsync(
        `DELETE FROM face_groups AS group_row
         WHERE NOT EXISTS (
             SELECT 1 FROM face_instances AS instance
             WHERE instance.face_id = group_row.face_id
         )`
    );

    await db.runAsync(
        `UPDATE face_groups AS group_row SET
            photo_count = (
                SELECT COUNT(DISTINCT instance.asset_id)
                FROM face_instances AS instance
                WHERE instance.face_id = group_row.face_id
            ),
            first_seen_asset_id = CASE
                WHEN group_row.first_seen_asset_id IS NOT NULL
                 AND EXISTS (
                     SELECT 1 FROM face_instances AS instance
                     WHERE instance.face_id = group_row.face_id
                       AND instance.asset_id = group_row.first_seen_asset_id
                 )
                    THEN group_row.first_seen_asset_id
                ELSE (
                    SELECT MIN(instance.asset_id)
                    FROM face_instances AS instance
                    WHERE instance.face_id = group_row.face_id
                )
            END,
            representative_uri = CASE
                WHEN group_row.first_seen_asset_id IS NOT NULL
                 AND EXISTS (
                     SELECT 1 FROM face_instances AS instance
                     WHERE instance.face_id = group_row.face_id
                       AND instance.asset_id = group_row.first_seen_asset_id
                 )
                    THEN group_row.representative_uri
                ELSE NULL
            END`
    );
}

export interface FaceGroup {
    face_id: string;
    cluster_id: number | null;
    first_seen_asset_id: string | null;
    representative_uri: string | null;
    photo_count: number;
    created_at: number;
}

export interface FaceInstance {
    instance_id: string;
    face_id: string;
    asset_id: string;
    bounding_box: string; // JSON
    confidence: number;
}

export const FaceRepository = {
    /**
     * Create a new face group
     */
    async createFaceGroup(
        faceId: string,
        firstSeenAssetId: string,
        representativeUri?: string
    ): Promise<void> {
        await withTransaction(async db => {
            const now = Date.now();
            await db.runAsync(
                `INSERT INTO face_groups (face_id, cluster_id, first_seen_asset_id, representative_uri, photo_count, created_at)
             VALUES (?, NULL, ?, ?, 1, ?)`,
                [faceId, firstSeenAssetId, representativeUri || null, now]
            );
        });
    },

    /**
     * Add a face instance
     */
    async createFaceInstance(
        instanceId: string,
        faceId: string,
        assetId: string,
        boundingBox: { x: number; y: number; width: number; height: number },
        confidence: number
    ): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                `INSERT INTO face_instances (instance_id, face_id, asset_id, bounding_box, confidence)
             VALUES (?, ?, ?, ?, ?)`,
                [instanceId, faceId, assetId, JSON.stringify(boundingBox), confidence]
            );
        });
    },

    /**
     * Get all face groups
     */
    async getAllFaceGroups(): Promise<FaceGroup[]> {
        const db = await getDatabase();
        return db.getAllAsync<FaceGroup>(
            'SELECT * FROM face_groups ORDER BY photo_count DESC, created_at DESC'
        );
    },

    /**
     * Get face instances for a specific asset
     */
    async getFacesByAsset(assetId: string): Promise<FaceInstance[]> {
        const db = await getDatabase();
        return db.getAllAsync<FaceInstance>(
            'SELECT * FROM face_instances WHERE asset_id = ?',
            [assetId]
        );
    },

    /**
     * Get all instances of a specific face (for clustering)
     */
    async getInstancesByFaceId(faceId: string): Promise<FaceInstance[]> {
        const db = await getDatabase();
        return db.getAllAsync<FaceInstance>(
            'SELECT * FROM face_instances WHERE face_id = ?',
            [faceId]
        );
    },

    /**
     * Update cluster ID for a face group
     */
    async updateClusterId(faceId: string, clusterId: number): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                'UPDATE face_groups SET cluster_id = ? WHERE face_id = ?',
                [clusterId, faceId]
            );
        });
    },

    /**
     * Increment photo count for a face group
     */
    async incrementPhotoCount(faceId: string): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                'UPDATE face_groups SET photo_count = photo_count + 1 WHERE face_id = ?',
                [faceId]
            );
        });
    },

    /**
     * Get face groups by cluster ID
     */
    async getFacesByCluster(clusterId: number): Promise<FaceGroup[]> {
        const db = await getDatabase();
        return db.getAllAsync<FaceGroup>(
            'SELECT * FROM face_groups WHERE cluster_id = ?',
            [clusterId]
        );
    },

    /**
     * Get statistics
     */
    async getStatistics(): Promise<{ totalFaces: number; totalClusters: number }> {
        const db = await getDatabase();
        const result = await db.getFirstAsync<{ totalFaces: number; totalClusters: number }>(
            `SELECT
                COUNT(DISTINCT face_id) as totalFaces,
                COUNT(DISTINCT cluster_id) as totalClusters
             FROM face_groups WHERE cluster_id IS NOT NULL`
        );
        return result || { totalFaces: 0, totalClusters: 0 };
    },
};
