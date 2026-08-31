/**
 * Duplicate Group Repository - Manages similar photo groups
 */

import * as SQLite from 'expo-sqlite';
import { getDatabase, withTransaction } from '../db';

export interface DupGroup {
    group_id: string;
    representative_asset_id: string | null;
    best_asset_id: string | null;
    created_at: number;
}

export interface DupMember {
    group_id: string;
    asset_id: string;
    distance: number;
}

export interface SimilarityCandidate {
    assetId: string;
    distance: number;
}

/**
 * Restore the duplicate-group invariants after members are removed or after
 * repairing data written by an older app version. A group represents at least
 * two assets; its representative and best-shot pointers must also reference a
 * remaining member.
 */
export async function repairDuplicateGroupsInDatabase(
    db: SQLite.SQLiteDatabase
): Promise<void> {
    await db.runAsync(
        `DELETE FROM dup_members
         WHERE group_id NOT IN (SELECT group_id FROM dup_groups)
            OR group_id IN (
                SELECT group_id FROM dup_members
                GROUP BY group_id
                HAVING COUNT(*) < 2
            )`
    );
    await db.runAsync(
        'DELETE FROM dup_groups WHERE group_id NOT IN (SELECT DISTINCT group_id FROM dup_members)'
    );
    await db.runAsync(
        `UPDATE dup_groups
         SET representative_asset_id = CASE
             WHEN representative_asset_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM dup_members
                 WHERE dup_members.group_id = dup_groups.group_id
                   AND dup_members.asset_id = dup_groups.representative_asset_id
             ) THEN (
                 SELECT asset_id FROM dup_members
                 WHERE dup_members.group_id = dup_groups.group_id
                 ORDER BY distance ASC, asset_id ASC
                 LIMIT 1
             ) ELSE representative_asset_id END,
             best_asset_id = CASE
             WHEN best_asset_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM dup_members
                 WHERE dup_members.group_id = dup_groups.group_id
                   AND dup_members.asset_id = dup_groups.best_asset_id
             ) THEN (
                 SELECT asset_id FROM dup_members
                 WHERE dup_members.group_id = dup_groups.group_id
                 ORDER BY distance ASC, asset_id ASC
                 LIMIT 1
             ) ELSE best_asset_id END`
    );
}

async function removeAssetsFromGroupsInDatabase(
    db: SQLite.SQLiteDatabase,
    assetIds: readonly string[]
): Promise<void> {
    // Keep batches below SQLite's bind-parameter limit.
    for (let i = 0; i < assetIds.length; i += 500) {
        const batch = assetIds.slice(i, i + 500);
        const placeholders = batch.map(() => '?').join(', ');
        await db.runAsync(
            `DELETE FROM dup_members WHERE asset_id IN (${placeholders})`,
            batch
        );
    }

    await repairDuplicateGroupsInDatabase(db);
}

async function mergeGroupsInDatabase(
    db: SQLite.SQLiteDatabase,
    targetGroupId: string,
    sourceGroupId: string
): Promise<void> {
    if (targetGroupId === sourceGroupId) return;

    const sourceMembers = await db.getAllAsync<DupMember>(
        'SELECT asset_id, distance FROM dup_members WHERE group_id = ?',
        [sourceGroupId]
    );

    for (const member of sourceMembers) {
        const targetMember = await db.getFirstAsync<{ distance: number }>(
            'SELECT distance FROM dup_members WHERE group_id = ? AND asset_id = ?',
            [targetGroupId, member.asset_id]
        );

        if (!targetMember) {
            await db.runAsync(
                'INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)',
                [targetGroupId, member.asset_id, member.distance]
            );
        } else if (member.distance < targetMember.distance) {
            await db.runAsync(
                'UPDATE dup_members SET distance = ? WHERE group_id = ? AND asset_id = ?',
                [member.distance, targetGroupId, member.asset_id]
            );
        }
    }

    await db.runAsync('DELETE FROM dup_members WHERE group_id = ?', [sourceGroupId]);
    await db.runAsync('DELETE FROM dup_groups WHERE group_id = ?', [sourceGroupId]);
}

