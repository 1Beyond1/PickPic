const mockDeleteAssetsAsync = jest.fn();
const mockGetPermissionsAsync = jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' });
const mockCloseDatabase = jest.fn().mockResolvedValue(undefined);
const mockGetDatabase = jest.fn().mockResolvedValue({});
const mockResetDbFiles = jest.fn().mockResolvedValue(undefined);
const mockResetStorageKeys = jest.fn().mockResolvedValue(undefined);
const mockDisableStorageWrites = jest.fn();
const mockDeleteDeviceKey = jest.fn().mockResolvedValue(undefined);
const mockProbeDeviceKeystore = jest.fn().mockResolvedValue(undefined);
const mockResetPersistence = jest.fn().mockResolvedValue(undefined);
const mockResumeMediaWrites = jest.fn();
const mockSuspendMediaWrites = jest.fn<() => void, []>(() => mockResumeMediaWrites);
const mockResetSettingsPersistence = jest.fn().mockResolvedValue(undefined);
const mockResumeSettingsWrites = jest.fn();
const mockSuspendSettingsWrites = jest.fn<() => void, []>(() => mockResumeSettingsWrites);
const mockResetBackupChanges = jest.fn().mockResolvedValue(undefined);
const mockResumeBackupChanges = jest.fn();
const mockSuspendBackupChanges = jest.fn<() => void, []>(() => mockResumeBackupChanges);
const mockSettingsSetState = jest.fn();
const mockRestoreRecords = jest.fn().mockResolvedValue({
  kept: 2, collected: 0, pendingDeletion: 0, skipped: 0, existing: 0,
  rebound: 1, ambiguousSkipped: 0, protectedAlbums: 1, reviewIgnores: 0,
});
const mockSettingsRehydrate = jest.fn().mockResolvedValue(undefined);
const mockMediaRehydrate = jest.fn().mockResolvedValue(undefined);
const mockLoadProtectedAlbums = jest.fn().mockResolvedValue(undefined);
const mockRefreshTotalCounts = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-media-library', () => ({
  deleteAssetsAsync: (...args: any[]) => mockDeleteAssetsAsync(...args),
  getPermissionsAsync: (...args: any[]) => mockGetPermissionsAsync(...args),
}));
jest.mock('../../database/db', () => ({
  closeDatabase: (...args: any[]) => mockCloseDatabase(...args),
  getDatabase: (...args: any[]) => mockGetDatabase(...args),
}));
jest.mock('../../database/encryptedDatabase', () => ({
  resetEncryptedDatabaseFiles: (...args: any[]) => mockResetDbFiles(...args),
}));
jest.mock('../../services/privacy/encryptedStorage', () => ({
  disableEncryptedStorageWrites: (...args: any[]) => mockDisableStorageWrites(...args),
  resetEncryptedStorageKeys: (...args: any[]) => mockResetStorageKeys(...args),
}));
jest.mock('../../services/privacy/deviceKey', () => ({
  deleteDeviceKey: (...args: any[]) => mockDeleteDeviceKey(...args),
  probeDeviceKeystore: (...args: any[]) => mockProbeDeviceKeystore(...args),
}));
jest.mock('../../services/privacy/mediaCache', () => ({
  clearLegacyMediaCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/mediaProgressStorage', () => ({
  resetMediaProgressPersistenceState: (...args: any[]) => mockResetPersistence(...args),
  suspendMediaProgressWrites: () => mockSuspendMediaWrites(),
}));
jest.mock('../../services/privacy/settingsStorage', () => ({
  resetSettingsPersistenceState: (...args: any[]) => mockResetSettingsPersistence(...args),
  suspendSettingsWrites: () => mockSuspendSettingsWrites(),
}));
jest.mock('../../services/backup/changeTracker', () => ({
  resetBackupChangeState: (...args: any[]) => mockResetBackupChanges(...args),
  suspendBackupChangeWrites: () => mockSuspendBackupChanges(),
}));
jest.mock('../../services/scanner', () => ({
  isScanning: () => false,
  stop: jest.fn(),
}));
jest.mock('../../services/backup/records', () => ({
  restoreEncryptedRecords: (...args: any[]) => mockRestoreRecords(...args),
}));
jest.mock('../../stores/useSettingsStore', () => ({
  DEFAULT_SETTINGS_STATE: { groupSize: 10, theme: 'light', hasHydrated: false },
  useSettingsStore: {
    setState: (...args: any[]) => mockSettingsSetState(...args),
    persist: { rehydrate: (...args: any[]) => mockSettingsRehydrate(...args) },
  },
}));
jest.mock('../../stores/useMediaStore', () => ({
  useMediaStore: {
    setState: jest.fn(),
    getState: () => ({
      loadProtectedAlbums: mockLoadProtectedAlbums,
      refreshTotalCounts: mockRefreshTotalCounts,
    }),
    persist: { rehydrate: (...args: any[]) => mockMediaRehydrate(...args) },
  },
}));

