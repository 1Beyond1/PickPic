import { useFaceDetection } from '@infinitered/react-native-mlkit-face-detection';
import type { FaceDetectorLike } from './useFaceDetector';

export function useFaceDetector(): FaceDetectorLike {
    return useFaceDetection();
}
