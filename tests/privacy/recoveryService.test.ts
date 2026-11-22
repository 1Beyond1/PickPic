const mockDeleteAssetsAsync = jest.fn();
const mockGetPermissionsAsync = jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' });
const mockCloseDatabase = jest.fn().mockResolvedValue(undefined);
const mockGetDatabase = jest.fn().mockResolvedValue({});
const mockResetDbFiles = jest.fn().mockResolvedValue(undefined);
const mockResetStorageKeys = jest.fn().mockResolvedValue(undefined);
const mockDeleteDeviceKey = jest.fn().mockResolvedValue(undefined);
const mockProbeDeviceKeystore = jest.fn().mockResolvedValue(undefined);
const mockResetPersistence = jest.fn().mockResolvedValue(undefined);
const mockResetSettingsPersistence = jest.fn().mockResolvedValue(undefined);
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
}));
jest.mock('../../services/privacy/settingsStorage', () => ({
  resetSettingsPersistenceState: (...args: any[]) => mockResetSettingsPersistence(...args),
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

    await expect(recoverFromEncryptedBackup(payload, false)).rejects.toMatchObject({ code: 'unavailable' });

    expect(mockResetDbFiles).not.toHaveBeenCalled();
    expect(mockResetStorageKeys).not.toHaveBeenCalled();
    expect(mockRestoreRecords).not.toHaveBeenCalled();
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
