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
});
