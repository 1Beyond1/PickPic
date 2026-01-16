/**
 * Duplicate Group Repository - Manages similar photo groups
 */

import { getDatabase } from '../db';

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

export const DupGroupRepository = {
    /**
     * Create a new duplicate group
     */
    async createGroup(
        groupId: string,
        representativeAssetId: string
    ): Promise<void> {
        const db = await getDatabase();
        const now = Date.now();

        await db.runAsync(
            `INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at)
       VALUES (?, ?, NULL, ?)`,
            [groupId, representativeAssetId, now]
        );
    },

    /**
     * Add member to a group
     */
    async addMember(groupId: string, assetId: string, distance: number): Promise<void> {
        const db = await getDatabase();
        await db.runAsync(
            `INSERT OR REPLACE INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)`,
            [groupId, assetId, distance]
        );
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
        const db = await getDatabase();
        await db.runAsync(
            'UPDATE dup_groups SET best_asset_id = ? WHERE group_id = ?',
            [bestAssetId, groupId]
        );
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
        const db = await getDatabase();
        await db.runAsync('DELETE FROM dup_members WHERE group_id = ?', [groupId]);
        await db.runAsync('DELETE FROM dup_groups WHERE group_id = ?', [groupId]);
    },

    /**
     * Merge two groups (move all members from source to target)
     */
    async mergeGroups(targetGroupId: string, sourceGroupId: string): Promise<void> {
        const db = await getDatabase();

        // Move members from source to target
        await db.runAsync(
            `UPDATE dup_members SET group_id = ? WHERE group_id = ?`,
            [targetGroupId, sourceGroupId]
        );

        // Delete source group
        await db.runAsync('DELETE FROM dup_groups WHERE group_id = ?', [sourceGroupId]);
    },
    /**
     * Delete ALL groups and members (Clean reset)
     */
    async deleteAll(): Promise<void> {
        const db = await getDatabase();
        await db.runAsync('DELETE FROM dup_members');
        await db.runAsync('DELETE FROM dup_groups');
    },
};
