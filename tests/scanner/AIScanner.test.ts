// Exercise the real scanner and repositories against private SQLite. Only
// platform media access, pixel/ML work and interaction scheduling are faked.
jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({ getDatabase: jest.fn(), withTransaction: jest.fn() }));
jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(),
  getAlbumsAsync: jest.fn(), getAssetInfoAsync: jest.fn(),
}));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('../../stores/useMediaStore', () => ({ hasFullPhotoLibraryAccess: jest.fn() }));
jest.mock('../../stores/useSettingsStore', () => ({
  useSettingsStore: { getState: jest.fn() },
}));
jest.mock('../../services/imageOps', () => ({
  ...jest.requireActual('../../services/imageOps/IImageOps'),
  getImageOps: jest.fn(),
}));
jest.mock('../../services/ml/MLKitService', () => ({
  MLKitService: {
    waitUntilAvailable: jest.fn(), isAvailable: jest.fn(),
    labelImage: jest.fn(), detectFaces: jest.fn(),
  },
}));

import { waitFor } from '@testing-library/react-native';
import { usePrivacyStore } from '../../stores/usePrivacyStore';
import { InteractionManager, Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { AssetRepository, AssetStatus, AssetStatusType, DupGroupRepository, GLOBAL_ALGO_VERSION, MetaRepository, SimilarReviewRepository } from '../../database';
import { getDatabase, withTransaction } from '../../database/db';
import { getImageOps } from '../../services/imageOps';
import { MLKitService } from '../../services/ml/MLKitService';
import { getStatus, getClassificationStatus, startClassification, isScanning, resumeOnce, start, stop } from '../../services/scanner/AIScanner';
import { hasFullPhotoLibraryAccess } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useScannerStore } from '../../stores/useScannerStore';
import { TestDatabase } from '../helpers/testDatabase';

function photo(id: string, creationTime = 100): MediaLibrary.Asset {
  return {
    id, filename: `${id}.jpg`, uri: `file:///${id}.jpg`, mediaType: 'photo',
    width: 1000, height: 800, creationTime, modificationTime: 1, duration: 0,
  } as MediaLibrary.Asset;
}

