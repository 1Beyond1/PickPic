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
import { InteractionManager } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { AssetRepository, AssetStatus, AssetStatusType, DupGroupRepository, GLOBAL_ALGO_VERSION, MetaRepository } from '../../database';
import { getDatabase, withTransaction } from '../../database/db';
import { getImageOps } from '../../services/imageOps';
import { MLKitService } from '../../services/ml/MLKitService';
import { getStatus, isScanning, resumeOnce, start, stop } from '../../services/scanner/AIScanner';
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
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

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
  };

  beforeEach(() => {
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
      return { ...photo(id), localUri: `file:///${id}.jpg` } as MediaLibrary.AssetInfo;
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

  it('cleans up a temporary ML crop on failure and stops after four failures rather than publishing base-only success', async () => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({ enableAIClassification: true });
    media.getAssetsAsync.mockResolvedValue(page(Array.from({ length: 5 }, (_, i) => photo(`ml-${i}`, 100 + i))));
    ml.labelImage.mockRejectedValue(new Error('Model unavailable'));
    const onComplete = jest.fn();
    await start({ onComplete });
    expect(ml.labelImage).toHaveBeenCalledTimes(4);
    expect(fs.deleteAsync).toHaveBeenCalledTimes(4);
    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///test-crop.jpg', { idempotent: true });
    expect(ops.dispose).toHaveBeenCalledTimes(4);
    expect((await AssetRepository.getById('ml-0'))?.status).toBe(AssetStatus.ERROR);
    expect((await AssetRepository.getById('ml-4'))?.status).toBe(AssetStatus.PENDING);
    expect(useScannerStore.getState().lastError?.message).toMatch(/repeated failures/);
    expect(onComplete).not.toHaveBeenCalled();

    // A later explicit retry must not inherit the previous run's breaker.
    ml.labelImage.mockResolvedValue([{ text: 'Cat', confidence: 0.9, index: 0 }] as any);
    await resumeOnce({ mode: 'count', count: 5 });
    expect(await AssetRepository.getStatusCounts()).toMatchObject({ done: 5, error: 0, pending: 0 });
    expect((await AssetRepository.getById('ml-4'))?.labels_json).toContain('Cat');
  });
});
