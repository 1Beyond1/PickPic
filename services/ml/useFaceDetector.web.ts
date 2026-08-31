import type { FaceDetectorLike } from './useFaceDetector';

const unavailableFaceDetector: FaceDetectorLike = {
    detectFaces: async () => undefined,
};

export function useFaceDetector(): FaceDetectorLike {
    return unavailableFaceDetector;
}
