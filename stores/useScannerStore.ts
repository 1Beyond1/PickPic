import { create } from 'zustand';
import { ScanProgress } from '../services/scanner/AIScanner';

interface ScannerState {
    progress: ScanProgress;
    isRunning: boolean;
    lastError: Error | null;

    setProgress: (progress: ScanProgress) => void;
    setIsRunning: (isRunning: boolean) => void;
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
    lastError: null,

    setProgress: (progress) => set({ progress, isRunning: progress.isRunning }),
    setIsRunning: (isRunning) => set({ isRunning }),
    setLastError: (lastError) => set({ lastError }),
    incrementProgress: (success: boolean) => set((state) => ({
        progress: {
            ...state.progress,
            totalPending: Math.max(0, state.progress.totalPending - 1),
            totalDone: state.progress.totalDone + 1,
            // Optional: totalError: success ? state.progress.totalError : state.progress.totalError + 1
        }
    })),
}));
