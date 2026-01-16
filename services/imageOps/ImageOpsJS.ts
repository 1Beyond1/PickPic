/**
 * ImageOpsJS - JavaScript Fallback Implementation
 * 
 * IMPORTANT: This is a PLACEHOLDER implementation.
 * expo-image-manipulator cannot provide raw pixel data directly.
 * This implementation provides the interface structure and basic algorithms,
 * but the actual pixel extraction would require a native module.
 * 
 * For production, replace with:
 * - react-native-skia
 * - Custom native module with JSI
 * - WebAssembly-based solution
 */

import * as ImageManipulator from 'expo-image-manipulator';
import { GrayImageRef, IImageOps } from './IImageOps';

/**
 * JavaScript fallback implementation of IImageOps
 * Note: computeLaplacianVar returns placeholder values
 */
export class ImageOpsJS implements IImageOps {
    /**
     * Resize image to 256x256
     * Note: Cannot extract actual pixel data with expo-image-manipulator
     */
    async resizeToGray256(assetUri: string): Promise<GrayImageRef> {
        try {
            // Resize to 256x256 using expo-image-manipulator
            const result = await ImageManipulator.manipulateAsync(
                assetUri,
                [{ resize: { width: 256, height: 256 } }],
                { format: ImageManipulator.SaveFormat.JPEG, base64: true }
            );

            // Since we can't get actual pixel data, we'll use the base64 length
            // as a proxy for "image complexity" (very rough approximation)
            const base64 = result.base64 || '';

            // Create placeholder GrayImageRef
            // In a real implementation, this would contain actual pixel data
            return {
                width: 256,
                height: 256,
                data: null, // Cannot extract pixels in JS
                // Store base64 in a custom property for our approximations
                _base64: base64,
                _uri: result.uri,
            } as GrayImageRef & { _base64: string; _uri: string };
        } catch (error) {
            console.error('[ImageOpsJS] Failed to resize image:', error);
            throw error;
        }
    }

    /**
     * Compute mean luminance
     * PLACEHOLDER: Returns approximation based on base64 characteristics
     */
    computeMeanLuma(gray: GrayImageRef): number {
        const extended = gray as GrayImageRef & { _base64?: string };

        if (!extended._base64) {
            // Default to mid-range if no data
            return 128;
        }

        // Rough approximation: base64 entropy as proxy for brightness
        // This is NOT accurate but provides some differentiation
        const base64 = extended._base64;
        let sum = 0;
        const sampleSize = Math.min(1000, base64.length);

        for (let i = 0; i < sampleSize; i++) {
            sum += base64.charCodeAt(i);
        }

        // Normalize to 0-255 range
        const avg = sum / sampleSize;
        return Math.round(((avg - 43) / (122 - 43)) * 255);
    }

    /**
     * Compute Laplacian variance (blur detection)
     * PLACEHOLDER: Returns approximation based on base64 size
     */
    computeLaplacianVar(gray: GrayImageRef): number {
        const extended = gray as GrayImageRef & { _base64?: string };

        if (!extended._base64) {
            // Default to medium sharpness
            return 150;
        }

        // Rough approximation: 
        // Sharper images typically compress to larger base64 (more detail)
        // Blurry images compress to smaller base64 (less detail)
        const base64Length = extended._base64.length;

        // Expected range for 256x256 JPEG: ~5000-50000 bytes
        // Map to blur score range: 0-500
        const normalizedSize = (base64Length - 5000) / (50000 - 5000);
        const blurScore = Math.max(0, Math.min(500, normalizedSize * 500));

        return blurScore;
    }

    /**
     * Compute dHash (difference hash)
     * PLACEHOLDER: Returns hash based on base64 sampling
     */
    computeDHash64(gray: GrayImageRef): string {
        const extended = gray as GrayImageRef & { _base64?: string };

        if (!extended._base64) {
            return '0000000000000000';
        }

        const base64 = extended._base64;
        let hash = 0n;

        // Sample 64 positions throughout the base64 string
        // Compare adjacent samples to create difference hash
        const step = Math.floor(base64.length / 65);

        for (let i = 0; i < 64; i++) {
            const pos1 = i * step;
            const pos2 = (i + 1) * step;

            if (pos2 < base64.length) {
                const diff = base64.charCodeAt(pos1) < base64.charCodeAt(pos2);
                if (diff) {
                    hash |= (1n << BigInt(i));
                }
            }
        }

        // Convert to 16-character hex string
        return hash.toString(16).padStart(16, '0');
    }

    /**
     * Compute Hamming distance between two 64-bit hashes
     * This is accurate implementation
     */
    hammingDistance64(hashA: string, hashB: string): number {
        const a = BigInt('0x' + hashA);
        const b = BigInt('0x' + hashB);
        let xor = a ^ b;
        let count = 0;

        while (xor > 0n) {
            count += Number(xor & 1n);
            xor >>= 1n;
        }

        return count;
    }

    /**
     * Dispose/cleanup GrayImageRef
     */
    dispose(gray: GrayImageRef): void {
        // No-op for JS implementation
        // Native implementation would free native memory here
        const extended = gray as GrayImageRef & { _base64?: string; _uri?: string };
        extended._base64 = undefined;
        extended._uri = undefined;
        (gray as any).data = null;
    }

    /**
     * Center crop to square and resize to targetSize (default 224)
     */
    async centerCropSquare(assetUri: string, width: number, height: number, targetSize: number = 224): Promise<string> {
        const size = Math.min(width, height);
        const originX = (width - size) / 2;
        const originY = (height - size) / 2;

        try {
            const result = await ImageManipulator.manipulateAsync(
                assetUri,
                [
                    {
                        crop: {
                            originX,
                            originY,
                            width: size,
                            height: size
                        }
                    },
                    { resize: { width: targetSize, height: targetSize } }
                ],
                { format: ImageManipulator.SaveFormat.JPEG, compress: 0.8 }
            );
            return result.uri;
        } catch (error) {
            console.warn('[ImageOpsJS] Failed to crop image, using original:', error);
            return assetUri;
        }
    }
}

// Singleton instance
let instance: ImageOpsJS | null = null;

export function getImageOpsJS(): ImageOpsJS {
    if (!instance) {
        instance = new ImageOpsJS();
    }
    return instance;
}
