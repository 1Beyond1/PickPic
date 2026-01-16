/**
 * BlurDetector - Detects blurry images using Laplacian variance
 */

import { BlurConfig, DEFAULT_BLUR_CONFIG, getImageOps, GrayImageRef } from '../imageOps';

export interface BlurResult {
    blurScore: number;
    meanLuma: number;
    isBlurry: boolean;
    adjustedThreshold: number;
}

/**
 * Detect blur in an image
 */
export async function detectBlur(
    assetUri: string,
    config: BlurConfig = DEFAULT_BLUR_CONFIG
): Promise<BlurResult> {
    const imageOps = getImageOps();
    let gray: GrayImageRef | null = null;

    try {
        // Resize to 256x256 grayscale
        gray = await imageOps.resizeToGray256(assetUri);

        // Compute metrics
        const meanLuma = imageOps.computeMeanLuma(gray);
        const blurScore = imageOps.computeLaplacianVar(gray);

        // Adjust threshold based on lighting conditions
        let adjustedThreshold = config.baseThreshold;

        if (meanLuma < config.darkThreshold) {
            // Too dark - lower threshold (dark images appear less sharp)
            adjustedThreshold *= config.darkMultiplier;
        } else if (meanLuma > config.brightThreshold) {
            // Too bright - lower threshold (overexposed images appear less sharp)
            adjustedThreshold *= config.brightMultiplier;
        }

        const isBlurry = blurScore < adjustedThreshold;

        return {
            blurScore,
            meanLuma,
            isBlurry,
            adjustedThreshold,
        };
    } finally {
        if (gray) {
            imageOps.dispose(gray);
        }
    }
}

/**
 * Compute blur score only (without full result)
 */
export async function computeBlurScore(assetUri: string): Promise<{ blurScore: number; meanLuma: number }> {
    const imageOps = getImageOps();
    let gray: GrayImageRef | null = null;

    try {
        gray = await imageOps.resizeToGray256(assetUri);
        return {
            blurScore: imageOps.computeLaplacianVar(gray),
            meanLuma: imageOps.computeMeanLuma(gray),
        };
    } finally {
        if (gray) {
            imageOps.dispose(gray);
        }
    }
}
