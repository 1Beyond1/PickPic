/**
 * Face Repository - Manages face detection data and clustering
 */

import { getDatabase } from '../db';

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
        const db = await getDatabase();
        const now = Date.now();

        await db.runAsync(
            `INSERT INTO face_groups (face_id, cluster_id, first_seen_asset_id, representative_uri, photo_count, created_at)
             VALUES (?, NULL, ?, ?, 1, ?)`,
            [faceId, firstSeenAssetId, representativeUri || null, now]
        );
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
        const db = await getDatabase();

        await db.runAsync(
            `INSERT INTO face_instances (instance_id, face_id, asset_id, bounding_box, confidence)
             VALUES (?, ?, ?, ?, ?)`,
            [instanceId, faceId, assetId, JSON.stringify(boundingBox), confidence]
        );
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
        const db = await getDatabase();
        await db.runAsync(
            'UPDATE face_groups SET cluster_id = ? WHERE face_id = ?',
            [clusterId, faceId]
        );
    },

    /**
     * Increment photo count for a face group
     */
    async incrementPhotoCount(faceId: string): Promise<void> {
        const db = await getDatabase();
        await db.runAsync(
            'UPDATE face_groups SET photo_count = photo_count + 1 WHERE face_id = ?',
            [faceId]
        );
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
