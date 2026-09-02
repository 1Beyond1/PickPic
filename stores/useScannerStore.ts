import { create } from 'zustand';
import { ScanProgress } from '../services/scanner/AIScanner';

interface ScannerState {
    progress: ScanProgress;
    isRunning: boolean;
    isFinalizing: boolean;
    lastError: Error | null;

    setProgress: (progress: ScanProgress) => void;
    setIsRunning: (isRunning: boolean) => void;
    setIsFinalizing: (isFinalizing: boolean) => void;
    setLastError: (error: Error | null) => void;
    incrementProgress: (success: boolean) => void;
}

export const useScannerStore = create<ScannerState>((set) => ({
    progress: {
        totalPending: 0,
        totalDone: 0,
        totalError: 0,
        currentBatch: 0,
        isRunning: false,
    },
    isRunning: false,
    isFinalizing: false,
    lastError: null,

    setProgress: (progress) => set({ progress, isRunning: progress.isRunning }),
    setIsRunning: (isRunning) => set((state) => ({
        isRunning,
        progress: {
            ...state.progress,
            isRunning,
            ...(isRunning ? { currentBatch: 0 } : {}),
        },
    })),
    setIsFinalizing: (isFinalizing) => set({ isFinalizing }),
    setLastError: (lastError) => set({ lastError }),
    incrementProgress: (success: boolean) => set((state) => ({
        progress: {
            ...state.progress,
            totalPending: Math.max(0, state.progress.totalPending - 1),
            totalDone: state.progress.totalDone + (success ? 1 : 0),
            totalError: state.progress.totalError + (success ? 0 : 1),
        }
    })),
}));
