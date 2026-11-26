/**
 * useAIScanner - React Hook for AI Scanner integration
 * 
 * Now uses global useScannerStore to sync state across components.
 */

import { useCallback, useEffect, useRef } from 'react';
import { getDatabase } from '../database';
import {
    getStatus,
    getClassificationStatus,
    startClassification as startClassificationScanner,
    isScanning as isScannerRunning,
    resumeOnce as resumeOnceScanner,
    ScanBatchOptions,
    ScanProgress,
    resetAllProgress,
    start as startScanner,
    stop as stopScanner
} from '../services/scanner';
import { useMediaStore } from '../stores/useMediaStore';
import { useScannerStore } from '../stores/useScannerStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import type { AIProgress } from '../database/repositories/AIAnalysisRepository';

export interface UseAIScannerResult {
    classificationProgress: AIProgress;
    startClassification: (errorsOnly?: boolean) => Promise<void>;
    // State
    progress: ScanProgress;
    isRunning: boolean;
    isFinalizing: boolean;
    lastError: Error | null;

    // Actions
    start: () => Promise<void>;
    stop: () => void;
    resumeOnce: (options?: ScanBatchOptions) => Promise<void>;
    resetScan: () => Promise<void>;
    refreshStatus: () => Promise<void>;
}

/**
 * Hook for managing AI Scanner lifecycle
 */
export function useAIScanner(): UseAIScannerResult {
    // Select from global store
    const progress = useScannerStore(state => state.progress);
    const classificationProgress = useScannerStore(state => state.classificationProgress);
    const isRunning = useScannerStore(state => state.isRunning);
    const isFinalizing = useScannerStore(state => state.isFinalizing);
    const lastError = useScannerStore(state => state.lastError);
    const mediaLibraryRefreshVersion = useMediaStore(state => state.mediaLibraryRefreshVersion);
    const selectedAlbums = useSettingsStore(state => state.selectedAlbumIds);

    // Actions from store
    const setProgress = useScannerStore(state => state.setProgress);
    const setLastError = useScannerStore(state => state.setLastError);
    const statusRequestId = useRef(0);

    useEffect(() => {
        let active = true;
        if (isScannerRunning()) return;
        void getClassificationStatus().then(value => {
            if (active && !isScannerRunning()) useScannerStore.getState().setClassificationProgress(value);
        }).catch(() => { if (active) useScannerStore.getState().setClassificationProgress({ pending: 0, done: 0, error: 0 }); });
        return () => { active = false; };
    }, [mediaLibraryRefreshVersion, selectedAlbums, isRunning, isFinalizing]);

    // Initialize database and fetch initial status
    useEffect(() => {
        let active = true;
        const requestId = ++statusRequestId.current;

        const init = async () => {
            try {
                await getDatabase(); // Ensure DB is initialized
                // A media snapshot can change while this asynchronous status
                // read is in flight. Do not let a refresh started during a
                // scan overwrite progress published by the scanner itself.
                if (!active || isScannerRunning()) return;
                const status = await getStatus();
                if (active && requestId === statusRequestId.current && !isScannerRunning()) {
                    setProgress(status);
                }
            } catch (error) {
                console.error('[useAIScanner] Failed to initialize scanner status.');
            }
        };
        init();

        return () => {
            active = false;
            statusRequestId.current++;
        };
    }, [mediaLibraryRefreshVersion, setProgress]);

    // Start scanning
    const start = useCallback(async () => {
        if (isScannerRunning()) {
            console.log('[useAIScanner] Scanner already running');
            return;
        }

        statusRequestId.current++;
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
    const resumeOnce = useCallback(async (options?: ScanBatchOptions) => {
        if (isScannerRunning()) {
            console.log('[useAIScanner] Scanner already running');
            return;
        }

        statusRequestId.current++;
        setLastError(null);
        await resumeOnceScanner(options);
    }, [setLastError]);

    // Refresh status
    const refreshStatus = useCallback(async () => {
        const requestId = ++statusRequestId.current;
        const status = await getStatus();
        if (requestId !== statusRequestId.current) return;
        setProgress(status);
    }, [setProgress]);

    // Reset scan cursor
    const resetScan = useCallback(async () => {
        // Invalidate an initialization/status request that may still be using
        // the pre-reset database snapshot. Its result must not overwrite the
        // zeroed status published after the reset completes.
        statusRequestId.current++;
        await resetAllProgress();

        // A successful reset makes the previous run error no longer
        // actionable. Keep it visible when reset itself fails, but clear it
        // before publishing the fresh zeroed status.
        setLastError(null);
        await refreshStatus();
    }, [refreshStatus, setLastError]);

    return {
        classificationProgress,
        startClassification: async (errorsOnly = false) => {
            statusRequestId.current++;
            await startClassificationScanner(errorsOnly);
        },
        progress,
        isRunning,
        isFinalizing,
        lastError,
        start,
        stop,
        resumeOnce,
        resetScan,
        refreshStatus,
    };
}
