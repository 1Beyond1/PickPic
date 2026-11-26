import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import * as jpeg from 'jpeg-js';
import { ImageOpsJS } from '../../services/imageOps/ImageOpsJS';
import { usePrivacyStore } from '../../stores/usePrivacyStore';

// SDK 54's root export throws for these legacy methods. Keep the mocks
// distinct so importing the wrong module cannot silently pass cleanup tests.
jest.mock('expo-file-system', () => ({
    deleteAsync: jest.fn(async () => { throw new Error('Unsupported legacy method'); }),
}));
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn(async () => undefined) }));
jest.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: jest.fn(),
}));
jest.mock('jpeg-js', () => ({ decode: jest.fn() }));

const manipulate = jest.mocked(ImageManipulator.manipulateAsync);
const decode = jest.mocked(jpeg.decode);
const remove = jest.mocked(FileSystem.deleteAsync);

describe('scan grayscale temporary image cleanup', () => {
    beforeEach(() => {
        usePrivacyStore.setState({ failures: {} });
        manipulate.mockResolvedValue({ uri: 'file:///cache/gray.jpg', width: 1, height: 1, base64: 'AA==' });
        decode.mockReturnValue({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) } as ReturnType<typeof jpeg.decode>);
    });

    it('cleans the generated image after successful decoding, not the source photo', async () => {
        const gray = await new ImageOpsJS().resizeToGray256('file:///photos/source.jpg');
        expect(gray.data?.[0]).toBe(255);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('file:///cache/gray.jpg', { idempotent: true });
    });

    it('also cleans the generated image if decoding fails', async () => {
        decode.mockImplementationOnce(() => { throw new Error('Invalid JPEG'); });
        await expect(new ImageOpsJS().resizeToGray256('file:///photos/source.jpg')).rejects.toThrow('Invalid JPEG');
        expect(remove).toHaveBeenCalledWith('file:///cache/gray.jpg', { idempotent: true });
    });

    it('never removes the original if the manipulator returns its URI', async () => {
        manipulate.mockResolvedValueOnce({ uri: 'file:///photos/source.jpg', width: 1, height: 1, base64: 'AA==' });
        await new ImageOpsJS().resizeToGray256('file:///photos/source.jpg');
        expect(remove).not.toHaveBeenCalled();
    });

    it('blocks further private processing if a generated plaintext copy cannot be removed', async () => {
        remove.mockRejectedValueOnce(new Error('PRIVATE_CACHE_PATH_DELETE_FAILURE'));
        await expect(new ImageOpsJS().resizeToGray256('file:///photos/source.jpg')).rejects.toThrow('original data was preserved');
        expect(usePrivacyStore.getState().failures.cache).toBe('read');
        expect(remove).toHaveBeenCalledWith('file:///cache/gray.jpg', { idempotent: true });
    });

    it('uses integer crop coordinates in centerCropSquare for odd dimensions', async () => {
        manipulate.mockResolvedValueOnce({ uri: 'file:///cache/crop.jpg', width: 300, height: 300 });
        const uri = await new ImageOpsJS().centerCropSquare('file:///photos/odd.jpg', 1001, 701, 300);
        expect(uri).toBe('file:///cache/crop.jpg');
        expect(manipulate).toHaveBeenCalledWith(
            'file:///photos/odd.jpg',
            [
                { crop: { originX: 150, originY: 0, width: 701, height: 701 } },
                { resize: { width: 300, height: 300 } },
            ],
            { format: ImageManipulator.SaveFormat.JPEG, compress: 0.8 },
        );
    });

    it('downscales oversized images to <= 1024px longest edge for face detection and skips small ones', async () => {
        const ops = new ImageOpsJS();
        const small = await ops.resizeForFaceDetection('file:///photos/small.jpg', 800, 600, 1024);
        expect(small).toEqual({ uri: 'file:///photos/small.jpg', width: 800, height: 600 });
        expect(manipulate).not.toHaveBeenCalled();

        manipulate.mockResolvedValueOnce({ uri: 'file:///cache/face-1024.jpg', width: 1024, height: 768 });
        const largeLandscape = await ops.resizeForFaceDetection('file:///photos/48mp.jpg', 8000, 6000, 1024);
        expect(largeLandscape).toEqual({ uri: 'file:///cache/face-1024.jpg', width: 1024, height: 768 });
        expect(manipulate).toHaveBeenCalledWith(
            'file:///photos/48mp.jpg',
            [{ resize: { width: 1024 } }],
            { format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 },
        );

        manipulate.mockResolvedValueOnce({ uri: 'file:///cache/face-portrait.jpg', width: 768, height: 1024 });
        const largePortrait = await ops.resizeForFaceDetection('file:///photos/portrait.jpg', 3000, 4000, 1024);
        expect(largePortrait).toEqual({ uri: 'file:///cache/face-portrait.jpg', width: 768, height: 1024 });
        expect(manipulate).toHaveBeenLastCalledWith(
            'file:///photos/portrait.jpg',
            [{ resize: { height: 1024 } }],
            { format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 },
        );
    });

    it('P1-5: computes 9x8 box-average dHash resilient to 1px shift and single-pixel impulse noise', () => {
        const ops = new ImageOpsJS();
        const width = 256;
        const height = 256;

        // Create a smooth multi-region luminance pattern (simulating a natural photo).
        const makePattern = (shiftX = 0, shiftY = 0) => {
            const data = new Uint8Array(width * height);
            for (let y = 0; y < height; y++) {
                const sy = Math.min(height - 1, Math.max(0, y + shiftY));
                for (let x = 0; x < width; x++) {
                    const sx = Math.min(width - 1, Math.max(0, x + shiftX));
                    const wave = Math.sin((sx / width) * Math.PI * 3) * 60 + Math.cos((sy / height) * Math.PI * 2) * 50;
                    data[y * width + x] = Math.max(0, Math.min(255, Math.round(128 + wave)));
                }
            }
            return { width, height, data };
        };

        const base = makePattern(0, 0);
        const shifted1px = makePattern(1, 1);
        const noisy = makePattern(0, 0);
        // Corrupt exact cell top-left sampling pixels (which old single-pixel dHash sampled!).
        for (let gy = 0; gy < 8; gy++) {
            const sy = Math.floor((gy * height) / 8);
            for (let gx = 0; gx < 9; gx++) {
                const sx = Math.floor((gx * width) / 9);
                noisy.data[sy * width + sx] = gx % 2 === 0 ? 255 : 0;
            }
        }

        const baseHash = ops.computeDHash64(base);
        const shiftedHash = ops.computeDHash64(shifted1px);
        const noisyHash = ops.computeDHash64(noisy);

        expect(baseHash).toMatch(/^[0-9a-f]{16}$/);
        // Box-average downsampling keeps both 1px-shifted and single-pixel-corrupted variants nearly identical.
        expect(ops.hammingDistance64(baseHash, shiftedHash)).toBeLessThanOrEqual(2);
        expect(ops.hammingDistance64(baseHash, noisyHash)).toBe(0);
    });

    it('P1-6: centerCropSquare falls back to direct target resize when EXIF-rotated crop fails instead of returning huge original', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            manipulate.mockClear();
            manipulate
                .mockRejectedValueOnce(new Error('Crop rectangle out of bounds after EXIF rotation'))
                .mockResolvedValueOnce({ uri: 'file:///cache/resized-300.jpg', width: 300, height: 300 });

            const uri = await new ImageOpsJS().centerCropSquare('file:///photos/48mp-exif.jpg', 8000, 6000, 300);

            expect(uri).toBe('file:///cache/resized-300.jpg');
            expect(manipulate).toHaveBeenCalledTimes(2);
            expect(manipulate).toHaveBeenNthCalledWith(
                2,
                'file:///photos/48mp-exif.jpg',
                [{ resize: { width: 300, height: 300 } }],
                { format: ImageManipulator.SaveFormat.JPEG, compress: 0.8 },
            );

            // When metadata dimensions are missing (0), skip crop and resize directly.
            manipulate.mockClear();
            manipulate.mockResolvedValueOnce({ uri: 'file:///cache/direct-300.jpg', width: 300, height: 300 });
            const zeroDimUri = await new ImageOpsJS().centerCropSquare('file:///photos/nodims.jpg', 0, 0, 300);
            expect(zeroDimUri).toBe('file:///cache/direct-300.jpg');
            expect(manipulate).toHaveBeenCalledTimes(1);
            expect(manipulate).toHaveBeenCalledWith(
                'file:///photos/nodims.jpg',
                [{ resize: { width: 300, height: 300 } }],
                { format: ImageManipulator.SaveFormat.JPEG, compress: 0.8 },
            );

            // Only if both crop and resize fail does it fall back to original URI.
            manipulate.mockClear();
            manipulate
                .mockRejectedValueOnce(new Error('Crop failed'))
                .mockRejectedValueOnce(new Error('Resize failed'));
            const fallbackUri = await new ImageOpsJS().centerCropSquare('file:///photos/corrupt.jpg', 1000, 800, 300);
            expect(fallbackUri).toBe('file:///photos/corrupt.jpg');
        } finally {
            warnSpy.mockRestore();
        }
    });
});
