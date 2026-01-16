/**
 * MLBridge - Headless component bridging Class-based AIScanner with Hook-based ML Kit
 */

import { FaceDetectionProvider, useFacesInPhoto } from '@infinitered/react-native-mlkit-face-detection';
import { useImageLabeling, useImageLabelingModels, useImageLabelingProvider } from '@infinitered/react-native-mlkit-image-labeling';
import { Asset } from 'expo-asset';
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

    push(request: MLRequest) {
        this.queue.push(request);
    }

    shift(): MLRequest | undefined {
        return this.queue.shift();
    }

    hasWork(): boolean {
        return this.queue.length > 0;
    }

    isAvailable(): boolean {
        return this.isReady;
    }
}

// Global singleton
export const mlBridgeQueue = new MLBridgeQueue();

/**
 * Inner component that processes requests
 */
function MLBridgeInner() {
    const [currentRequest, setCurrentRequest] = useState<MLRequest | null>(null);
    const [modelPath, setModelPath] = useState<string | null>(null);
    const requestStartTimeRef = useRef<number>(0);

    // Face Detection
    const { faces, error: faceError, status: faceStatus } = useFacesInPhoto(
        currentRequest?.type === 'detectFaces' ? currentRequest.imageUri : undefined
    );

    // Image Labeling
    const labeler = useImageLabeling('efficientnet');

    const processedRef = useRef(new Set<string>());

    // Load model on mount
    useEffect(() => {
        console.log('[MLBridge] Component Mounted');
        (async () => {
            try {
                const [modelAsset] = await Asset.loadAsync(
                    require('../assets/ml/efficientnet-lite4.tflite')
                );

                if (modelAsset.localUri) {
                    setModelPath(modelAsset.localUri);
                    console.log('[MLBridge] Model loaded:', modelAsset.localUri);
                }
            } catch (error) {
                console.error('[MLBridge] Failed to load model:', error);
            }
        })();
        return () => console.log('[MLBridge] Unmounted');
    }, []);

    // Mark ready
    useEffect(() => {
        mlBridgeQueue.markReady();
        console.log('[MLBridge] Ready state set');
    }, []);

    // Poll for new requests
    useEffect(() => {
        const interval = setInterval(() => {
            // Check for stuck request (timeout > 10s)
            if (currentRequest && Date.now() - requestStartTimeRef.current > 10000) {
                console.warn('[MLBridge] Request timed out internally:', currentRequest.id);
                currentRequest.reject(new Error('Internal Bridge Timeout'));
                processedRef.current.add(currentRequest.id);
                setCurrentRequest(null);
                return;
            }

            if (currentRequest || !mlBridgeQueue.hasWork()) return;

            const request = mlBridgeQueue.shift();
            if (request && !processedRef.current.has(request.id)) {
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

        console.log('[MLBridge] Face Status:', faceStatus, 'Error:', faceError);

        if (faceError) {
            console.error('[MLBridge] Face detection error:', faceError);
            currentRequest.reject(new Error(faceError));
            processedRef.current.add(currentRequest.id);
            setCurrentRequest(null);
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
            processedRef.current.add(currentRequest.id);
            setCurrentRequest(null);
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
                processedRef.current.add(currentRequest.id);
                setCurrentRequest(null);
            } catch (error) {
                console.error('[MLBridge] Image labeling error:', error);
                currentRequest.reject(error as Error);
                processedRef.current.add(currentRequest.id);
                setCurrentRequest(null);
            }
        })();
    }, [currentRequest, labeler]);

    return null;
}

/**
 * MLBridge - Must be mounted at app root
 */
export function MLBridge() {
    const [modelReady, setModelReady] = useState(false);

    // Use useImageLabelingModels with dynamic model path
    const models = useImageLabelingModels({
        efficientnet: { // Keep key as 'efficientnet' for now to avoid refactoring hooks, or rename?
            // Better to keep key 'efficientnet' or change to 'mobilenet_v3'?
            // The hook usage is `useImageLabeling('efficientnet')` at line 62.
            // I will keep the key 'efficientnet' but load the new model 
            // to minimize disruption, or better, change key to 'mobilenet_v3'.
            // Let's keep key 'efficientnet' but comment it clearly.
            // Actually, let's rename key to 'current_model' or just keep 'efficientnet' 
            // but logic inside loadAsync uses specific file.
            model: require('../assets/ml/efficientnet-lite4.tflite'),
            options: {
                maxResultCount: 5,
                confidenceThreshold: 0.4, // EfficientNet is more precise, 0.4 is good
            },
        },
    });

    const { ImageLabelingModelProvider } = useImageLabelingProvider(models);

    return (
        <FaceDetectionProvider>
            <ImageLabelingModelProvider>
                <MLBridgeInner />
            </ImageLabelingModelProvider>
        </FaceDetectionProvider>
    );
}

