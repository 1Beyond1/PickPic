/**
 * MLBridge - Headless component bridging Class-based AIScanner with Hook-based ML Kit
 */

import { FaceDetectionProvider } from '@infinitered/react-native-mlkit-face-detection';
import { useImageLabeling, useImageLabelingModels, useImageLabelingProvider } from '@infinitered/react-native-mlkit-image-labeling';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { IMAGENET_LABELS } from '../services/ml/ImageNetLabels';
import type { DetectedFace, ImageLabel } from '../services/ml/MLKitService';
import { useFaceDetector } from '../services/ml/useFaceDetector';

export const ML_REQUEST_TIMEOUT_MS = 10000;

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
    private workListeners = new Set<() => void>();
    private cancelListeners = new Set<(requestId: string) => void>();
    private readyListeners = new Set<() => void>();

    readonly timeoutMs = ML_REQUEST_TIMEOUT_MS;

    private notifyWork() {
        for (const listener of this.workListeners) {
            listener();
        }
    }

    markReady() {
        const wasReady = this.isReady;
        this.isReady = true;
        if (!wasReady) {
            for (const listener of this.readyListeners) {
                listener();
            }
        }
        if (this.queue.length > 0) {
            this.notifyWork();
        }
    }

    markUnavailable() {
        this.isReady = false;
    }

    push(request: MLRequest) {
        this.queue.push(request);
        this.notifyWork();
    }

    shift(): MLRequest | undefined {
        return this.queue.shift();
    }

    hasWork(): boolean {
        return this.queue.length > 0;
    }

    cancel(requestId: string): boolean {
        const index = this.queue.findIndex(request => request.id === requestId);
        if (index !== -1) {
            this.queue.splice(index, 1);
            return true;
        }

        for (const listener of this.cancelListeners) {
            listener(requestId);
        }
        return false;
    }

    subscribe(listener: () => void): () => void {
        this.workListeners.add(listener);
        return () => {
            this.workListeners.delete(listener);
        };
    }

    onCancel(listener: (requestId: string) => void): () => void {
        this.cancelListeners.add(listener);
        return () => {
            this.cancelListeners.delete(listener);
        };
    }

    subscribeReady(listener: () => void): () => void {
        this.readyListeners.add(listener);
        return () => {
            this.readyListeners.delete(listener);
        };
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
            // Keep alternatives for ambiguity checks. Display grouping uses
            // the strongest actual score, without adding competing classes.
            confidenceThreshold: 0.1,
        },
    },
};

/**
 * Inner component that processes requests
 */
