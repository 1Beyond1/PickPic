/**
 * MLBridge - Headless component bridging Class-based AIScanner with Hook-based ML Kit
 */

import { FaceDetectionProvider } from '@infinitered/react-native-mlkit-face-detection';
import { useImageLabeling, useImageLabelingModels, useImageLabelingProvider } from '@infinitered/react-native-mlkit-image-labeling';
import { memo, useEffect, useRef, useState } from 'react';
import { IMAGENET_LABELS } from '../services/ml/ImageNetLabels';
import type { DetectedFace, ImageLabel } from '../services/ml/MLKitService';
import { useFaceDetector } from '../services/ml/useFaceDetector';

// Event-based communication bridge
type MLRequest = {
    id: string;
    type: 'detectFaces' | 'labelImage';
    imageUri: string;
    resolve: (result: any) => void;
    reject: (error: Error) => void;
};

class MLBridgeQueue {
    private queue: MLRequest[] = [];
    private isReady = false;

    markReady() {
        this.isReady = true;
    }

    markUnavailable() {
        this.isReady = false;
    }

    push(request: MLRequest) {
        this.queue.push(request);
    }

    shift(): MLRequest | undefined {
        return this.queue.shift();
    }

    hasWork(): boolean {
        return this.queue.length > 0;
    }

    cancel(requestId: string): boolean {
        const index = this.queue.findIndex(request => request.id === requestId);
        if (index === -1) return false;

        this.queue.splice(index, 1);
        return true;
    }

    isAvailable(): boolean {
        return this.isReady;
    }
}

// Global singleton
export const mlBridgeQueue = new MLBridgeQueue();

// Keep the model configuration stable. The image-labeling package loads its
// asset list once but reacts to the configuration object in its model-loading
// effect. Recreating this object on every render would repeatedly register the
// same native model and can cause an endless load/render loop.
const IMAGE_LABELING_MODELS = {
    efficientnet: {
        // Expo requires a statically analyzable require for bundled TFLite assets.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        model: require('../assets/ml/efficientnet-lite4.tflite'),
        options: {
            maxResultCount: 5,
            confidenceThreshold: 0.4, // EfficientNet is more precise, 0.4 is good
        },
    },
};

/**
 * Inner component that processes requests
 */
function MLBridgeInner() {
    const [currentRequest, setCurrentRequest] = useState<MLRequest | null>(null);
    const requestStartTimeRef = useRef<number>(0);

    // Face Detection
    // Use the detector directly instead of useFacesInPhoto. The package hook
    // converts the native detector's `undefined` failure result into
    // `done + []`, which is indistinguishable from a successful no-face
    // result. The queue must reject that request so the scanner retries it.
    const faceDetector = useFaceDetector();

    // Image Labeling
    const labeler = useImageLabeling('efficientnet');

    // The queue becomes available only after the labeling hook has a usable
    // model. This prevents requests from being accepted during model startup.
    useEffect(() => {
        if (!labeler) {
            mlBridgeQueue.markUnavailable();
            return;
        }

        mlBridgeQueue.markReady();
        console.log('[MLBridge] Ready state set');

        return () => mlBridgeQueue.markUnavailable();
    }, [labeler]);

    // Poll for new requests
    useEffect(() => {
        const interval = setInterval(() => {
            // Check for stuck request (timeout > 10s)
            if (currentRequest && Date.now() - requestStartTimeRef.current > 10000) {
                const timedOutRequest = currentRequest;
                console.warn('[MLBridge] Request timed out internally:', timedOutRequest.id);
                timedOutRequest.reject(new Error('Internal Bridge Timeout'));
                setCurrentRequest(activeRequest => (
                    activeRequest?.id === timedOutRequest.id ? null : activeRequest
                ));
                return;
            }

            if (currentRequest || !mlBridgeQueue.hasWork()) return;

            const request = mlBridgeQueue.shift();
            if (request) {
                console.log('[MLBridge] Dequeue:', request.type, request.id);
                requestStartTimeRef.current = Date.now();
                setCurrentRequest(request);
            }
        }, 100);
        return () => clearInterval(interval);
    }, [currentRequest]);

    // Process Face Detection results
    useEffect(() => {
        if (!currentRequest || currentRequest.type !== 'detectFaces') return;

        const request = currentRequest;
        let active = true;

        (async () => {
            try {
                const result = await faceDetector.detectFaces(request.imageUri);
                if (!active) return;

                // RNMLKitFaceDetector returns undefined when its native module
                // rejects. A valid result always contains the faces array.
                if (!result || !Array.isArray(result.faces)) {
                    throw new Error('Face detection failed');
                }

                console.log('[MLBridge] Face detection done, count:', result.faces.length);
                const detectedFaces: DetectedFace[] = result.faces.map((face) => ({
                    boundingBox: {
                        x: face.frame.origin.x,
                        y: face.frame.origin.y,
                        width: face.frame.size.x,
                        height: face.frame.size.y,
                    },
                    confidence: 0.85,
                }));
                request.resolve(detectedFaces);
            } catch (error) {
                if (!active) return;
                console.error('[MLBridge] Face detection error:', error);
                request.reject(error instanceof Error ? error : new Error(String(error)));
            } finally {
                if (active) {
                    setCurrentRequest(activeRequest => (
                        activeRequest?.id === request.id ? null : activeRequest
                    ));
                }
            }
        })();

        return () => {
            active = false;
        };
    }, [currentRequest, faceDetector]);

    // Process Image Labeling results
    useEffect(() => {
        if (!currentRequest || currentRequest.type !== 'labelImage' || !labeler) return;

        console.log('[MLBridge] Starting label classification');
        (async () => {
            try {
                const result = await labeler.classifyImage(currentRequest.imageUri);
                console.log('[MLBridge] Label success, found:', result.length);
                if (result.length > 0) {
                    console.log('[MLBridge] Sample result item:', JSON.stringify(result[0]));
                }
                const labels: ImageLabel[] = result.map((item: any) => ({
                    text: (item.text && item.text.length > 0) ? item.text : (IMAGENET_LABELS[item.index] ?? 'Unknown'),
                    confidence: item.confidence,
                }));

                currentRequest.resolve(labels);
                setCurrentRequest(activeRequest => (
                    activeRequest?.id === currentRequest.id ? null : activeRequest
                ));
            } catch (error) {
                console.error('[MLBridge] Image labeling error:', error);
                currentRequest.reject(error as Error);
                setCurrentRequest(activeRequest => (
                    activeRequest?.id === currentRequest.id ? null : activeRequest
                ));
            }
        })();
    }, [currentRequest, labeler]);

    return null;
}

/**
 * MLBridge - Must be mounted at app root
 */
// RootLayout rerenders when navigation and app-level state change. The
// provider hook creates its provider component inside the hook, so allowing
// this no-prop bridge to rerender would remount MLBridgeInner and abandon an
// in-flight native request. Keep the bridge subtree mounted for its lifetime.
export const MLBridge = memo(function MLBridge() {
    const models = useImageLabelingModels(IMAGE_LABELING_MODELS);

    const { ImageLabelingModelProvider } = useImageLabelingProvider(models);

    return (
        <FaceDetectionProvider>
            <ImageLabelingModelProvider>
                <MLBridgeInner />
            </ImageLabelingModelProvider>
        </FaceDetectionProvider>
    );
});

