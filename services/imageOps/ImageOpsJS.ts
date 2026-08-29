/**
 * ImageOpsJS - JavaScript Fallback Implementation
 * 
 * The image manipulator produces a small JPEG and jpeg-js decodes it into
 * actual RGBA pixels. The calculations below therefore operate on image data,
 * rather than on Base64 length or encoded characters.
 */

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import * as jpeg from 'jpeg-js';
import { GrayImageRef, IImageOps } from './IImageOps';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(value: string): Uint8Array {
    const base64 = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
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
                await FileSystem.deleteAsync(resizedUri, { idempotent: true }).catch(() => undefined);
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
     * Compute a 64-bit dHash from an 9x8 grayscale sampling grid.
     */
    computeDHash64(gray: GrayImageRef): string {
        const data = gray.data;
        if (!data || data.length === 0) {
            throw new Error('Cannot compute perceptual hash without pixel data');
        }

        let hash = 0n;

        for (let y = 0; y < 8; y++) {
            const sourceY = Math.min(gray.height - 1, Math.floor((y * gray.height) / 8));
            for (let x = 0; x < 8; x++) {
                const leftX = Math.min(gray.width - 1, Math.floor((x * gray.width) / 9));
                const rightX = Math.min(gray.width - 1, Math.floor(((x + 1) * gray.width) / 9));
                const left = data[sourceY * gray.width + leftX];
                const right = data[sourceY * gray.width + rightX];

                if (left < right) {
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
