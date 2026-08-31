/**
 * MLBridge - Headless component bridging Class-based AIScanner with Hook-based ML Kit
 */

import { FaceDetectionProvider, useFacesInPhoto } from '@infinitered/react-native-mlkit-face-detection';
import { useImageLabeling, useImageLabelingModels, useImageLabelingProvider } from '@infinitered/react-native-mlkit-image-labeling';
import { useEffect, useRef, useState } from 'react';
import { IMAGENET_LABELS } from '../services/ml/ImageNetLabels';
import type { DetectedFace, ImageLabel } from '../services/ml/MLKitService';

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
    const faceRequestIdRef = useRef<string | null>(null);
    const faceRequestReadyRef = useRef(false);

    // Face Detection
    const { faces, error: faceError, status: faceStatus } = useFacesInPhoto(
        currentRequest?.type === 'detectFaces' ? currentRequest.imageUri : undefined
    );

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

        if (faceRequestIdRef.current !== currentRequest.id) {
            faceRequestIdRef.current = currentRequest.id;
            faceRequestReadyRef.current = false;
        }

        // useFacesInPhoto keeps its previous result while a new URI is being
        // applied. Do not consume a stale done/error state until this request
        // has visibly entered its own detection phase.
        if (faceStatus === 'detecting') {
            faceRequestReadyRef.current = true;
        }
        if (!faceRequestReadyRef.current) return;

        console.log('[MLBridge] Face Status:', faceStatus, 'Error:', faceError);

        if (faceError) {
            console.error('[MLBridge] Face detection error:', faceError);
            currentRequest.reject(new Error(faceError));
            setCurrentRequest(activeRequest => (
                activeRequest?.id === currentRequest.id ? null : activeRequest
            ));
            return;
        }

        if (faceStatus === 'done') {
            console.log('[MLBridge] Face detection done, count:', faces.length);
            const detectedFaces: DetectedFace[] = faces.map((face) => ({
                boundingBox: {
                    x: face.frame.origin.x,
                    y: face.frame.origin.y,
                    width: face.frame.size.x,
                    height: face.frame.size.y,
                },
                confidence: 0.85,
            }));
            currentRequest.resolve(detectedFaces);
            setCurrentRequest(activeRequest => (
                activeRequest?.id === currentRequest.id ? null : activeRequest
            ));
        }
    }, [faces, faceError, faceStatus, currentRequest]);

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
export function MLBridge() {
    const models = useImageLabelingModels(IMAGE_LABELING_MODELS);

    const { ImageLabelingModelProvider } = useImageLabelingProvider(models);

    return (
        <FaceDetectionProvider>
            <ImageLabelingModelProvider>
                <MLBridgeInner />
            </ImageLabelingModelProvider>
        </FaceDetectionProvider>
    );
}

