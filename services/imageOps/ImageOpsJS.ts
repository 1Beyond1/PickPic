/**
 * ImageOpsJS - JavaScript Fallback Implementation
 * 
 * The image manipulator produces a small JPEG and jpeg-js decodes it into
 * actual RGBA pixels. The calculations below therefore operate on image data,
 * rather than on Base64 length or encoded characters.
 */

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import * as jpeg from 'jpeg-js';
import { Platform } from 'react-native';
import { LocalPrivacyError, usePrivacyStore } from '../../stores/usePrivacyStore';
import { GrayImageRef, IImageOps } from './IImageOps';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let quickBase64Decoder: ((b64: string, removeLinebreaks?: boolean) => Uint8Array) | null | undefined;

function getQuickBase64Decoder(): ((b64: string, removeLinebreaks?: boolean) => Uint8Array) | null {
    if (quickBase64Decoder !== undefined) return quickBase64Decoder;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('react-native-quick-base64') as {
            toByteArray?: (b64: string, removeLinebreaks?: boolean) => Uint8Array;
        };
        quickBase64Decoder = typeof mod?.toByteArray === 'function' ? mod.toByteArray : null;
    } catch {
        quickBase64Decoder = null;
    }
    return quickBase64Decoder;
}

function base64ToBytesPortable(base64: string): Uint8Array {
    const normalized = base64.replace(/[^A-Za-z0-9+/=]/g, '');
    const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
    const output = new Uint8Array(Math.max(0, Math.floor((normalized.length * 3) / 4) - padding));

    let accumulator = 0;
    let bits = 0;
    let offset = 0;

    for (const character of normalized) {
        if (character === '=') break;

        const value = BASE64_ALPHABET.indexOf(character);
        if (value < 0) continue;

        accumulator = (accumulator << 6) | value;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            if (offset < output.length) {
                output[offset++] = (accumulator >> bits) & 0xff;
            }
        }
    }

    return output;
}

function base64ToBytes(value: string): Uint8Array {
    const base64 = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
    const nativeDecode = getQuickBase64Decoder();
    if (nativeDecode) {
        try {
            return nativeDecode(base64, true);
        } catch {
            // Fall back to portable JS decoding when native bindings are unavailable (e.g. Jest/Web).
        }
    }
    return base64ToBytesPortable(base64);
}

export class ImageOpsJS implements IImageOps {
    /**
     * Decode a resized JPEG into a 256x256 grayscale pixel buffer.
     */
    async resizeToGray256(assetUri: string): Promise<GrayImageRef> {
        let resizedUri: string | null = null;

        try {
            const result = await ImageManipulator.manipulateAsync(
                assetUri,
                [{ resize: { width: 256, height: 256 } }],
                { format: ImageManipulator.SaveFormat.JPEG, base64: true, compress: 0.85 }
            );
            resizedUri = result.uri;

            if (!result.base64) {
                throw new Error('Image resize did not return Base64 data');
            }

            const decoded = jpeg.decode(base64ToBytes(result.base64), { useTArray: true });
            if (!decoded.width || !decoded.height || decoded.data.length < decoded.width * decoded.height * 4) {
                throw new Error('Decoded image has invalid pixel data');
            }

            // ImageManipulator normally already returns 256x256. Keep this
            // resampling step defensive in case a platform returns another size.
            const grayscale = new Uint8Array(256 * 256);
            for (let y = 0; y < 256; y++) {
                const sourceY = Math.min(decoded.height - 1, Math.floor((y * decoded.height) / 256));
                for (let x = 0; x < 256; x++) {
                    const sourceX = Math.min(decoded.width - 1, Math.floor((x * decoded.width) / 256));
                    const sourceIndex = (sourceY * decoded.width + sourceX) * 4;
                    const alpha = decoded.data[sourceIndex + 3] ?? 255;
                    const red = decoded.data[sourceIndex] ?? 0;
                    const green = decoded.data[sourceIndex + 1] ?? 0;
                    const blue = decoded.data[sourceIndex + 2] ?? 0;
                    const luma = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
                    const composited = (luma * alpha + 255 * (255 - alpha)) / 255;
                    grayscale[y * 256 + x] = Math.round(composited);
                }
            }

            return { width: 256, height: 256, data: grayscale };
        } finally {
            if (resizedUri && resizedUri !== assetUri) {
                await FileSystem.deleteAsync(resizedUri, { idempotent: true }).catch(() => {
                    if (Platform.OS !== 'web') {
                        usePrivacyStore.getState().block('cache', 'read');
                        throw new LocalPrivacyError();
                    }
                });
            }
        }
    }

    /**
     * Compute mean luminance from grayscale pixels.
     */
    computeMeanLuma(gray: GrayImageRef): number {
        if (!gray.data || gray.data.length === 0) {
            throw new Error('Cannot compute luminance without pixel data');
        }

        let sum = 0;
        for (const pixel of gray.data) {
            sum += pixel;
        }

        return sum / gray.data.length;
    }

