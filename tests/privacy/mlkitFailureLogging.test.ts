/** @jest-environment node */
const mockNative = { initialize: jest.fn(), detectFaces: jest.fn() };
jest.mock('expo-modules-core', () => ({ requireNativeModule: () => mockNative }));

const { RNMLKitFaceDetector } = require('../../node_modules/@infinitered/react-native-mlkit-face-detection/build/module/RNMLKitFaceDetector');

it('retains SDK detection failure behavior without logging the native private URI', async () => {
    const marker = 'PRIVATE_FACE_IMAGE_URI';
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockNative.detectFaces.mockRejectedValueOnce(new Error(marker));
    const detector = new RNMLKitFaceDetector(undefined, true);
    await expect(detector.detectFaces('file:///synthetic-face.jpg')).resolves.toBeUndefined();
    expect(detector.status).toBe('error');
    expect(mockNative.detectFaces).toHaveBeenCalledWith('file:///synthetic-face.jpg');
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().map(value => value instanceof Error ? value.message : String(value)).join('\n')).not.toContain(marker);
});

it('keeps successful native results and initialization state unchanged', async () => {
    mockNative.initialize.mockResolvedValueOnce(undefined);
    const result = { faces: [{ bounds: { width: 5 } }] };
    mockNative.detectFaces.mockResolvedValueOnce(result);
    const detector = new RNMLKitFaceDetector(undefined, true);
    await detector.initialize();
    expect(detector.status).toBe('ready');
    await expect(detector.detectFaces('file:///synthetic-face.jpg')).resolves.toBe(result);
    expect(detector.status).toBe('done');
});
