/**
 * useAIScanner - React Hook for AI Scanner integration
 * 
 * Now uses global useScannerStore to sync state across components.
 */

import { useCallback, useEffect } from 'react';
import { getDatabase } from '../database';
import {
    getStatus,
    isScanning as isScannerRunning,
    resumeOnce as resumeOnceScanner,
    ScanProgress,
    start as startScanner,
    stop as stopScanner
} from '../services/scanner';
import { useScannerStore } from '../stores/useScannerStore';

export interface UseAIScannerResult {
    // State
    progress: ScanProgress;
    isRunning: boolean;
    lastError: Error | null;

    // Actions
    start: () => Promise<void>;
    stop: () => void;
    resumeOnce: () => Promise<void>;
    resetScan: () => Promise<void>;
    refreshStatus: () => Promise<void>;
}

/**
 * Hook for managing AI Scanner lifecycle
 */
export function useAIScanner(): UseAIScannerResult {
    // Select from global store
    const progress = useScannerStore(state => state.progress);
    const isRunning = useScannerStore(state => state.isRunning);
    const lastError = useScannerStore(state => state.lastError);

    // Actions from store
    const setProgress = useScannerStore(state => state.setProgress);
    const setIsRunning = useScannerStore(state => state.setIsRunning);
    const setLastError = useScannerStore(state => state.setLastError);

    // Initialize database and fetch initial status
    useEffect(() => {
        const init = async () => {
            try {
                await getDatabase(); // Ensure DB is initialized
                const status = await getStatus();
                setProgress(status);
            } catch (error) {
                console.error('[useAIScanner] Init error:', error);
            }
        };
        init();
    }, [setProgress]);

    // Start scanning
    const start = useCallback(async () => {
        if (isScannerRunning()) {
            console.log('[useAIScanner] Scanner already running');
            return;
        }

        setLastError(null);
        // setIsRunning(true) is handled in scanner.start()

        await startScanner();
    }, [setLastError]);

    // Stop scanning
    const stop = useCallback(() => {
        stopScanner();
        // setIsRunning(false) is handled in scanner.stop()/finally
    }, []);

    // Resume for one batch
    const resumeOnce = useCallback(async () => {
        if (isScannerRunning()) {
            console.log('[useAIScanner] Scanner already running');
            return;
        }

        setLastError(null);
        await resumeOnceScanner();
    }, [setLastError]);

    // Refresh status
    const refreshStatus = useCallback(async () => {
        const status = await getStatus();
        setProgress(status);
    }, [setProgress]);

    // Reset scan cursor
    const resetScan = useCallback(async () => {
        // Need to import resetAllProgress from services/scanner if not exported yet
        const scanner = await import('../services/scanner');
        if (scanner.resetAllProgress) {
            await scanner.resetAllProgress();
        } else {
            await scanner.resetCursor();
        }

        await refreshStatus();
    }, [refreshStatus]);

    return {
        progress,
        isRunning,
        lastError,
        start,
        stop,
        resumeOnce,
        resetScan,
        refreshStatus,
    };
}