export const DupGroupRepository = {
    /**
     * Create a new duplicate group
     */
    async createGroup(
        groupId: string,
        representativeAssetId: string
    ): Promise<void> {
        await withTransaction(async db => {
            const now = Date.now();
            await db.runAsync(
                `INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at)
       VALUES (?, ?, NULL, ?)`,
                [groupId, representativeAssetId, now]
            );
        });
    },

    /**
     * Add member to a group
     */
    async addMember(groupId: string, assetId: string, distance: number): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                `INSERT OR REPLACE INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)`,
                [groupId, assetId, distance]
            );
        });
    },

    /**
     * Get group by ID
     */
    async getGroupById(groupId: string): Promise<DupGroup | null> {
        const db = await getDatabase();
        return db.getFirstAsync<DupGroup>(
            'SELECT * FROM dup_groups WHERE group_id = ?',
            [groupId]
        );
    },

    /**
     * Find group that an asset belongs to
     */
    async findGroupByAssetId(assetId: string): Promise<string | null> {
        const db = await getDatabase();
        const result = await db.getFirstAsync<{ group_id: string }>(
            'SELECT group_id FROM dup_members WHERE asset_id = ?',
            [assetId]
        );
        return result?.group_id ?? null;
    },

    /**
     * Find every group that contains an asset. In normal operation an asset
     * belongs to one group, but older scans can leave overlapping groups.
     */
    async findGroupIdsByAssetId(assetId: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.getAllAsync<{ group_id: string }>(
            'SELECT group_id FROM dup_members WHERE asset_id = ?',
            [assetId]
        );
        return rows.map(row => row.group_id);
    },

    /**
     * Get all members of a group
     */
    async getGroupMembers(groupId: string): Promise<DupMember[]> {
        const db = await getDatabase();
        return db.getAllAsync<DupMember>(
            'SELECT * FROM dup_members WHERE group_id = ? ORDER BY distance ASC',
            [groupId]
        );
    },

    /**
     * Update best_asset_id for a group
     */
    async updateBestAsset(groupId: string, bestAssetId: string): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                `UPDATE dup_groups SET best_asset_id = ?
                 WHERE group_id = ?
                   AND EXISTS (
                       SELECT 1 FROM dup_members
                       WHERE dup_members.group_id = dup_groups.group_id
                         AND dup_members.asset_id = ?
                   )`,
                [bestAssetId, groupId, bestAssetId]
            );
        });
    },

    /**
     * Get all groups (for UI display)
     */
    async getAllGroups(): Promise<DupGroup[]> {
        const db = await getDatabase();
        return db.getAllAsync<DupGroup>(
            'SELECT * FROM dup_groups ORDER BY created_at DESC'
        );
    },

    /**
     * Delete a group and its members
     */
    async deleteGroup(groupId: string): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync('DELETE FROM dup_members WHERE group_id = ?', [groupId]);
            await db.runAsync('DELETE FROM dup_groups WHERE group_id = ?', [groupId]);
        });
    },

    /**
     * Merge two groups (move all members from source to target)
     */
    async mergeGroups(targetGroupId: string, sourceGroupId: string): Promise<void> {
        if (targetGroupId === sourceGroupId) return;

        await withTransaction(async db => {
            await mergeGroupsInDatabase(db, targetGroupId, sourceGroupId);
        });
    },

    /**
     * Atomically connect a scanned asset and every standalone match to one
     * target group, merging any existing groups along the way.
     */
    async addAssetToMatchingGroups(
        assetId: string,
        matches: readonly SimilarityCandidate[],
        newGroupId: string
    ): Promise<string | null> {
        if (matches.length === 0) return null;

        return withTransaction(async db => {
            const existingGroupIds = new Set<string>();
            const candidateAssetIds = Array.from(new Set([
                assetId,
                ...matches.map(match => match.assetId),
            ]));
            const placeholders = candidateAssetIds.map(() => '?').join(', ');
            const existingAssets = await db.getAllAsync<{ asset_id: string }>(
                `SELECT asset_id FROM assets WHERE asset_id IN (${placeholders})`,
                candidateAssetIds
            );
            const existingAssetIds = new Set(existingAssets.map(asset => asset.asset_id));

            // Matching runs after an earlier read. A user deletion may have
            // committed its index cleanup in that gap, so never recreate a
            // duplicate member for an asset that no longer exists locally.
            if (!existingAssetIds.has(assetId)) return null;
            const validMatches = matches.filter(match => existingAssetIds.has(match.assetId));
            if (validMatches.length === 0) return null;
            const relatedAssetIds = [assetId, ...validMatches.map(match => match.assetId)];

            // The scanned asset can already belong to a stale/legacy group.
            // Include it when collecting groups so the whole connected set is
            // merged instead of leaving the asset in overlapping groups.
            for (const relatedAssetId of relatedAssetIds) {
                const rows = await db.getAllAsync<{ group_id: string }>(
                    'SELECT group_id FROM dup_members WHERE asset_id = ?',
                    [relatedAssetId]
                );
                rows.forEach(row => existingGroupIds.add(row.group_id));
            }

            const firstExistingGroupId = existingGroupIds.values().next().value as string | undefined;
            const targetGroupId = firstExistingGroupId ?? newGroupId;

            if (!firstExistingGroupId) {
                await db.runAsync(
                    `INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at)
                     VALUES (?, ?, NULL, ?)`,
                    [targetGroupId, validMatches[0].assetId, Date.now()]
                );
            }

            for (const groupId of existingGroupIds) {
                if (groupId !== targetGroupId) {
                    await mergeGroupsInDatabase(db, targetGroupId, groupId);
                }
            }

            // A match may have been a standalone completed asset. Add every
            // such match, rather than dropping it when another match already
            // supplied an existing target group.
            for (const match of validMatches) {
                const memberDistance = !firstExistingGroupId && match.assetId === validMatches[0].assetId
                    ? 0
                    : match.distance;
                const existingMember = await db.getFirstAsync<{ distance: number }>(
                    'SELECT distance FROM dup_members WHERE group_id = ? AND asset_id = ?',
                    [targetGroupId, match.assetId]
                );

                if (!existingMember) {
                    await db.runAsync(
                        'INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)',
                        [targetGroupId, match.assetId, memberDistance]
                    );
                } else if (memberDistance < existingMember.distance) {
                    await db.runAsync(
                        'UPDATE dup_members SET distance = ? WHERE group_id = ? AND asset_id = ?',
                        [memberDistance, targetGroupId, match.assetId]
                    );
                }
            }

            const closestDistance = validMatches[0].distance;
            await db.runAsync(
                'INSERT OR REPLACE INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)',
                [targetGroupId, assetId, closestDistance]
            );

            return targetGroupId;
        });
    },
    /**
     * Delete ALL groups and members (Clean reset)
     */
    async deleteAll(): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync('DELETE FROM dup_members');
            await db.runAsync('DELETE FROM dup_groups');
        });
    },

    /**
     * Remove an asset whose file contents changed from existing groups and
     * repair the affected representatives/best-shot references.
     */
    async removeAssetFromGroups(assetId: string): Promise<void> {
        await this.removeAssetsFromGroups([assetId]);
    },

    /**
     * Remove several assets from duplicate groups without clearing unrelated
     * groups. This is used when a scoped scan invalidates only part of the
     * local index.
     */
    async removeAssetsFromGroups(assetIds: readonly string[]): Promise<void> {
        const uniqueAssetIds = Array.from(new Set(assetIds));
        if (uniqueAssetIds.length === 0) return;

        await withTransaction(async db => {
            await removeAssetsFromGroupsInDatabase(db, uniqueAssetIds);
        });
    },
};