import { LocalPrivacyError, usePrivacyStore } from '../../stores/usePrivacyStore';
import {
  recoverFromEncryptedBackup,
  resetLocalPrivacyIndex,
  resolvePrimaryFailureDomain,
} from '../../services/privacy/recovery';

describe('privacy self-rescue recovery service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    mockProbeDeviceKeystore.mockResolvedValue(undefined);
    usePrivacyStore.setState({ failures: {}, reasons: {}, recoveryDepth: 0, recovering: false });
  });

  it('prioritizes failure domains accurately: keystore > sqlcipher > schema > storage_io', () => {
    expect(resolvePrimaryFailureDomain({}, {})).toBeNull();
    expect(resolvePrimaryFailureDomain(
      { scanner: 'read', records: 'read' },
      { scanner: 'schema_corrupt', records: 'cipher_decrypt_failed' },
    )).toBe('cipher_decrypt_failed');
    expect(resolvePrimaryFailureDomain(
      { scanner: 'read', settings: 'read' },
      { scanner: 'cipher_decrypt_failed', settings: 'keystore_unavailable' },
    )).toBe('keystore_unavailable');
    expect(resolvePrimaryFailureDomain(
      { scanner: 'read' },
      { scanner: 'schema_corrupt' },
    )).toBe('schema_corrupt');
  });

  it('resets only local privacy index files and keys without ever touching media library originals', async () => {
    usePrivacyStore.getState().block('scanner', 'read', 'cipher_decrypt_failed');
    usePrivacyStore.getState().block('records', 'read', 'keystore_unavailable');

    await resetLocalPrivacyIndex();

    expect(mockProbeDeviceKeystore).toHaveBeenCalledTimes(1);
    expect(mockCloseDatabase).toHaveBeenCalledTimes(1);
    expect(mockResetDbFiles).toHaveBeenCalledTimes(1);
    expect(mockResetStorageKeys).toHaveBeenCalledTimes(1);
    expect(mockDeleteDeviceKey).toHaveBeenCalledWith('scanner');
    expect(mockDeleteDeviceKey).toHaveBeenCalledWith('records');
    expect(mockDeleteDeviceKey).toHaveBeenCalledWith('settings');
    expect(mockResetPersistence).toHaveBeenCalledTimes(1);
    expect(mockResetSettingsPersistence).toHaveBeenCalledTimes(1);
    expect(mockSettingsSetState).toHaveBeenCalledWith(expect.objectContaining({ hasHydrated: false }));
    expect(mockGetDatabase).toHaveBeenCalledTimes(1);
    expect(mockSettingsRehydrate).toHaveBeenCalledTimes(1);
    expect(mockMediaRehydrate).toHaveBeenCalledTimes(1);
    expect(usePrivacyStore.getState().failures).toEqual({});
    expect(usePrivacyStore.getState().reasons).toEqual({});
    expect(usePrivacyStore.getState().recovering).toBe(false);
    expect(mockDeleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('aborts resetLocalPrivacyIndex BEFORE wiping local ciphertext when Keystore probe fails', async () => {
    mockProbeDeviceKeystore.mockRejectedValueOnce(new LocalPrivacyError('keystore_unavailable'));
    usePrivacyStore.getState().block('scanner', 'read', 'keystore_unavailable');

    await expect(resetLocalPrivacyIndex()).rejects.toMatchObject({ reason: 'keystore_unavailable' });

    expect(mockCloseDatabase).not.toHaveBeenCalled();
    expect(mockResetDbFiles).not.toHaveBeenCalled();
    expect(mockResetStorageKeys).not.toHaveBeenCalled();
    expect(mockDeleteDeviceKey).not.toHaveBeenCalled();
    expect(usePrivacyStore.getState().failures).toEqual({ scanner: 'read' });
    expect(usePrivacyStore.getState().recovering).toBe(false);
  });

  it('aborts recoverFromEncryptedBackup BEFORE wiping local index when required photo permission is missing', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ granted: false, accessPrivileges: 'none' });
    const payload = {
      version: 2 as const,
      platform: 'android' as const,
      records: [{
        id: 'p1',
        kind: 'photo' as const,
        decision: 'keep' as const,
        fingerprint: 'a'.repeat(64),
        contentFingerprint: { signature: 'b'.repeat(64), baseSignature: 'c'.repeat(64), creationTime: 1, hasFileSize: false },
      }],
      protectedAlbums: [],
      reviewIgnores: [],
    };

    await expect(recoverFromEncryptedBackup(payload, false)).rejects.toMatchObject({ code: 'permission' });

    expect(mockResetDbFiles).not.toHaveBeenCalled();
    expect(mockResetStorageKeys).not.toHaveBeenCalled();
    expect(mockRestoreRecords).not.toHaveBeenCalled();
  });

  it('P1-1: aborts recoverFromEncryptedBackup BEFORE wiping local index when mixed photo+video backup lacks video permission', async () => {
    mockGetPermissionsAsync.mockImplementation(async (_write: boolean, granular?: string[]) => {
      if (granular?.includes('photo')) return { granted: true, accessPrivileges: 'all' };
      if (granular?.includes('video')) return { granted: false, accessPrivileges: 'none' };
      return { granted: false, accessPrivileges: 'none' };
    });
    const mixedPayload = {
      version: 2 as const,
      platform: 'android' as const,
      records: [
        {
          id: 'p1',
          kind: 'photo' as const,
          decision: 'keep' as const,
          fingerprint: 'a'.repeat(64),
          contentFingerprint: { signature: 'b'.repeat(64), baseSignature: 'c'.repeat(64), creationTime: 1, hasFileSize: false },
        },
        {
          id: 'v1',
          kind: 'video' as const,
          decision: 'keep' as const,
          fingerprint: 'd'.repeat(64),
          contentFingerprint: { signature: 'e'.repeat(64), baseSignature: 'f'.repeat(64), creationTime: 2, hasFileSize: false },
        },
      ],
      protectedAlbums: [],
      reviewIgnores: [],
    };

    await expect(recoverFromEncryptedBackup(mixedPayload, false)).rejects.toMatchObject({ code: 'permission' });

    expect(mockGetPermissionsAsync).toHaveBeenCalledWith(false, ['photo']);
    expect(mockGetPermissionsAsync).toHaveBeenCalledWith(false, ['video']);
    expect(mockCloseDatabase).not.toHaveBeenCalled();
    expect(mockResetDbFiles).not.toHaveBeenCalled();
    expect(mockResetStorageKeys).not.toHaveBeenCalled();
    expect(mockDeleteDeviceKey).not.toHaveBeenCalled();
    expect(mockRestoreRecords).not.toHaveBeenCalled();
  });

  it('P1-2: suspends new writes and awaits draining all persistence queues BEFORE closing DB or deleting ciphertexts/keys', async () => {
    const events: string[] = [];
    let releaseMediaDrain!: () => void;
    let releaseSettingsDrain!: () => void;
    let releaseChangeDrain!: () => void;

    mockSuspendMediaWrites.mockImplementationOnce(() => {
      events.push('suspend:media');
      return () => { events.push('resume:media'); };
    });
    mockSuspendSettingsWrites.mockImplementationOnce(() => {
      events.push('suspend:settings');
      return () => { events.push('resume:settings'); };
    });
    mockSuspendBackupChanges.mockImplementationOnce(() => {
      events.push('suspend:changes');
      return () => { events.push('resume:changes'); };
    });
    mockDisableStorageWrites.mockImplementationOnce(() => {
      events.push('disable:encryptedStorage');
    });
    mockResetPersistence.mockImplementationOnce(() => new Promise<void>(resolve => {
      events.push('drain-start:media');
      releaseMediaDrain = () => { events.push('drain-end:media'); resolve(); };
    }));
    mockResetSettingsPersistence.mockImplementationOnce(() => new Promise<void>(resolve => {
      events.push('drain-start:settings');
      releaseSettingsDrain = () => { events.push('drain-end:settings'); resolve(); };
    }));
    mockResetBackupChanges.mockImplementationOnce(() => new Promise<void>(resolve => {
      events.push('drain-start:changes');
      releaseChangeDrain = () => { events.push('drain-end:changes'); resolve(); };
    }));
    mockCloseDatabase.mockImplementationOnce(async () => { events.push('closeDatabase'); });
    mockResetDbFiles.mockImplementationOnce(async () => { events.push('resetDbFiles'); });
    mockResetStorageKeys.mockImplementationOnce(async () => { events.push('resetStorageKeys'); });
    mockDeleteDeviceKey.mockImplementation(async (scope: string) => { events.push(`deleteKey:${scope}`); });
    mockGetDatabase.mockImplementationOnce(async () => { events.push('getDatabase'); return {}; });

    const resetPromise = resetLocalPrivacyIndex();

    // Wait for media drain to start; closeDatabase/reset/deleteKey MUST NOT have run yet!
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toContain('disable:encryptedStorage');
    expect(events).toContain('drain-start:media');
    expect(mockCloseDatabase).not.toHaveBeenCalled();
    expect(mockResetDbFiles).not.toHaveBeenCalled();
    expect(mockResetStorageKeys).not.toHaveBeenCalled();
    expect(mockDeleteDeviceKey).not.toHaveBeenCalled();

    releaseMediaDrain();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toContain('drain-start:settings');
    expect(mockCloseDatabase).not.toHaveBeenCalled();

    releaseSettingsDrain();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toContain('drain-start:changes');
    expect(mockCloseDatabase).not.toHaveBeenCalled();

    releaseChangeDrain();
    await resetPromise;

    const drainEndIdx = Math.max(
      events.indexOf('drain-end:media'),
      events.indexOf('drain-end:settings'),
      events.indexOf('drain-end:changes'),
    );
    const closeIdx = events.indexOf('closeDatabase');
    const wipeDbIdx = events.indexOf('resetDbFiles');
    const wipeStorageIdx = events.indexOf('resetStorageKeys');
    const deleteKeyIdx = events.indexOf('deleteKey:scanner');
    const resumeIdx = Math.min(
      events.indexOf('resume:media'),
      events.indexOf('resume:settings'),
      events.indexOf('resume:changes'),
    );
    const reopenIdx = events.indexOf('getDatabase');

    expect(drainEndIdx).toBeGreaterThan(-1);
    expect(drainEndIdx).toBeLessThan(closeIdx);
    expect(closeIdx).toBeLessThan(wipeDbIdx);
    expect(wipeDbIdx).toBeLessThan(wipeStorageIdx);
    expect(wipeStorageIdx).toBeLessThan(deleteKeyIdx);
    expect(deleteKeyIdx).toBeLessThan(resumeIdx);
    expect(resumeIdx).toBeLessThan(reopenIdx);
  });

  it('recovers from an already-verified backup payload while keeping recovery gate locked until restore completes', async () => {
    let recoveringDuringRestore = false;
    mockRestoreRecords.mockImplementationOnce(async () => {
      recoveringDuringRestore = usePrivacyStore.getState().recovering;
      return {
        kept: 2, collected: 0, pendingDeletion: 0, skipped: 0, existing: 0,
        rebound: 1, ambiguousSkipped: 0, protectedAlbums: 1, reviewIgnores: 0,
      };
    });
    const payload = { version: 2 as const, platform: 'android' as const, records: [], protectedAlbums: [], reviewIgnores: [] };
    const result = await recoverFromEncryptedBackup(payload, false);

    expect(recoveringDuringRestore).toBe(true);
    expect(usePrivacyStore.getState().recovering).toBe(false);
    expect(mockResetDbFiles).toHaveBeenCalledTimes(1);
    expect(mockRestoreRecords).toHaveBeenCalledWith(payload, false, undefined);
    expect(result.kept).toBe(2);
    expect(mockDeleteAssetsAsync).not.toHaveBeenCalled();
  });
});
