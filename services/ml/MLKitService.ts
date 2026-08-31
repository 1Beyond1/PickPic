/**
 * ML Kit Service - Bridge to Hook-based ML Kit API
 * Note: Currently only supports Face Detection
 */

export interface DetectedFace {
    boundingBox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    confidence: number;
}

export interface ImageLabel {
    text: string;
    confidence: number;
}

// Import the bridge queue (lazy to avoid circular dependency)
let mlBridgeQueue: any = null;

function getBridgeQueue() {
    if (!mlBridgeQueue) {
        try {
            const bridge = require('../../components/MLBridge');
            mlBridgeQueue = bridge.mlBridgeQueue;
        } catch (error) {
            console.warn('[MLKit] Bridge not available:', error);
            mlBridgeQueue = { isAvailable: () => false };
        }
    }
    return mlBridgeQueue;
}

function enqueueRequest<T>(
    queue: any,
    type: 'detectFaces' | 'labelImage',
    imageUri: string
): Promise<T> {
    const requestId = `${Date.now()}-${Math.random()}`;

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;

            settled = true;
            queue.cancel?.(requestId);
            console.warn(`[MLKit] ${type} timed out`);
            reject(new Error(`${type} timed out`));
        }, 5000);

        try {
            queue.push({
                id: requestId,
                type,
                imageUri,
                resolve: (result: T) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    resolve(result);
                },
                reject: (error: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    reject(error);
                },
            });
        } catch (error) {
            settled = true;
            clearTimeout(timeout);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export const MLKitService = {
    /**
     * Check if ML Kit bridge is available
     */
    isAvailable(): boolean {
        return getBridgeQueue().isAvailable?.() || false;
    },

    /**
     * Wait briefly for the lazily mounted bridge/model to become available.
     * Returning false lets the scanner report a retryable asset error instead
     * of silently marking an AI scan as complete without classification.
     */
    async waitUntilAvailable(timeoutMs: number = 10000): Promise<boolean> {
        const queue = getBridgeQueue();
        const deadline = Date.now() + Math.max(0, timeoutMs);

        while (!queue.isAvailable?.() && Date.now() < deadline) {
            await new Promise<void>(resolve => setTimeout(resolve, 100));
        }

        return queue.isAvailable?.() || false;
    },

    /**
     * Detect faces in an image
     */
    async detectFaces(imageUri: string): Promise<DetectedFace[]> {
        try {
            const queue = getBridgeQueue();
            if (!queue.isAvailable?.()) {
                throw new Error('ML bridge is unavailable for face detection');
            }

            return await enqueueRequest<DetectedFace[]>(queue, 'detectFaces', imageUri);
        } catch (error) {
            console.error('[MLKit] Face detection error:', error);
            throw error instanceof Error ? error : new Error(String(error));
        }
    },

    /**
     * Label image content (objects, scenes)
     */
    async labelImage(imageUri: string): Promise<ImageLabel[]> {
        try {
            const queue = getBridgeQueue();
            if (!queue.isAvailable?.()) {
                throw new Error('ML bridge is unavailable for image labeling');
            }

            return await enqueueRequest<ImageLabel[]>(queue, 'labelImage', imageUri);
        } catch (error) {
            console.error('[MLKit] Image labeling error:', error);
            throw error instanceof Error ? error : new Error(String(error));
        }
    },

    /**
     * Check if image is likely a screenshot (basic heuristic)
     */
    isScreenshot(labels: ImageLabel[]): boolean {
        // TODO: Improve screenshot detection logic
        const screenshotIndicators = ['text', 'font', 'website', 'screenshot'];
        return labels.some((label) =>
            screenshotIndicators.some((indicator) =>
                label.text.toLowerCase().includes(indicator)
            )
        );
    },
};

