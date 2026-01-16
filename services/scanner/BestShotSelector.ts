/**
 * BestShotSelector - Selects the best photo from a duplicate group
 */

import { AssetRecord, AssetRepository, DupGroupRepository } from '../../database';

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
    // Resolution score: log10(width * height) * 10
    // e.g., 4000x3000 = 7 * 10 = 70
    const pixels = (asset.width ?? 0) * (asset.height ?? 0);
    const resolutionScore = pixels > 0 ? Math.log10(pixels) * 10 : 0;

    // Sharpness score: blur_score capped at 500, normalized to 0-100
    const blurScore = asset.blur_score ?? 0;
    const sharpnessScore = Math.min(blurScore, 500) / 5;

    // Lighting score: prefer mean_luma around 140 (sweet spot)
    // Max 40 points, decreases as luma deviates from 140
    const luma = asset.mean_luma ?? 128;
    const lumaDiff = Math.abs(luma - 140);
    const lightingScore = Math.max(0, 40 - lumaDiff);

    const totalScore = resolutionScore + sharpnessScore + lightingScore;

    return {
        asset,
        score: totalScore,
        scoreBreakdown: {
            resolution: resolutionScore,
            sharpness: sharpnessScore,
            lighting: lightingScore,
        },
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

    // Score all assets
    const scored = assets.map(calculateScore);

    // Find highest score
    scored.sort((a, b) => b.score - a.score);
    const bestAssetId = scored[0].asset.asset_id;

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
