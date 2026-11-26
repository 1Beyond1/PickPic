import React from 'react';
import { act, render } from '@testing-library/react-native';

let mockDetectorStatus = 'ready';
const mockDetectFaces = jest.fn();
const mockClassifyImage = jest.fn();
let mockLabelerLoaded = true;
const mockLabeler = {
    isLoaded: () => mockLabelerLoaded,
    classifyImage: (...args: any[]) => mockClassifyImage(...args),
};

jest.mock('@infinitered/react-native-mlkit-face-detection', () => ({
    FaceDetectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@infinitered/react-native-mlkit-image-labeling', () => ({
    useImageLabelingModels: (models: unknown) => models,
    useImageLabelingProvider: () => ({
        ImageLabelingModelProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    }),
    useImageLabeling: () => mockLabeler,
}));
jest.mock('../../services/ml/useFaceDetector', () => ({
    useFaceDetector: () => ({
        status: mockDetectorStatus,
        detectFaces: (...args: any[]) => mockDetectFaces(...args),
    }),
}));
jest.mock('../../assets/ml/efficientnet-lite4.tflite', () => 1, { virtual: true });

import { ML_REQUEST_TIMEOUT_MS, MLBridge, mlBridgeQueue } from '../../components/MLBridge';
import { MLKitService } from '../../services/ml/MLKitService';

describe('MLBridge event-driven scheduling and stability', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        mockDetectorStatus = 'ready';
        mockLabelerLoaded = true;
        mockDetectFaces.mockReset();
        mockClassifyImage.mockReset();
        mlBridgeQueue.markUnavailable();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('dispatches requests via events without idle polling intervals and keeps timeout aligned at 10s', async () => {
        const setIntervalSpy = jest.spyOn(global, 'setInterval');
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
        let resolveSlowLabel!: (labels: Array<{ text: string; confidence: number; index: number }>) => void;
        mockClassifyImage.mockImplementationOnce(
            () => new Promise(resolve => { resolveSlowLabel = resolve; }),
        );

        const view = render(<MLBridge />);
        expect(mlBridgeQueue.isAvailable()).toBe(true);
        // Idle bridge must not keep a perpetual polling interval alive.
        expect(setIntervalSpy).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);

        let promise!: Promise<Array<{ text: string; confidence: number }>>;
        await act(async () => {
            promise = MLKitService.labelImage('file:///slow-photo.jpg');
        });
        expect(mockClassifyImage).toHaveBeenCalledWith('file:///slow-photo.jpg');
        const timeoutHandles = setTimeoutSpy.mock.calls
            .map((call, index) => (call[1] === ML_REQUEST_TIMEOUT_MS ? setTimeoutSpy.mock.results[index]?.value : null))
            .filter(Boolean);
        expect(timeoutHandles.length).toBeGreaterThanOrEqual(2);

        // Advancing past the old 5s timeout must NOT prematurely abort a 7s inference.
        await act(async () => { jest.advanceTimersByTime(7000); });
        await act(async () => {
            resolveSlowLabel([{ text: 'Cat', confidence: 0.92, index: 281 }]);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        await expect(promise).resolves.toEqual([{ text: 'Cat', confidence: 0.92 }]);
        expect(setIntervalSpy).not.toHaveBeenCalled();
        const clearedHandles = new Set(clearTimeoutSpy.mock.calls.map(([handle]) => handle));
        for (const handle of timeoutHandles) {
            expect(clearedHandles.has(handle)).toBe(true);
        }
        view.unmount();
        expect(mlBridgeQueue.isAvailable()).toBe(false);
    });

    it('keeps bridge availability stable across faceDetector status transitions and guards stale label resolutions', async () => {
        let resolveFirstLabel!: (labels: Array<{ text: string; confidence: number; index: number }>) => void;
        mockClassifyImage
            .mockImplementationOnce(() => new Promise(resolve => { resolveFirstLabel = resolve; }))
            .mockResolvedValueOnce([{ text: 'Dog', confidence: 0.88, index: 207 }]);

        const view = render(<MLBridge />);
        expect(mlBridgeQueue.isAvailable()).toBe(true);

        // Status transitions during normal face detection must not flap availability.
        mockDetectorStatus = 'detecting';
        view.rerender(<MLBridge />);
        expect(mlBridgeQueue.isAvailable()).toBe(true);
        mockDetectorStatus = 'done';
        view.rerender(<MLBridge />);
        expect(mlBridgeQueue.isAvailable()).toBe(true);

        // First label request times out at the aligned 10s boundary.
        let firstPromise!: Promise<Array<{ text: string; confidence: number }>>;
        await act(async () => {
            firstPromise = MLKitService.labelImage('file:///hung.jpg');
        });
        const firstError = firstPromise.then(() => null, (error: Error) => error);
        await act(async () => { jest.advanceTimersByTime(ML_REQUEST_TIMEOUT_MS + 10); });
        expect((await firstError)?.message).toMatch(/timed out|Timeout/);

        // Start a second request; resolving the stale first promise must not interfere.
        let secondPromise!: Promise<Array<{ text: string; confidence: number }>>;
        await act(async () => {
            secondPromise = MLKitService.labelImage('file:///next.jpg');
            resolveFirstLabel([{ text: 'Stale', confidence: 0.99, index: 0 }]);
        });
        await act(async () => { await Promise.resolve(); });
        await expect(secondPromise).resolves.toEqual([{ text: 'Dog', confidence: 0.88 }]);

        view.unmount();
    });
});