function page(assets: MediaLibrary.Asset[], hasNextPage = false, endCursor = '') {
  return { assets, hasNextPage, endCursor, totalCount: assets.length };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const scannerTestPlatform = Platform.OS;

describe('AIScanner engine safety', () => {
  let database: TestDatabase;
  const media = jest.mocked(MediaLibrary);
  const fs = jest.mocked(FileSystem);
  const ml = jest.mocked(MLKitService);
  const gray = { width: 256, height: 256, data: new Uint8Array(0) };
  const ops = {
    resizeToGray256: jest.fn(), computeLaplacianVar: jest.fn(),
    computeMeanLuma: jest.fn(), computeDHash64: jest.fn(),
    hammingDistance64: jest.fn(), dispose: jest.fn(), centerCropSquare: jest.fn(),
    resizeForFaceDetection: jest.fn(),
  };

  beforeEach(() => {
    usePrivacyStore.setState({ failures: {} });
    Object.defineProperty(Platform, 'OS', { configurable: true, value: scannerTestPlatform });
    database = new TestDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(database);
    (withTransaction as jest.Mock).mockImplementation(async callback => {
      await database.execAsync('BEGIN TRANSACTION;');
      try {
        const result = await callback(database);
        await database.execAsync('COMMIT;');
        return result;
      } catch (error) {
        await database.execAsync('ROLLBACK;');
        throw error;
      }
    });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation((task: any) => {
      task();
      return { cancel: jest.fn(), then: jest.fn(), done: jest.fn() } as any;
    });
    media.getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    media.getAssetsAsync.mockResolvedValue(page([photo('one'), photo('two', 200)]));
    media.getAlbumsAsync.mockResolvedValue([]);
    media.getAssetInfoAsync.mockImplementation(async asset => {
      const id = typeof asset === 'string' ? asset : asset.id;
      const time = id === 'two' ? 200 : id.startsWith('ml-') ? 100 + Number(id.slice(3)) : 100;
      return { ...photo(id, time), localUri: `file:///${id}.jpg` } as MediaLibrary.AssetInfo;
    });
    fs.getInfoAsync.mockResolvedValue({ exists: false, uri: '', isDirectory: false });
    fs.deleteAsync.mockResolvedValue(undefined);
    (hasFullPhotoLibraryAccess as jest.Mock).mockResolvedValue(true);
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: false });
    (getImageOps as jest.Mock).mockReturnValue(ops);
    ops.resizeToGray256.mockResolvedValue(gray);
    ops.computeLaplacianVar.mockReturnValue(120);
    ops.computeMeanLuma.mockReturnValue(140);
    ops.computeDHash64.mockReturnValue('0000000000000000');
    ops.hammingDistance64.mockReturnValue(64);
    ops.centerCropSquare.mockResolvedValue('file:///test-crop.jpg');
    ops.resizeForFaceDetection.mockImplementation(async (uri: string, width: number, height: number, maxDimension = 1024) => {
      if (Math.max(width, height) <= maxDimension) return { uri, width, height };
      const scale = maxDimension / Math.max(width, height);
      return {
        uri: 'file:///test-face-resized.jpg',
        width: Math.round(width * scale),
        height: Math.round(height * scale),
      };
    });
    ml.waitUntilAvailable.mockResolvedValue(true);
    ml.isAvailable.mockReturnValue(true);
    ml.labelImage.mockResolvedValue([]);
    ml.detectFaces.mockResolvedValue([]);
    useScannerStore.setState({
      isRunning: false, isFinalizing: false, lastError: null,
      progress: { totalPending: 0, totalDone: 0, totalError: 0, currentBatch: 0, isRunning: false },
    });
  });

  afterEach(async () => {
    expect(isScanning()).toBe(false);
    await database.closeAsync();
  });

  async function seed(id: string, status: AssetStatusType = AssetStatus.DONE, version = GLOBAL_ALGO_VERSION, takenAt = 100) {
    await AssetRepository.upsert({
      asset_id: id, taken_at: takenAt, width: 1000, height: 800,
      file_signature: 'library_1_1000_800', status, algo_version: version,
      blur_score: 120, mean_luma: 140, phash: 'ffffffffffffffff',
    });
  }

  it('does not reconcile or process the index when photo access is denied', async () => {
    await seed('private-result');
    media.getPermissionsAsync.mockResolvedValue({ granted: false, accessPrivileges: 'none' } as any);
    const onError = jest.fn();
    const onComplete = jest.fn();
    await start({ onError, onComplete });
    expect(media.getAssetsAsync).not.toHaveBeenCalled();
    expect((await AssetRepository.getById('private-result'))?.status).toBe(AssetStatus.DONE);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(useScannerStore.getState().progress.isRunning).toBe(false);
  });

  it('retains unseen results when pagination fails instead of treating a partial sync as deletion', async () => {
    await seed('unseen-result');
    media.getAssetsAsync.mockResolvedValue(page([photo('one')], true));
    await start();
    expect((await AssetRepository.getById('unseen-result'))?.status).toBe(AssetStatus.DONE);
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(useScannerStore.getState().lastError?.message).toMatch(/pagination cursor/);
  });

  it('scans only granted photos and preserves out-of-scope results under stable limited access', async () => {
    await seed('outside-grant');
    media.getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    media.getAssetsAsync.mockResolvedValue(page([photo('one')]));
    await start();
    expect(media.getAssetInfoAsync).toHaveBeenCalledTimes(1);
    expect(media.getAssetInfoAsync).toHaveBeenCalledWith('one');
    expect((await AssetRepository.getById('one'))?.error_message).toBeNull();
    expect((await AssetRepository.getById('one'))?.status).toBe(AssetStatus.DONE);
    expect((await AssetRepository.getById('outside-grant'))?.status).toBe(AssetStatus.DONE);
    expect(await getStatus()).toMatchObject({ totalDone: 1, totalPending: 0, totalError: 0, isRunning: false });
  });

  it('abandons reconciliation when full access changes to limited during synchronization', async () => {
    await seed('outside-grant');
    media.getPermissionsAsync
      .mockResolvedValueOnce({ granted: true, accessPrivileges: 'all' } as any)
      .mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    media.getAssetsAsync.mockResolvedValue(page([photo('one')]));
    await start();
    expect(await AssetRepository.getById('outside-grant')).not.toBeNull();
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(useScannerStore.getState().lastError?.message).toMatch(/access changed/);
  });

  it('rejects a changed selection even when the coarse permission remains limited', async () => {
    await seed('outside-grant');
    media.getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    media.getAssetsAsync.mockResolvedValueOnce(page([photo('one')])).mockResolvedValue(page([photo('two')]));
    await start();
    expect(await AssetRepository.getById('outside-grant')).not.toBeNull();
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(useScannerStore.getState().lastError?.message).toMatch(/selection changed/);
  });

  it('ignores a second start and does not complete or prune unseen records after cancellation during sync', async () => {
    await seed('unseen-result');
    const pendingPage = deferred<ReturnType<typeof page>>();
    media.getAssetsAsync.mockReturnValueOnce(pendingPage.promise);
    const onComplete = jest.fn();
    const pendingRun = start({ onComplete });
    try {
      await waitFor(() => expect(media.getAssetsAsync).toHaveBeenCalledTimes(1));
      await start();
      expect(media.getAssetsAsync).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      pendingPage.resolve(page([photo('one')]));
      await pendingRun;
    }
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(await AssetRepository.getById('unseen-result')).not.toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not begin pixel work if stopped while waiting for native interactions', async () => {
    let releaseInteraction!: () => void;
    jest.mocked(InteractionManager.runAfterInteractions).mockImplementationOnce((task: any) => {
      releaseInteraction = task;
      return { cancel: jest.fn(), then: jest.fn(), done: jest.fn() } as any;
    });
    const onComplete = jest.fn();
    const pendingRun = start({ onComplete });
    try {
      await waitFor(() => expect(releaseInteraction).toBeDefined());
      stop();
    } finally {
      releaseInteraction?.();
      await pendingRun;
    }
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect((await AssetRepository.getById('one'))?.status).toBe(AssetStatus.PENDING);
  });

  it('finishes an in-flight ML asset after stop without starting another asset, and can resume', async () => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    const pendingLabels = deferred<Awaited<ReturnType<typeof MLKitService.labelImage>>>();
    ml.labelImage.mockReturnValueOnce(pendingLabels.promise);
    const onComplete = jest.fn();
    const pendingRun = start({ onComplete });
    try {
      await waitFor(() => expect(ml.labelImage).toHaveBeenCalledTimes(1));
      stop();
      await resumeOnce({ mode: 'count', count: 1 });
      expect(isScanning()).toBe(true);
      expect(media.getAssetInfoAsync.mock.calls.map(([asset]) => asset)).toEqual(['one', 'one']);
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      pendingLabels.resolve([{ text: 'Cat', confidence: 0.9 }]);
      await pendingRun;
    }
    expect(media.getAssetInfoAsync.mock.calls.map(([asset]) => asset)).toEqual(['one', 'one', 'one']);
    expect(ml.labelImage).toHaveBeenCalledTimes(1);
    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///test-crop.jpg', { idempotent: true });
    expect(ops.dispose).toHaveBeenCalledTimes(1);
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 1, pending: 1, error: 0 });
    expect(useScannerStore.getState()).toMatchObject({ isRunning: false, isFinalizing: false });
    expect(onComplete).not.toHaveBeenCalled();

    await resumeOnce({ mode: 'count', count: 1 }, { onComplete });
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 2, pending: 0, error: 0 });
    expect(media.getAssetInfoAsync.mock.calls.map(([asset]) => asset)).toEqual(['one', 'one', 'one', 'two', 'two', 'two']);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('preserves a failed in-flight ML asset for retry after stop without consuming the remaining queue', async () => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    const pendingLabels = deferred<Awaited<ReturnType<typeof MLKitService.labelImage>>>();
    ml.labelImage.mockReturnValueOnce(pendingLabels.promise);
    const onComplete = jest.fn();
    const pendingRun = start({ onComplete });
    try {
      await waitFor(() => expect(ml.labelImage).toHaveBeenCalledTimes(1));
      stop();
    } finally {
      // Use an independently controlled promise to model a native timeout.
      // No real ML accuracy or platform timeout behavior is claimed here.
      pendingLabels.reject(new Error('Native ML timed out'));
      await pendingRun;
    }
    expect(media.getAssetInfoAsync.mock.calls.map(([asset]) => asset)).toEqual(['one', 'one']);
    expect(fs.deleteAsync).toHaveBeenCalledTimes(1);
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 1, pending: 1, error: 0 });
    expect(await database.getFirstAsync('SELECT status FROM ai_analysis WHERE asset_id = ?', ['one'])).toEqual({ status: AssetStatus.ERROR });
    expect(onComplete).not.toHaveBeenCalled();
    expect(isScanning()).toBe(false);
    await resumeOnce({ mode: 'count', count: 2 });
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 2, pending: 0, error: 0 });
  });

  it('bounds explicit retry to one selected candidate, preserving other outdated results', async () => {
    await seed('one', AssetStatus.ERROR);
    await seed('two', AssetStatus.DONE, GLOBAL_ALGO_VERSION - 1, 200);
    const onComplete = jest.fn();
    await resumeOnce({ mode: 'count', count: 1 }, { onComplete });
    expect((await AssetRepository.getById('one'))?.status).toBe(AssetStatus.DONE);
    expect(await AssetRepository.getById('two')).toMatchObject({ status: AssetStatus.DONE, algo_version: GLOBAL_ALGO_VERSION - 1 });
    expect(media.getAssetInfoAsync).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect((await MetaRepository.getScanCursor()).takenAt).toBeNull();
  });

  it('isolates an unreadable asset, releases gray images and allows later work to succeed', async () => {
    media.getAssetInfoAsync.mockRejectedValueOnce(new Error('Asset no longer accessible'));
    await start();
    expect((await AssetRepository.getById('one'))?.status).toBe(AssetStatus.ERROR);
    expect((await AssetRepository.getById('two'))?.status).toBe(AssetStatus.DONE);
    expect(ops.dispose).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().progress).toMatchObject({ totalDone: 1, totalError: 1, isRunning: false });
  });

  it('publishes actual duplicate memberships and a valid best shot for matching photos', async () => {
    ops.hammingDistance64.mockReturnValue(0);
    await start();
    const groups = await DupGroupRepository.getAllGroups();
    expect(groups).toHaveLength(1);
    const members = await DupGroupRepository.getGroupMembers(groups[0].group_id);
    expect(members.map(member => member.asset_id).sort()).toEqual(['one', 'two']);
    expect(['one', 'two']).toContain(groups[0].best_asset_id);
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 2, error: 0, pending: 0 });
    expect(ops.dispose).toHaveBeenCalledTimes(2);
  });

  it('keeps finalization locked until its asynchronous terminal status has been published', async () => {
    media.getAssetsAsync.mockResolvedValue(page([]));
    const finalPermission = deferred<MediaLibrary.PermissionResponse>();
    media.getPermissionsAsync
      .mockResolvedValueOnce({ granted: true, accessPrivileges: 'all' } as any)
      .mockResolvedValueOnce({ granted: true, accessPrivileges: 'all' } as any)
      .mockReturnValueOnce(finalPermission.promise);
    const onComplete = jest.fn();
    const pendingRun = start({ onComplete });
    try {
      await waitFor(() => expect(useScannerStore.getState().isFinalizing).toBe(true));
      expect(isScanning()).toBe(true);
      expect(onComplete).not.toHaveBeenCalled();
      const calls = media.getAssetsAsync.mock.calls.length;
      await resumeOnce({ mode: 'count', count: 1 });
      expect(media.getAssetsAsync).toHaveBeenCalledTimes(calls);
    } finally {
      finalPermission.resolve({ granted: true, accessPrivileges: 'all' } as any);
      await pendingRun;
    }
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState()).toMatchObject({ isRunning: false, isFinalizing: false });
  });

  it('backfills existing base results once, including empty classifications, without pixel reanalysis', async () => {
    await seed('one'); await seed('two', AssetStatus.DONE, GLOBAL_ALGO_VERSION, 200);
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true, selectedAlbumIds: [] });
    const before = await AssetRepository.getById('one');
    await startClassification();
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(ml.labelImage).toHaveBeenCalledTimes(2);
    expect(await getClassificationStatus()).toEqual({ done: 2, pending: 0, error: 0 });
    expect(await AssetRepository.getById('one')).toMatchObject({ blur_score: before!.blur_score, phash: before!.phash, updated_at: before!.updated_at });
    await startClassification();
    expect(ml.labelImage).toHaveBeenCalledTimes(2);
  });
  it('analyzes Android photos without requesting location when the full-info API rejects EXIF access', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    media.getAssetInfoAsync.mockRejectedValue(new Error('missing ACCESS_MEDIA_LOCATION permission'));
    await start();
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 2, error: 0 });
    expect(ops.resizeToGray256).toHaveBeenCalledWith('file:///one.jpg');
    expect(media.getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({
      resolveWithFullInfo: false, createdAfter: 99, createdBefore: 101,
    }));
  });
  it('backfills Android AI through metadata-only reads and rejects edits during inference', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    await seed('one');
    media.getAssetsAsync.mockResolvedValue(page([photo('one')]));
    media.getAssetInfoAsync.mockRejectedValue(new Error('missing ACCESS_MEDIA_LOCATION permission'));
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    const before = await AssetRepository.getById('one');
    ml.labelImage.mockImplementationOnce(async () => {
      media.getAssetsAsync.mockResolvedValue(page([{ ...photo('one'), modificationTime: 2 }]));
      return [{ text: 'Cat', confidence: 0.9 }];
    });
    await startClassification();
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(ml.labelImage).toHaveBeenCalledTimes(1);
    expect((await AssetRepository.getById('one'))?.labels_json).toBeNull();
    expect(await AssetRepository.getById('one')).toMatchObject({ status: AssetStatus.DONE, updated_at: before!.updated_at });
  });
  it('does not apply the Android location fallback to iOS failures', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    media.getAssetInfoAsync.mockRejectedValue(new Error('missing ACCESS_MEDIA_LOCATION permission'));
    await start();
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 0, error: 2 });
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(media.getAssetsAsync.mock.calls.some(([options]) => options?.resolveWithFullInfo === false)).toBe(false);
  });
  it('stops a broken fallback cursor without analyzing a different photo', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    media.getAssetInfoAsync.mockRejectedValue(new Error('missing ACCESS_MEDIA_LOCATION permission'));
    media.getAssetsAsync.mockImplementation(async options => options?.resolveWithFullInfo === false
      ? page([photo('unrelated')], true, 'repeated-cursor') : page([photo('one')]));
    await start();
    expect((await AssetRepository.getById('one'))?.status).toBe(AssetStatus.ERROR);
    expect(ops.resizeToGray256).not.toHaveBeenCalled();
    expect(media.getAssetsAsync.mock.calls.filter(([options]) => options?.resolveWithFullInfo === false)).toHaveLength(2);
  });
  it('finds an Android photo with an unknown creation time on a later page without guessing a timestamp', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    media.getAssetInfoAsync.mockRejectedValue(new Error('missing ACCESS_MEDIA_LOCATION permission'));
    media.getAssetsAsync.mockImplementation(async options => {
      if (options?.resolveWithFullInfo === false) {
        expect(options.createdAfter).toBeUndefined(); expect(options.createdBefore).toBeUndefined();
        return options.after ? page([photo('one', 0)]) : page([], true, 'metadata-page');
      }
      return page([photo('one', 0)]);
    });
    await start();
    expect((await AssetRepository.getById('one'))?.status).toBe(AssetStatus.DONE);
    expect(ops.resizeToGray256).toHaveBeenCalledTimes(1);
  });

  it('does not publish a classification when access is revoked during inference', async () => {
    await seed('one');
    media.getAssetsAsync.mockResolvedValue(page([photo('one')]));
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    ml.labelImage.mockImplementationOnce(async () => {
      media.getPermissionsAsync.mockResolvedValue({ granted: false, accessPrivileges: 'none' } as any);
      return [{ text: 'Cat', confidence: 0.9 }];
    });
    await startClassification();
    expect((await AssetRepository.getById('one'))?.labels_json).toBeNull();
    expect((await AssetRepository.getById('one'))?.status).toBe(AssetStatus.DONE);
  });

  it('stops before another image when ML crop cleanup fails, preserving base results and allowing retry after cleanup', async () => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    fs.deleteAsync.mockRejectedValueOnce(new Error('PRIVATE_CROP_PATH_DELETE_FAILURE'));
    const onComplete = jest.fn();
    await start({ onComplete });
    expect(usePrivacyStore.getState().failures.cache).toBe('read');
    expect(ml.labelImage).toHaveBeenCalledTimes(1);
    expect(ops.resizeToGray256).toHaveBeenCalledTimes(1);
    expect((await AssetRepository.getById('one'))?.status).toBe(AssetStatus.DONE);
    expect((await AssetRepository.getById('two'))?.status).toBe(AssetStatus.PENDING);
    expect(onComplete).not.toHaveBeenCalled();
    await resumeOnce({ mode: 'count', count: 1 });
    expect(ml.labelImage).toHaveBeenCalledTimes(1);
    usePrivacyStore.getState().clear('cache');
    await resumeOnce({ mode: 'count', count: 1 });
    expect((await AssetRepository.getById('two'))?.status).toBe(AssetStatus.DONE);
  });

  it('cleans up a temporary ML crop and stops AI after four failures while preserving committed base results', async () => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    media.getAssetsAsync.mockResolvedValue(page(Array.from({ length: 5 }, (_, i) => photo(`ml-${i}`, 100 + i))));
    ml.labelImage.mockRejectedValue(new Error('Model unavailable'));
    const onComplete = jest.fn();
    await start({ onComplete });
    expect(ml.labelImage).toHaveBeenCalledTimes(4);
    expect(fs.deleteAsync).toHaveBeenCalledTimes(4);
    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///test-crop.jpg', { idempotent: true });
    expect(ops.dispose).toHaveBeenCalledTimes(4);
    expect((await AssetRepository.getById('ml-0'))?.status).toBe(AssetStatus.DONE);
    expect(await database.getFirstAsync('SELECT COUNT(*) AS count FROM ai_analysis WHERE status = 2')).toEqual({ count: 4 });
    expect((await AssetRepository.getById('ml-4'))?.status).toBe(AssetStatus.PENDING);
    expect(useScannerStore.getState().lastError?.message).toMatch(/repeated failures/);
    expect(onComplete).not.toHaveBeenCalled();

    // A later explicit retry must not inherit the previous run's breaker.
    ml.labelImage.mockResolvedValue([{ text: 'Cat', confidence: 0.9, index: 0 }] as any);
    await resumeOnce({ mode: 'count', count: 5 });
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 5, error: 0, pending: 0 });
    expect((await AssetRepository.getById('ml-4'))?.labels_json).toContain('Cat');
  });

  it('does not mark an asset as AI ERROR when LocalPrivacyError aborts crop cleanup', async () => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    fs.deleteAsync.mockRejectedValueOnce(new Error('PRIVATE_CROP_PATH_DELETE_FAILURE'));
    await start();
    expect(usePrivacyStore.getState().failures.cache).toBe('read');
    expect(await database.getFirstAsync('SELECT COUNT(*) AS count FROM ai_analysis WHERE status = 2')).toEqual({ count: 0 });
  });

  it('downscales high-resolution photos before face detection, computes ratio against scaled size, and cleans temp file', async () => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    const hugePhoto = { ...photo('huge', 100), width: 8000, height: 6000 } as MediaLibrary.Asset;
    media.getAssetsAsync.mockResolvedValue(page([hugePhoto]));
    media.getAssetInfoAsync.mockResolvedValue({ ...hugePhoto, localUri: 'file:///huge.jpg' } as MediaLibrary.AssetInfo);
    // 150px face on 1024px scaled width = 14.6% (> 10%), whereas on 8000px raw width it would be 1.8%.
    ml.detectFaces.mockResolvedValueOnce([{ boundingBox: { x: 100, y: 100, width: 150, height: 150 }, confidence: 0.9 }]);

    await start();

    expect(ops.resizeForFaceDetection).toHaveBeenCalledWith('file:///huge.jpg', 8000, 6000, 1024);
    expect(ml.detectFaces).toHaveBeenCalledWith('file:///test-face-resized.jpg');
    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///test-face-resized.jpg', { idempotent: true });
    expect((await AssetRepository.getById('huge'))?.face_count).toBe(1);
  });

  it('avoids repeated full-library pagination per asset during limited-access AI backfill', async () => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true, selectedAlbumIds: [] });
    media.getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'limited' } as any);
    const items = [photo('a', 100), photo('b', 200), photo('c', 300)];
    for (const item of items) await seed(item.id, AssetStatus.DONE, GLOBAL_ALGO_VERSION, item.creationTime);
    media.getAssetsAsync.mockResolvedValue(page(items));
    media.getAssetInfoAsync.mockImplementation(async asset => {
      const id = typeof asset === 'string' ? asset : asset.id;
      const found = items.find(item => item.id === id)!;
      return { ...found, localUri: found.uri } as MediaLibrary.AssetInfo;
    });

    await startClassification();

    // Expected getAssetsAsync calls: sync(1) + limited verification(1) + initial status(1) + final status(1) + finalizer status(1) = 5.
    // Previously each of the 3 assets added 2 more full-library scans (+6 = 11+).
    expect(media.getAssetsAsync.mock.calls.length).toBeLessThanOrEqual(6);
    expect(await getClassificationStatus()).toEqual({ done: 3, pending: 0, error: 0 });
  });

  it('skips FileSystem stat for valid unchanged assets while refreshing missing-size, edited, and error-isolated assets', async () => {
    await AssetRepository.upsertBatch([
      {
        asset_id: 'valid-file',
        taken_at: 100,
        width: 1000,
        height: 800,
        file_signature: '1700000000_204800',
        status: AssetStatus.DONE,
        algo_version: GLOBAL_ALGO_VERSION,
        blur_score: 120,
        mean_luma: 140,
        phash: 'aaaaaaaaaaaaaaaa',
      },
      {
        asset_id: 'missing-size',
        taken_at: 200,
        width: 1000,
        height: 800,
        file_signature: '1700000000_0',
        status: AssetStatus.DONE,
        algo_version: GLOBAL_ALGO_VERSION,
        blur_score: 120,
        mean_luma: 140,
        phash: 'bbbbbbbbbbbbbbbb',
      },
      {
        asset_id: 'edited-file',
        taken_at: 300,
        width: 1000,
        height: 800,
        file_signature: '1700000000_409600',
        status: AssetStatus.DONE,
        algo_version: GLOBAL_ALGO_VERSION,
        blur_score: 120,
        mean_luma: 140,
        phash: 'cccccccccccccccc',
      },
      {
        asset_id: 'group-peer',
        taken_at: 305,
        width: 1000,
        height: 800,
        file_signature: '1700000000_409601',
        status: AssetStatus.DONE,
        algo_version: GLOBAL_ALGO_VERSION,
        blur_score: 120,
        mean_luma: 140,
        phash: 'dddddddddddddddd',
      },
    ]);
    await DupGroupRepository.createGroup('grp-edit', 'edited-file');
    await DupGroupRepository.addMember('grp-edit', 'edited-file', 0);
    await DupGroupRepository.addMember('grp-edit', 'group-peer', 2);
    await MetaRepository.setScanCursor(500, 'cursor-anchor');

    const assets: MediaLibrary.Asset[] = [
      { ...photo('valid-file', 100), modificationTime: 1700000000000 },
      { ...photo('missing-size', 200), modificationTime: 1700000000000 },
      { ...photo('edited-file', 300), modificationTime: 1700000500000 },
      { ...photo('group-peer', 305), modificationTime: 1700000000000 },
      { ...photo('stat-throws', 400), modificationTime: 1700000600000 },
    ];
    media.getAssetsAsync.mockResolvedValue(page(assets));
    fs.getInfoAsync.mockImplementation(async (uri: string) => {
      if (uri.includes('missing-size')) return { exists: true, uri, isDirectory: false, modificationTime: 1700000000, size: 512000 } as any;
      if (uri.includes('edited-file')) return { exists: true, uri, isDirectory: false, modificationTime: 1700000500, size: 614400 } as any;
      if (uri.includes('stat-throws')) throw new Error('Simulated stat failure');
      return { exists: true, uri, isDirectory: false, modificationTime: 1700000000, size: 204800 } as any;
    });

    // Stop right after sync finishes (when processBatch waits for interactions)
    // so we isolate sync effects cleanly.
    jest.mocked(InteractionManager.runAfterInteractions).mockImplementationOnce((task: any) => {
      stop();
      task();
      return { cancel: jest.fn(), then: jest.fn(), done: jest.fn() } as any;
    });

    fs.getInfoAsync.mockClear();
    await start();

    const checkedUris = fs.getInfoAsync.mock.calls.map(([uri]) => uri);
    expect(checkedUris).not.toContain('file:///valid-file.jpg');
    expect(checkedUris).not.toContain('file:///group-peer.jpg');
    expect(checkedUris.sort()).toEqual([
      'file:///edited-file.jpg',
      'file:///missing-size.jpg',
      'file:///stat-throws.jpg',
    ]);

    expect(await AssetRepository.getById('valid-file')).toMatchObject({ status: AssetStatus.DONE, file_signature: '1700000000_204800' });
    expect(await AssetRepository.getById('missing-size')).toMatchObject({ status: AssetStatus.PENDING, file_signature: '1700000000_512000' });
    expect(await AssetRepository.getById('edited-file')).toMatchObject({ status: AssetStatus.PENDING, file_signature: '1700000500_614400' });
    expect(await AssetRepository.getById('stat-throws')).toMatchObject({
      status: AssetStatus.PENDING,
      file_signature: 'library_1700000600000_1000_800',
    });
    expect(await DupGroupRepository.getAllGroups()).toEqual([]);
    expect((await MetaRepository.getScanCursor()).takenAt).toBeNull();
  });

  it('removes missing assets and their similar_reviews on complete full-access sync while keeping intact groups', async () => {
    await seed('gone-a', AssetStatus.DONE, GLOBAL_ALGO_VERSION, 100);
    await seed('stay-b', AssetStatus.DONE, GLOBAL_ALGO_VERSION, 101);
    await seed('keep-c', AssetStatus.DONE, GLOBAL_ALGO_VERSION, 200);
    await seed('keep-d', AssetStatus.DONE, GLOBAL_ALGO_VERSION, 201);

    await DupGroupRepository.createGroup('grp-gone', 'gone-a');
    await DupGroupRepository.addMember('grp-gone', 'gone-a', 0);
    await DupGroupRepository.addMember('grp-gone', 'stay-b', 1);
    await DupGroupRepository.updateBestAsset('grp-gone', 'stay-b');
    const goneSnapshot = (await SimilarReviewRepository.getSnapshot('grp-gone'))!;
    await SimilarReviewRepository.save('grp-gone', goneSnapshot.key, ['stay-b'], ['gone-a']);

    await DupGroupRepository.createGroup('grp-intact', 'keep-c');
    await DupGroupRepository.addMember('grp-intact', 'keep-c', 0);
    await DupGroupRepository.addMember('grp-intact', 'keep-d', 1);
    await DupGroupRepository.updateBestAsset('grp-intact', 'keep-c');
    const intactSnapshot = (await SimilarReviewRepository.getSnapshot('grp-intact'))!;
    await SimilarReviewRepository.save('grp-intact', intactSnapshot.key, ['keep-c', 'keep-d'], []);

    // External deletion removed `gone-a`; the other three photos remain unchanged.
    media.getAssetsAsync.mockResolvedValue(page([
      photo('stay-b', 101),
      photo('keep-c', 200),
      photo('keep-d', 201),
    ]));

    await start();

    expect(await AssetRepository.getById('gone-a')).toBeNull();
    expect(await AssetRepository.getById('stay-b')).not.toBeNull();
    expect(await SimilarReviewRepository.getReview(goneSnapshot)).toBeNull();
    expect(await SimilarReviewRepository.getReview(intactSnapshot)).toMatchObject({
      keptIds: ['keep-c', 'keep-d'],
      pendingIds: [],
    });
    expect((await DupGroupRepository.getAllGroups()).map(g => g.group_id)).toEqual(['grp-intact']);
  });

  it('commits completed sync pages safely on mid-sync stop and skips them on resume without re-statting', async () => {
    await seed('unseen-should-survive', AssetStatus.DONE, GLOBAL_ALGO_VERSION, 999);
    const page1 = [photo('p1-a', 100), photo('p1-b', 101)];
    const page2 = [photo('p2-a', 200), photo('p2-b', 201)];
    const pendingPage2 = deferred<ReturnType<typeof page>>();

    media.getAssetsAsync
      .mockResolvedValueOnce(page(page1, true, 'cursor-1'))
      .mockReturnValueOnce(pendingPage2.promise);

    const run1 = start();
    try {
      await waitFor(() => expect(media.getAssetsAsync).toHaveBeenCalledTimes(2));
      stop();
    } finally {
      pendingPage2.resolve(page(page2, false, 'cursor-2'));
      await run1;
    }

    // Page 1 was persisted in its own transaction; page 2 and missing-asset pruning did not run.
    expect(await AssetRepository.getById('p1-a')).not.toBeNull();
    expect(await AssetRepository.getById('p1-b')).not.toBeNull();
    expect(await AssetRepository.getById('p2-a')).toBeNull();
    expect(await AssetRepository.getById('unseen-should-survive')).not.toBeNull();

    // Resume sync: page 1 assets are already indexed and must not be re-statted.
    fs.getInfoAsync.mockClear();
    media.getAssetsAsync
      .mockResolvedValueOnce(page(page1, true, 'cursor-1'))
      .mockResolvedValueOnce(page(page2, false, 'cursor-2'));
    jest.mocked(InteractionManager.runAfterInteractions).mockImplementationOnce((task: any) => {
      stop();
      task();
      return { cancel: jest.fn(), then: jest.fn(), done: jest.fn() } as any;
    });

    await start();

    const resumedCheckedUris = fs.getInfoAsync.mock.calls.map(([uri]) => uri).sort();
    expect(resumedCheckedUris).toEqual(['file:///p2-a.jpg', 'file:///p2-b.jpg']);
    expect(await AssetRepository.getById('p2-a')).not.toBeNull();
    expect(await AssetRepository.getById('p2-b')).not.toBeNull();
    expect(await AssetRepository.getById('unseen-should-survive')).toBeNull();
  });

  it('bounds concurrent FileSystem.getInfoAsync calls during sync and converges transactions to page count on 350+ assets', async () => {
    const totalAssets = 350;
    const allPhotos = Array.from({ length: totalAssets }, (_, index) => ({
      ...photo(`bulk-${index}`, 1000 + index),
      modificationTime: 1700000000000 + index * 1000,
    }));

    const pages = [
      page(allPhotos.slice(0, 100), true, 'c-100'),
      page(allPhotos.slice(100, 200), true, 'c-200'),
      page(allPhotos.slice(200, 300), true, 'c-300'),
      page(allPhotos.slice(300, 350), false, 'c-350'),
    ];
    let pageIdx = 0;
    media.getAssetsAsync.mockImplementation(async () => pages[pageIdx++] ?? page([]));

    let activeStats = 0;
    let maxConcurrentStats = 0;
    fs.getInfoAsync.mockImplementation(async (uri: string) => {
      activeStats += 1;
      maxConcurrentStats = Math.max(maxConcurrentStats, activeStats);
      await new Promise(resolve => setTimeout(resolve, 1));
      activeStats -= 1;
      const idx = Number(uri.match(/bulk-(\d+)/)?.[1] ?? 0);
      return {
        exists: true,
        uri,
        isDirectory: false,
        modificationTime: 1700000000 + idx,
        size: 10000 + idx,
      } as any;
    });

    // Stop immediately after sync finishes to measure sync-only transaction count.
    jest.mocked(InteractionManager.runAfterInteractions).mockImplementationOnce((task: any) => {
      stop();
      task();
      return { cancel: jest.fn(), then: jest.fn(), done: jest.fn() } as any;
    });

    (withTransaction as jest.Mock).mockClear();
    fs.getInfoAsync.mockClear();
    const syncBatchSpy = jest.spyOn(AssetRepository, 'syncLibraryMetadataBatch');
    const getByIdsSpy = jest.spyOn(AssetRepository, 'getByIds');

    await start();

    const firstSyncTransactions = (withTransaction as jest.Mock).mock.calls.length;
    expect(maxConcurrentStats).toBeGreaterThan(1);
    expect(maxConcurrentStats).toBeLessThanOrEqual(16);
    expect(fs.getInfoAsync).toHaveBeenCalledTimes(totalAssets);
    expect(getByIdsSpy).toHaveBeenCalledTimes(4);
    expect(syncBatchSpy).toHaveBeenCalledTimes(4);
    // 4 page sync transactions + O(1) setup transactions (cursor reset, algo version, recovery/outdated checks),
    // down from 350+ per-asset transactions.
    expect(firstSyncTransactions).toBeLessThanOrEqual(8);
    expect(await AssetRepository.getStatusCounts()).toEqual({ pending: totalAssets, done: 0, error: 0 });

    // Re-syncing the exact same 350 unchanged assets must skip FileSystem stat and open 0 sync write transactions.
    pageIdx = 0;
    (withTransaction as jest.Mock).mockClear();
    fs.getInfoAsync.mockClear();
    syncBatchSpy.mockClear();
    getByIdsSpy.mockClear();
    jest.mocked(InteractionManager.runAfterInteractions).mockImplementationOnce((task: any) => {
      stop();
      task();
      return { cancel: jest.fn(), then: jest.fn(), done: jest.fn() } as any;
    });

    await start();

    expect(getByIdsSpy).toHaveBeenCalledTimes(4);
    expect(fs.getInfoAsync).not.toHaveBeenCalled();
    expect(syncBatchSpy).not.toHaveBeenCalled();
    // Only the O(1) recovery/outdated checks run after sync; zero sync transactions.
    expect((withTransaction as jest.Mock).mock.calls.length).toBeLessThanOrEqual(2);
    syncBatchSpy.mockRestore();
    getByIdsSpy.mockRestore();
  });
});
