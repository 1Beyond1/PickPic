jest.mock('../../database', () => ({
  getDatabase: jest.fn(),
}));

jest.mock('../../services/scanner', () => ({
  getStatus: jest.fn(),
  isScanning: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  resumeOnce: jest.fn(),
  resetAllProgress: jest.fn(),
  resetCursor: jest.fn(),
}));

jest.mock('../../services/scanner/AIScanner', () => ({}));
jest.mock('../../stores/useMediaStore', () => ({
  useMediaStore: (selector: (state: { mediaLibraryRefreshVersion: number }) => unknown) => (
    selector({ mediaLibraryRefreshVersion: 0 })
  ),
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { getDatabase } from '../../database';
import {
  getStatus,
  isScanning,
  resetAllProgress,
  start,
} from '../../services/scanner';
import { useAIScanner } from '../../hooks/useAIScanner';
import { useScannerStore } from '../../stores/useScannerStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => {
    resolve = value;
  });
  return { promise, resolve };
}

const initialProgress = {
  totalPending: 0,
  totalDone: 0,
  totalError: 0,
  currentBatch: 0,
  isRunning: false,
};

describe('useAIScanner lifecycle state', () => {
  beforeEach(() => {
    (getDatabase as jest.Mock).mockResolvedValue({});
    (isScanning as jest.Mock).mockImplementation(() => {
      const state = useScannerStore.getState();
      return state.isRunning || state.isFinalizing;
    });
    (resetAllProgress as jest.Mock).mockResolvedValue(undefined);
    (getStatus as jest.Mock).mockResolvedValue(initialProgress);
    act(() => {
      useScannerStore.getState().setProgress(initialProgress);
      useScannerStore.getState().setIsRunning(false);
      useScannerStore.getState().setIsFinalizing(false);
      useScannerStore.getState().setLastError(null);
    });
  });

  it('exposes finalizing independently from the running flag', async () => {
    const { result } = renderHook(() => useAIScanner());
    await waitFor(() => expect(getStatus).toHaveBeenCalled());

    act(() => {
      useScannerStore.getState().setIsFinalizing(true);
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.isFinalizing).toBe(true);
  });

  it('does not start a conflicting scan while finalization is in progress', async () => {
    const { result } = renderHook(() => useAIScanner());
    await waitFor(() => expect(getStatus).toHaveBeenCalled());

    act(() => {
      useScannerStore.getState().setIsFinalizing(true);
    });

    await act(async () => {
      await result.current.start();
    });

    expect(start).not.toHaveBeenCalled();
  });

  it('does not let a pre-reset status response overwrite the reset result', async () => {
    const staleStatus = {
      totalPending: 7,
      totalDone: 4,
      totalError: 1,
      currentBatch: 2,
      isRunning: false,
    };
    const resetStatus = {
      ...initialProgress,
      totalPending: 2,
    };
    const pendingInitialStatus = deferred<typeof staleStatus>();
    (getStatus as jest.Mock)
      .mockReset()
      .mockReturnValueOnce(pendingInitialStatus.promise)
      .mockResolvedValueOnce(resetStatus);

    const { result } = renderHook(() => useAIScanner());
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.resetScan();
    });
    expect(result.current.progress).toEqual(resetStatus);

    await act(async () => {
      pendingInitialStatus.resolve(staleStatus);
      await pendingInitialStatus.promise;
    });

    expect(result.current.progress).toEqual(resetStatus);
  });

  it('keeps the newest refreshStatus result when an older request finishes later', async () => {
    const staleStatus = { ...initialProgress, totalDone: 1 };
    const newestStatus = { ...initialProgress, totalDone: 2 };
    const pendingStaleStatus = deferred<typeof staleStatus>();
    const pendingNewestStatus = deferred<typeof newestStatus>();

    const { result } = renderHook(() => useAIScanner());
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    (getStatus as jest.Mock)
      .mockReset()
      .mockReturnValueOnce(pendingStaleStatus.promise)
      .mockReturnValueOnce(pendingNewestStatus.promise);

    let staleRefresh!: Promise<void>;
    let newestRefresh!: Promise<void>;
    await act(async () => {
      staleRefresh = result.current.refreshStatus();
      newestRefresh = result.current.refreshStatus();
      pendingNewestStatus.resolve(newestStatus);
      await newestRefresh;
      pendingStaleStatus.resolve(staleStatus);
      await staleRefresh;
    });

    expect(result.current.progress).toEqual(newestStatus);
  });
});