    /**
     * Compute Laplacian variance (sharpness/blur measure).
     */
    computeLaplacianVar(gray: GrayImageRef): number {
        const data = gray.data;
        if (!data || data.length === 0) {
            throw new Error('Cannot compute sharpness without pixel data');
        }

        let sum = 0;
        let sumSquares = 0;
        let count = 0;

        for (let y = 1; y < gray.height - 1; y++) {
            for (let x = 1; x < gray.width - 1; x++) {
                const index = y * gray.width + x;
                const laplacian =
                    data[index - 1] +
                    data[index + 1] +
                    data[index - gray.width] +
                    data[index + gray.width] -
                    (4 * data[index]);

                sum += laplacian;
                sumSquares += laplacian * laplacian;
                count++;
            }
        }

        if (count === 0) return 0;
        const mean = sum / count;
        return Math.max(0, (sumSquares / count) - (mean * mean));
    }

    /**
     * Compute a 64-bit dHash using a 9x8 area/box-average downsampled grid.
     * Averaging each cell across the 256x256 grayscale buffer makes the hash
     * resilient to single-pixel shifts and sensor noise without extra native calls.
     */
    computeDHash64(gray: GrayImageRef): string {
        const data = gray.data;
        if (!data || data.length === 0 || gray.width <= 0 || gray.height <= 0) {
            throw new Error('Cannot compute perceptual hash without pixel data');
        }

        const grid = new Float64Array(9 * 8);

        for (let gy = 0; gy < 8; gy++) {
            const yStart = Math.min(gray.height - 1, Math.floor((gy * gray.height) / 8));
            const yEnd = Math.min(gray.height, Math.max(yStart + 1, Math.floor(((gy + 1) * gray.height) / 8)));
            for (let gx = 0; gx < 9; gx++) {
                const xStart = Math.min(gray.width - 1, Math.floor((gx * gray.width) / 9));
                const xEnd = Math.min(gray.width, Math.max(xStart + 1, Math.floor(((gx + 1) * gray.width) / 9)));
                let sum = 0;
                let count = 0;
                for (let py = yStart; py < yEnd; py++) {
                    const rowOffset = py * gray.width;
                    for (let px = xStart; px < xEnd; px++) {
                        sum += data[rowOffset + px];
                        count++;
                    }
                }
                grid[(gy * 9) + gx] = count > 0 ? sum / count : 0;
            }
        }

        let hash = 0n;

        for (let y = 0; y < 8; y++) {
            const rowOffset = y * 9;
            for (let x = 0; x < 8; x++) {
                if (grid[rowOffset + x] < grid[rowOffset + x + 1]) {
                    hash |= (1n << BigInt((y * 8) + x));
                }
            }
        }

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
        gray.data = null;
    }

    /**
     * Center crop to square and resize to targetSize (default 224).
     * Falls back to a direct resize when dimensions are unavailable or EXIF
     * rotation causes the crop rectangle to fall out of bounds.
     */
    async centerCropSquare(assetUri: string, width: number, height: number, targetSize: number = 224): Promise<string> {
        const target = Math.max(1, Math.round(targetSize));
        const hasValidDimensions = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;

        if (hasValidDimensions) {
            const safeWidth = Math.max(1, Math.floor(width));
            const safeHeight = Math.max(1, Math.floor(height));
            const size = Math.min(safeWidth, safeHeight);
            const originX = Math.floor((safeWidth - size) / 2);
            const originY = Math.floor((safeHeight - size) / 2);

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
                        { resize: { width: target, height: target } }
                    ],
                    { format: ImageManipulator.SaveFormat.JPEG, compress: 0.8 }
                );
                return result.uri;
            } catch {
                // EXIF-rotated photos may swap decoded width/height relative to
                // metadata, causing the crop rectangle to fall out of bounds.
                // Fall through to direct downscaling so 48-200MP originals are
                // never forwarded raw to TFLite/ML Kit.
            }
        }

        try {
            const resized = await ImageManipulator.manipulateAsync(
                assetUri,
                [{ resize: { width: target, height: target } }],
                { format: ImageManipulator.SaveFormat.JPEG, compress: 0.8 }
            );
            return resized.uri;
        } catch {
            console.warn('[ImageOpsJS] Failed to crop or resize image, using original.');
            return assetUri;
        }
    }

    /**
     * Downscale large photos proportionally so the longest edge is at most
     * maxDimension (default 1024px) before native face detection.
     */
    async resizeForFaceDetection(
        assetUri: string,
        width: number,
        height: number,
        maxDimension: number = 1024,
    ): Promise<{ uri: string; width: number; height: number }> {
        const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
        const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;
        const limit = Math.max(1, Math.floor(maxDimension));
        if (!safeWidth || !safeHeight || Math.max(safeWidth, safeHeight) <= limit) {
            return { uri: assetUri, width: safeWidth, height: safeHeight };
        }

        const resizeAction = safeWidth >= safeHeight
            ? { resize: { width: limit } }
            : { resize: { height: limit } };

        try {
            const result = await ImageManipulator.manipulateAsync(
                assetUri,
                [resizeAction],
                { format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 },
            );
            const scaledWidth = Number.isFinite(result.width) && result.width > 0
                ? result.width
                : (safeWidth >= safeHeight ? limit : Math.max(1, Math.round((safeWidth * limit) / safeHeight)));
            const scaledHeight = Number.isFinite(result.height) && result.height > 0
                ? result.height
                : (safeHeight > safeWidth ? limit : Math.max(1, Math.round((safeHeight * limit) / safeWidth)));
            return { uri: result.uri, width: scaledWidth, height: scaledHeight };
        } catch {
            console.warn('[ImageOpsJS] Failed to resize image for face detection, using original.');
            return { uri: assetUri, width: safeWidth, height: safeHeight };
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