function MLBridgeInner() {
    const [currentRequest, setCurrentRequest] = useState<MLRequest | null>(null);
    const currentRequestRef = useRef<MLRequest | null>(null);
    currentRequestRef.current = currentRequest;

    // Face Detection
    // Use the detector directly instead of useFacesInPhoto. The package hook
    // converts the native detector's `undefined` failure result into
    // `done + []`, which is indistinguishable from a successful no-face
    // result. The queue must reject that request so the scanner retries it.
    const faceDetector = useFaceDetector();
    const faceDetectorRef = useRef(faceDetector);
    faceDetectorRef.current = faceDetector;
    const faceDetectorStatus = faceDetector.status;

    // Image Labeling
    const labeler = useImageLabeling('efficientnet');
    const labelerRef = useRef(labeler);
    labelerRef.current = labeler;

    // Only mark unavailable when the bridge actually unmounts, not whenever
    // faceDetector changes status between 'ready', 'detecting', and 'done'.
    useEffect(() => {
        return () => {
            mlBridgeQueue.markUnavailable();
        };
    }, []);

    // The queue becomes available only after both native ML components are
    // ready. The face detector initializes independently from the labeler;
    // accepting a request as soon as the labeler is loaded can otherwise send
    // detectFaces to iOS while its native detector is still being created.
    useEffect(() => {
        let readyCheck: ReturnType<typeof setInterval> | null = null;
        let didBecomeReady = false;

        const checkReadiness = () => {
            let modelReady = false;
            const currentLabeler = labelerRef.current;
            const labelerState = currentLabeler as unknown as {
                isLoaded?: boolean | (() => boolean);
            } | undefined;

            try {
                const loadedState = labelerState?.isLoaded;
                modelReady = typeof loadedState === 'function'
                    ? loadedState.call(currentLabeler)
                    : loadedState === true;
            } catch {
                console.warn('[MLBridge] Failed to check model readiness.');
            }

            const status = faceDetectorRef.current.status;
            const faceDetectorReady = status === 'ready'
                || status === 'detecting'
                || status === 'done';

            if (!modelReady || !faceDetectorReady) {
                mlBridgeQueue.markUnavailable();
                return;
            }

            mlBridgeQueue.markReady();
            if (!didBecomeReady) {
                didBecomeReady = true;
                if (readyCheck) {
                    clearInterval(readyCheck);
                    readyCheck = null;
                }
                console.log('[MLBridge] Ready state set');
            }
        };

        checkReadiness();
        if (!didBecomeReady) {
            readyCheck = setInterval(checkReadiness, 100);
        }

        return () => {
            if (readyCheck) clearInterval(readyCheck);
        };
    }, [labeler, faceDetectorStatus]);

    // Event-driven dispatch: wake immediately when work arrives or when the
    // active request finishes, with zero idle polling timers.
    const dispatchNext = useCallback(() => {
        if (currentRequestRef.current || !mlBridgeQueue.hasWork()) return;
        const request = mlBridgeQueue.shift();
        if (request) {
            console.log('[MLBridge] Processing a native analysis request.');
            currentRequestRef.current = request;
            setCurrentRequest(request);
        }
    }, []);

    const releaseRequest = useCallback((requestId: string) => {
        if (currentRequestRef.current?.id === requestId) {
            currentRequestRef.current = null;
        }
        setCurrentRequest(activeRequest => (
            activeRequest?.id === requestId ? null : activeRequest
        ));
    }, []);

    useEffect(() => {
        const unsubscribeWork = mlBridgeQueue.subscribe(dispatchNext);
        const unsubscribeCancel = mlBridgeQueue.onCancel(requestId => {
            releaseRequest(requestId);
        });
        dispatchNext();
        return () => {
            unsubscribeWork();
            unsubscribeCancel();
        };
    }, [dispatchNext, releaseRequest]);

    // Advance the queue whenever the active slot becomes free, and guard an
    // active request with a single aligned timeout timer.
    useEffect(() => {
        if (!currentRequest) {
            dispatchNext();
            return;
        }

        const timedOutRequest = currentRequest;
        const timeout = setTimeout(() => {
            console.warn('[MLBridge] Request timed out internally.');
            timedOutRequest.reject(new Error('Internal Bridge Timeout'));
            releaseRequest(timedOutRequest.id);
        }, ML_REQUEST_TIMEOUT_MS);

        return () => clearTimeout(timeout);
    }, [currentRequest, dispatchNext, releaseRequest]);

    // Process Face Detection results
    useEffect(() => {
        if (!currentRequest || currentRequest.type !== 'detectFaces') return;

        const request = currentRequest;
        let active = true;

        (async () => {
            try {
                const result = await faceDetectorRef.current.detectFaces(request.imageUri);
                if (!active) return;

                // RNMLKitFaceDetector returns undefined when its native module
                // rejects. A valid result always contains the faces array.
                if (!result || !Array.isArray(result.faces)) {
                    throw new Error('Face detection failed');
                }

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
                console.error('[MLBridge] Face detection failed.');
                request.reject(error instanceof Error ? error : new Error(String(error)));
            } finally {
                if (active) {
                    releaseRequest(request.id);
                }
            }
        })();

        return () => {
            active = false;
        };
    }, [currentRequest, releaseRequest]);

    // Process Image Labeling results
    useEffect(() => {
        if (!currentRequest || currentRequest.type !== 'labelImage' || !labeler) return;

        const request = currentRequest;
        let active = true;

        console.log('[MLBridge] Starting label classification');
        (async () => {
            try {
                const result = await labeler.classifyImage(request.imageUri);
                if (!active) return;
                console.log('[MLBridge] Label classification completed.');
                const labels: ImageLabel[] = result.map((item: any) => ({
                    text: (item.text && item.text.length > 0) ? item.text : (IMAGENET_LABELS[item.index] ?? 'Unknown'),
                    confidence: item.confidence,
                }));

                request.resolve(labels);
            } catch (error) {
                if (!active) return;
                console.error('[MLBridge] Image labeling failed.');
                request.reject(error instanceof Error ? error : new Error(String(error)));
            } finally {
                if (active) {
                    releaseRequest(request.id);
                }
            }
        })();

        return () => {
            active = false;
        };
    }, [currentRequest, labeler, releaseRequest]);

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

