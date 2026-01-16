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

export const MLKitService = {
    /**
     * Check if ML Kit bridge is available
     */
    isAvailable(): boolean {
        return getBridgeQueue().isAvailable?.() || false;
    },

    /**
     * Detect faces in an image
     */
    async detectFaces(imageUri: string): Promise<DetectedFace[]> {
        try {
            const queue = getBridgeQueue();
            if (!queue.isAvailable?.()) {
                console.warn('[MLKit] Bridge queue not available, skipping face detection');
                return [];
            }

            // Push request and wait for result with timeout
            return Promise.race([
                new Promise<DetectedFace[]>((resolve, reject) => {
                    queue.push({
                        id: `${Date.now()}-${Math.random()}`,
                        type: 'detectFaces',
                        imageUri,
                        resolve,
                        reject,
                    });
                }),
                new Promise<DetectedFace[]>((resolve) =>
                    setTimeout(() => {
                        console.warn('[MLKit] Face detection timed out');
                        resolve([]);
                    }, 5000)
                )
            ]);
        } catch (error) {
            console.error('[MLKit] Face detection error:', error);
            return [];
        }
    },

    /**
     * Label image content (objects, scenes)
     */
    async labelImage(imageUri: string): Promise<ImageLabel[]> {
        try {
            const queue = getBridgeQueue();
            if (!queue.isAvailable?.()) {
                console.warn('[MLKit] Bridge queue not available, skipping object detection');
                return [];
            }

            // Push request and wait for result with timeout
            return Promise.race([
                new Promise<ImageLabel[]>((resolve, reject) => {
                    queue.push({
                        id: `${Date.now()}-${Math.random()}`,
                        type: 'labelImage',
                        imageUri,
                        resolve,
                        reject,
                    });
                }),
                new Promise<ImageLabel[]>((resolve) =>
                    setTimeout(() => {
                        console.warn('[MLKit] Label detection timed out');
                        resolve([]);
                    }, 5000)
                )
            ]);
        } catch (error) {
            console.error('[MLKit] Image labeling error:', error);
            return [];
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

