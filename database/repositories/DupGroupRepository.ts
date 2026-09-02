/**
 * Duplicate Group Repository - Manages similar photo groups
 */

import * as SQLite from 'expo-sqlite';
import { getDatabase, withTransaction } from '../db';
import { AssetStatus } from '../schema';
import { chooseBestShotAssetId } from '../bestShotScoring';
import type { BestShotAsset } from '../bestShotScoring';

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

interface DuplicateGroupRepairOptions {
    /** Keep one-member groups as recovery seeds for a scoped scan. */
    removeSingletonGroups?: boolean;
}

async function getBestShotAssetIdInDatabase(
    db: SQLite.SQLiteDatabase,
    groupId: string,
): Promise<string | null> {
    const candidates = await db.getAllAsync<BestShotAsset>(
        `SELECT member.asset_id, asset.width, asset.height,
                asset.blur_score, asset.mean_luma
         FROM dup_members AS member
         JOIN assets AS asset ON asset.asset_id = member.asset_id
         WHERE member.group_id = ?
           AND asset.status = ?
         ORDER BY member.distance ASC, member.asset_id ASC`,
        [groupId, AssetStatus.DONE]
    );
    return chooseBestShotAssetId(candidates);
}

/**
 * Restore the duplicate-group invariants after members are removed or after
 * repairing data written by an older app version. A group represents at least
 * two assets; its representative and best-shot pointers must also reference a
 * remaining member. Only completed assets are valid members: invalidating an
 * asset commits its PENDING/ERROR status before the follow-up index cleanup,
 * so the repair must also cover a crash between those transactions.
 */
