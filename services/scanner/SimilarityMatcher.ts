/**
 * SimilarityMatcher - Finds similar photos using perceptual hashing
 */

import { AssetRepository } from '../../database';
import { DEFAULT_SIMILARITY_CONFIG, getImageOps, GrayImageRef, SimilarityConfig } from '../imageOps';

export interface SimilarityMatch {
    assetId: string;
    distance: number;
}

/**
 * Compute perceptual hash for an image
 */
export async function computePhash(assetUri: string): Promise<string> {
    const imageOps = getImageOps();
    let gray: GrayImageRef | null = null;

    try {
        gray = await imageOps.resizeToGray256(assetUri);
        return imageOps.computeDHash64(gray);
    } finally {
        if (gray) {
            imageOps.dispose(gray);
        }
    }
}

/**
 * Find similar photos within time window
 */
export async function findSimilarPhotos(
    targetPhash: string,
    targetTakenAt: number,
    config: SimilarityConfig = DEFAULT_SIMILARITY_CONFIG
): Promise<SimilarityMatch[]> {
    const imageOps = getImageOps();

    // Get recent done assets within time window
    const candidates = await AssetRepository.getRecentDoneAssets(
        targetTakenAt,
        config.timeWindowSeconds,
        config.maxCompareCount
    );

    const matches: SimilarityMatch[] = [];

    for (const candidate of candidates) {
        if (!candidate.phash) continue;

        const distance = imageOps.hammingDistance64(targetPhash, candidate.phash);

        if (distance < config.similarThreshold) {
            matches.push({
                assetId: candidate.asset_id,
                distance,
            });
        }
    }

    // Sort by distance (closest first)
    matches.sort((a, b) => a.distance - b.distance);

    return matches;
}

/**
 * Check if two hashes are similar
 */
export function areSimilar(
    hashA: string,
    hashB: string,
    threshold: number = DEFAULT_SIMILARITY_CONFIG.similarThreshold
): boolean {
    const imageOps = getImageOps();
    const distance = imageOps.hammingDistance64(hashA, hashB);
    return distance < threshold;
}
