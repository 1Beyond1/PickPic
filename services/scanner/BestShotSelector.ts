/**
 * BestShotSelector - Selects the best photo from a duplicate group
 */

import { AssetRepository, DupGroupRepository } from '../../database';
import type { AssetRecord } from '../../database';
import {
    calculateBestShotBreakdown,
    calculateBestShotScore,
    chooseBestShotAssetId,
} from '../../database/bestShotScoring';

export interface ScoredAsset {
    asset: AssetRecord;
    score: number;
    scoreBreakdown: {
        resolution: number;
        sharpness: number;
        lighting: number;
    };
}

/**
 * Calculate score for a single asset
 * Higher score = better photo
 */
export function calculateScore(asset: AssetRecord): ScoredAsset {
    const scoreBreakdown = calculateBestShotBreakdown(asset);
    const totalScore = calculateBestShotScore(asset);

    return {
        asset,
        score: totalScore,
        scoreBreakdown,
    };
}

/**
 * Select best shot from a duplicate group
 */
export async function selectBestShot(groupId: string): Promise<string | null> {
    // Get all members of the group
    const members = await DupGroupRepository.getGroupMembers(groupId);

    if (members.length === 0) {
        return null;
    }

    // Fetch full asset records
    const assets: AssetRecord[] = [];
    for (const member of members) {
        const asset = await AssetRepository.getById(member.asset_id);
        if (asset) {
            assets.push(asset);
        }
    }

    if (assets.length === 0) {
        return null;
    }

    // Select with the same deterministic score/order used by database repair.
    const bestAssetId = chooseBestShotAssetId(assets);
    if (bestAssetId === null) return null;

    // Update group's best_asset_id
    await DupGroupRepository.updateBestAsset(groupId, bestAssetId);

    return bestAssetId;
}

/**
 * Recalculate best shots for all groups
 */
export async function recalculateAllBestShots(): Promise<number> {
    const groups = await DupGroupRepository.getAllGroups();
    let updated = 0;

    for (const group of groups) {
        const bestId = await selectBestShot(group.group_id);
        if (bestId && bestId !== group.best_asset_id) {
            updated++;
        }
    }

    return updated;
}
