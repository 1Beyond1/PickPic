import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import * as jpeg from 'jpeg-js';
import { ImageOpsJS } from '../../services/imageOps/ImageOpsJS';

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
});
