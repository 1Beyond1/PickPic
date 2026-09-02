/**
 * Shared best-shot scoring primitives.
 *
 * Duplicate-group repair can run without the scanner service, so the scoring
 * rule lives in the database layer and is reused by both paths. Keeping one
 * implementation prevents recovery from choosing a different photo than a
 * normal scan would choose.
 */

export interface BestShotAsset {
    asset_id: string;
    width: number | null;
    height: number | null;
    blur_score: number | null;
    mean_luma: number | null;
}

export interface BestShotScoreBreakdown {
    resolution: number;
    sharpness: number;
    lighting: number;
}

/**
 * Calculate the same score used by the scanner's best-shot selector.
 * Higher score means a better photo.
 */
export function calculateBestShotBreakdown(
    asset: BestShotAsset,
): BestShotScoreBreakdown {
    const pixels = (asset.width ?? 0) * (asset.height ?? 0);
    const resolutionScore = pixels > 0 ? Math.log10(pixels) * 10 : 0;

    const blurScore = asset.blur_score ?? 0;
    const sharpnessScore = Math.min(blurScore, 500) / 5;

    const luma = asset.mean_luma ?? 128;
    const lumaDiff = Math.abs(luma - 140);
    const lightingScore = Math.max(0, 40 - lumaDiff);

    return {
        resolution: resolutionScore,
        sharpness: sharpnessScore,
        lighting: lightingScore,
    };
}

export function calculateBestShotScore(asset: BestShotAsset): number {
    const breakdown = calculateBestShotBreakdown(asset);
    return breakdown.resolution + breakdown.sharpness + breakdown.lighting;
}

/**
 * Pick the highest-scoring candidate. The caller supplies a deterministic
 * order for exact-score ties; preserving the first candidate matches the
 * scanner's stable sort behavior.
 */
export function chooseBestShotAssetId(
    assets: readonly BestShotAsset[],
): string | null {
    let bestAsset: BestShotAsset | null = null;
    let bestScore = -Infinity;

    for (const asset of assets) {
        const score = calculateBestShotScore(asset);
        if (bestAsset === null || score > bestScore) {
            bestAsset = asset;
            bestScore = score;
        }
    }

    return bestAsset?.asset_id ?? null;
}