export async function repairDuplicateGroupsInDatabase(
    db: SQLite.SQLiteDatabase,
    options: DuplicateGroupRepairOptions = {}
): Promise<void> {
    await db.runAsync(
        `DELETE FROM dup_members AS member
         WHERE NOT EXISTS (
                   SELECT 1 FROM dup_groups AS group_row
                   WHERE group_row.group_id = member.group_id
               )
            OR NOT EXISTS (
                   SELECT 1 FROM assets AS asset
                   WHERE asset.asset_id = member.asset_id
                     AND asset.status = ?
               )
            `,
        [AssetStatus.DONE]
    );
    if (options.removeSingletonGroups !== false) {
        await db.runAsync(
            `DELETE FROM dup_members
             WHERE group_id IN (
                 SELECT group_id FROM dup_members
                 GROUP BY group_id
                 HAVING COUNT(*) < 2
             )`
        );
    }
    await db.runAsync(
        `DELETE FROM dup_groups AS group_row
         WHERE NOT EXISTS (
             SELECT 1 FROM dup_members AS member
             WHERE member.group_id = group_row.group_id
         )`
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
             ) ELSE representative_asset_id END`
    );

    // A missing/invalid best-shot pointer must be rebuilt with the same image
    // quality score used after a normal scan. Distance describes similarity
    // to the group representative, not which photo is the best to keep.
    const groupsNeedingBestShot = await db.getAllAsync<{ group_id: string }>(
        `SELECT group_row.group_id
         FROM dup_groups AS group_row
         WHERE group_row.best_asset_id IS NULL
            OR NOT EXISTS (
                SELECT 1 FROM dup_members AS member
                WHERE member.group_id = group_row.group_id
                  AND member.asset_id = group_row.best_asset_id
            )`
    );
    for (const group of groupsNeedingBestShot) {
        const bestAssetId = await getBestShotAssetIdInDatabase(db, group.group_id);
        if (bestAssetId === null) continue;
        await db.runAsync(
            'UPDATE dup_groups SET best_asset_id = ? WHERE group_id = ?',
            [bestAssetId, group.group_id]
        );
    }
}

async function removeAssetsFromGroupsInDatabase(
    db: SQLite.SQLiteDatabase,
    assetIds: readonly string[],
    preserveSingletonGroups: boolean,
    markForWiderDuplicateScan: boolean
): Promise<void> {
    const affectedGroupIds = new Set<string>();
    const affectedAssetIds = new Set<string>();

    // Keep batches below SQLite's bind-parameter limit and remember only the
    // groups/assets touched by this scoped invalidation.
    for (let i = 0; i < assetIds.length; i += 500) {
        const batch = assetIds.slice(i, i + 500);
        const placeholders = batch.map(() => '?').join(', ');
        const groups = await db.getAllAsync<{ group_id: string; asset_id: string }>(
            `SELECT DISTINCT group_id, asset_id FROM dup_members
             WHERE asset_id IN (${placeholders})`,
            batch
        );
        groups.forEach(group => {
            affectedGroupIds.add(group.group_id);
            affectedAssetIds.add(group.asset_id);
        });

        await db.runAsync(
            `DELETE FROM dup_members WHERE asset_id IN (${placeholders})`,
            batch
        );
    }

    if (markForWiderDuplicateScan && affectedAssetIds.size > 0) {
        const affectedIds = Array.from(affectedAssetIds);
        for (let i = 0; i < affectedIds.length; i += 500) {
            const batch = affectedIds.slice(i, i + 500);
            const placeholders = batch.map(() => '?').join(', ');
            await db.runAsync(
                `UPDATE assets
                 SET needs_duplicate_recovery = 1
                 WHERE asset_id IN (${placeholders})`,
                batch
            );
        }
    }

    for (const groupId of affectedGroupIds) {
        // A scoped scan may leave an inaccessible/out-of-scope completed
        // member as the only remaining member. Remove other invalid rows, but
        // preserve that singleton so a later wider scan can reconnect it.
        await db.runAsync(
            `DELETE FROM dup_members AS member
             WHERE member.group_id = ?
               AND (
                   NOT EXISTS (
                       SELECT 1 FROM dup_groups AS group_row
                       WHERE group_row.group_id = member.group_id
                   )
                   OR NOT EXISTS (
                       SELECT 1 FROM assets AS asset
                       WHERE asset.asset_id = member.asset_id
                         AND asset.status = ?
                   )
               )`,
            [groupId, AssetStatus.DONE]
        );

        const members = await db.getAllAsync<DupMember>(
            'SELECT * FROM dup_members WHERE group_id = ? ORDER BY distance ASC',
            [groupId]
        );
        const group = await db.getFirstAsync<DupGroup>(
            'SELECT * FROM dup_groups WHERE group_id = ?',
            [groupId]
        );

        if (!group) {
            await db.runAsync('DELETE FROM dup_members WHERE group_id = ?', [groupId]);
            continue;
        }

        if (members.length === 0) {
            await db.runAsync('DELETE FROM dup_groups WHERE group_id = ?', [groupId]);
            continue;
        }

        if (!preserveSingletonGroups && members.length < 2) {
            await db.runAsync('DELETE FROM dup_members WHERE group_id = ?', [groupId]);
            await db.runAsync('DELETE FROM dup_groups WHERE group_id = ?', [groupId]);
            continue;
        }

        const memberIds = new Set(members.map(member => member.asset_id));
        const representativeAssetId = memberIds.has(group.representative_asset_id ?? '')
            ? group.representative_asset_id
            : members[0].asset_id;
        const bestAssetId = memberIds.has(group.best_asset_id ?? '')
            ? group.best_asset_id
            : await getBestShotAssetIdInDatabase(db, groupId);

        await db.runAsync(
            `UPDATE dup_groups
             SET representative_asset_id = ?, best_asset_id = ?
             WHERE group_id = ?`,
            [representativeAssetId, bestAssetId ?? members[0].asset_id, groupId]
        );
    }
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

/**
 * Connect a completed asset and its matches inside a caller-owned
 * transaction. Keeping this primitive separate lets the scanner commit the
 * asset result and its duplicate membership as one recovery unit.
 */
export async function addAssetToMatchingGroupsInDatabase(
    db: SQLite.SQLiteDatabase,
    assetId: string,
    matches: readonly SimilarityCandidate[],
    newGroupId: string,
    preserveSingletonGroups = false
): Promise<string | null> {
    if (matches.length === 0) return null;

    const existingGroupIds = new Set<string>();
    const candidateAssetIds = Array.from(new Set([
        assetId,
        ...matches.map(match => match.assetId),
    ]));
    const placeholders = candidateAssetIds.map(() => '?').join(', ');
    const existingAssets = await db.getAllAsync<{ asset_id: string }>(
        `SELECT asset_id FROM assets
         WHERE status = ? AND asset_id IN (${placeholders})`,
        [AssetStatus.DONE, ...candidateAssetIds]
    );
    const existingAssetIds = new Set(existingAssets.map(asset => asset.asset_id));

    // Matching runs after an earlier read. A user deletion or scan failure
    // may have changed either side in that gap, so never recreate a duplicate
    // member for an asset that is no longer a completed local record.
    if (!existingAssetIds.has(assetId)) return null;
    const validMatches = matches.filter(match => existingAssetIds.has(match.assetId));
    if (validMatches.length === 0) return null;

    // Clean up rows left by older non-transactional group writes before
    // selecting a target group. Scoped scans retain one-member groups as
    // recovery seeds for assets outside the current scan scope.
    await repairDuplicateGroupsInDatabase(db, {
        removeSingletonGroups: !preserveSingletonGroups,
    });

    const relatedAssetIds = [assetId, ...validMatches.map(match => match.assetId)];

    // The scanned asset can already belong to a stale/legacy group. Include
    // it when collecting groups so the whole connected set is merged instead
    // of leaving the asset in overlapping groups.
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

    // A match may have been a standalone completed asset. Add every such
    // match, rather than dropping it when another match already supplied an
    // existing target group.
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

    const closestDistance = Math.min(...validMatches.map(match => match.distance));
    const existingTargetMember = await db.getFirstAsync<{ distance: number }>(
        'SELECT distance FROM dup_members WHERE group_id = ? AND asset_id = ?',
        [targetGroupId, assetId]
    );

    // Legacy/overlapping groups may already contain the scanned asset. Never
    // replace a better persisted distance with a worse result from a later
    // comparison.
    if (!existingTargetMember) {
        await db.runAsync(
            'INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)',
            [targetGroupId, assetId, closestDistance]
        );
    } else if (closestDistance < existingTargetMember.distance) {
        await db.runAsync(
            'UPDATE dup_members SET distance = ? WHERE group_id = ? AND asset_id = ?',
            [closestDistance, targetGroupId, assetId]
        );
    }

    return targetGroupId;
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
            'SELECT * FROM dup_members WHERE group_id = ? ORDER BY distance ASC, asset_id ASC',
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
                   )
                   AND EXISTS (
                       SELECT 1 FROM assets
                       WHERE assets.asset_id = ?
                   )`,
                [bestAssetId, groupId, bestAssetId, bestAssetId]
            );
        });
    },

    /**
     * Get all groups (for UI display). Repair legacy rows before exposing the
     * index so an interrupted older write cannot remain invisible forever.
     */
    async getAllGroups(): Promise<DupGroup[]> {
        return withTransaction(async db => {
            // Keep one-member groups as recovery seeds for a later wider
            // permission/album scan, but expose only actionable groups to UI
            // callers. The regular delete/cleanup paths still remove
            // singletons when the media is genuinely gone.
            await repairDuplicateGroupsInDatabase(db, { removeSingletonGroups: false });
            return db.getAllAsync<DupGroup>(
                `SELECT * FROM dup_groups
                 WHERE group_id IN (
                     SELECT group_id FROM dup_members
                     GROUP BY group_id
                     HAVING COUNT(*) >= 2
                 )
                 ORDER BY created_at DESC`
            );
        });
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
        newGroupId: string,
        preserveSingletonGroups = false
    ): Promise<string | null> {
        return withTransaction(async db => {
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
    async removeAssetFromGroups(
        assetId: string,
        preserveSingletonGroups = false,
        markForWiderDuplicateScan = preserveSingletonGroups
    ): Promise<void> {
        await this.removeAssetsFromGroups(
            [assetId],
            preserveSingletonGroups,
            markForWiderDuplicateScan
        );
    },

    /**
     * Remove several assets from duplicate groups without clearing unrelated
     * groups. A scoped invalidation can also mark the affected assets for a
     * later wider comparison when the caller enables that recovery flag.
     */
    async removeAssetsFromGroups(
        assetIds: readonly string[],
        preserveSingletonGroups = false,
        markForWiderDuplicateScan = preserveSingletonGroups
    ): Promise<void> {
        const uniqueAssetIds = Array.from(new Set(assetIds));
        if (uniqueAssetIds.length === 0) return;

        await withTransaction(async db => {
            await removeAssetsFromGroupsInDatabase(
                db,
                uniqueAssetIds,
                preserveSingletonGroups,
                markForWiderDuplicateScan
            );
        });
    },
};
