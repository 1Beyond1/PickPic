/**
 * IImageOps Interface
 * Abstract interface for image processing operations.
 * Designed for future replacement with Native/JSI high-performance implementation.
 */

/**
 * Reference to a grayscale image in memory
 */
export interface GrayImageRef {
    width: number;
    height: number;
    /**
     * Pixel data as Uint8Array (grayscale, 0-255)
     * May be null if using native handle
     */
    data: Uint8Array | null;
    /**
     * Native handle for JSI implementation
     */
    nativeHandle?: number;
}

/**
 * Image processing operations interface
 */
export interface IImageOps {
    /**
     * Resize image to 256x256 grayscale
     * @param assetUri - URI or local path to the image
     * @returns GrayImageRef with pixel data
     */
    resizeToGray256(assetUri: string): Promise<GrayImageRef>;

    /**
     * Compute mean luminance (brightness) of grayscale image
     * @param gray - GrayImageRef from resizeToGray256
     * @returns Mean value 0-255
     */
    computeMeanLuma(gray: GrayImageRef): number;

    /**
     * Compute Laplacian variance (sharpness/blur measure)
     * Higher value = sharper image
     * @param gray - GrayImageRef from resizeToGray256
     * @returns Variance value
     */
    computeLaplacianVar(gray: GrayImageRef): number;

    /**
     * Compute 64-bit perceptual hash (dHash)
     * @param gray - GrayImageRef from resizeToGray256
     * @returns 16-character hex string (64 bits)
     */
    computeDHash64(gray: GrayImageRef): string;

    /**
     * Compute Hamming distance between two 64-bit hashes
     * @param hashA - First hash (16 hex chars)
     * @param hashB - Second hash (16 hex chars)
     * @returns Number of differing bits (0-64)
     */
    hammingDistance64(hashA: string, hashB: string): number;

    /**
     * Dispose/release a GrayImageRef
     * Important for native implementations to prevent memory leaks
     */
    dispose(gray: GrayImageRef): void;

    /**
     * Center crop the image to a square and resize to targetSize (default 224)
     * @param assetUri - Source image URI
     * @param width - Original image width
     * @param height - Original image height
     * @param targetSize - Output dimension (default 224)
     * @returns Path to cached processed image
     */
    centerCropSquare?(assetUri: string, width: number, height: number, targetSize?: number): Promise<string>;
}

/**
 * Blur detection configuration
 */
export interface BlurConfig {
    /**
     * Base threshold for Laplacian variance
     * Below this = blurry
     */
    baseThreshold: number;
    /**
     * Multiplier when image is too dark (meanLuma < darkThreshold)
     */
    darkMultiplier: number;
    /**
     * Threshold for "too dark"
     */
    darkThreshold: number;
    /**
     * Multiplier when image is too bright (meanLuma > brightThreshold)
     */
    brightMultiplier: number;
    /**
     * Threshold for "too bright"
     */
    brightThreshold: number;
}

export const DEFAULT_BLUR_CONFIG: BlurConfig = {
    baseThreshold: 100,
    darkMultiplier: 0.7,
    darkThreshold: 40,
    brightMultiplier: 0.7,
    brightThreshold: 220,
};

/**
 * Similarity matching configuration
 */
export interface SimilarityConfig {
    /**
     * Time window in seconds for comparing photos
     */
    timeWindowSeconds: number;
    /**
     * Maximum photos to compare against
     */
    maxCompareCount: number;
    /**
     * Hamming distance threshold for "similar"
     */
    similarThreshold: number;
}

export const DEFAULT_SIMILARITY_CONFIG: SimilarityConfig = {
    timeWindowSeconds: 120,
    maxCompareCount: 10,
    similarThreshold: 15, // Increased from 10 to allow more variations (e.g. text changes)
};
