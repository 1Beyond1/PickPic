/**
 * IMLLabeler - ML Kit Label Interface (Stub)
 * 
 * This is a placeholder interface for future ML Kit integration.
 * Can be used to classify images into categories.
 */

export interface ImageLabel {
    label: string;
    confidence: number;
}

export interface IMLLabeler {
    /**
     * Label an image using ML Kit
     * @param assetUri - URI of the image to label
     * @returns Array of labels with confidence scores
     */
    labelImage(assetUri: string): Promise<ImageLabel[]>;

    /**
     * Check if ML Kit is available on this device
     */
    isAvailable(): Promise<boolean>;
}

/**
 * Stub implementation that returns empty results
 */
export class MLLabelerStub implements IMLLabeler {
    async labelImage(_assetUri: string): Promise<ImageLabel[]> {
        // Stub: No labels available
        console.log('[MLLabeler] Stub: labelImage called, returning empty array');
        return [];
    }

    async isAvailable(): Promise<boolean> {
        // Stub: ML Kit not available
        return false;
    }
}

// Singleton instance
let instance: IMLLabeler | null = null;

/**
 * Get the ML Labeler instance
 * Replace with real implementation when ML Kit is integrated
 */
export function getMLLabeler(): IMLLabeler {
    if (!instance) {
        // TODO: Check for native ML Kit module and use it if available
        // if (NativeModules.MLKitLabeler) {
        //   instance = new MLKitLabeler();
        // } else {
        instance = new MLLabelerStub();
        // }
    }
    return instance;
}
