const mockDeleteAssetsAsync = jest.fn();
const mockCloseDatabase = jest.fn().mockResolvedValue(undefined);
const mockGetDatabase = jest.fn().mockResolvedValue({});
const mockResetDbFiles = jest.fn().mockResolvedValue(undefined);
const mockResetStorageKeys = jest.fn().mockResolvedValue(undefined);
const mockDeleteDeviceKey = jest.fn().mockResolvedValue(undefined);
const mockResetPersistence = jest.fn().mockResolvedValue(undefined);
const mockRestoreRecords = jest.fn().mockResolvedValue({
  kept: 2, collected: 0, pendingDeletion: 0, skipped: 0, existing: 0,
  rebound: 1, ambiguousSkipped: 0, protectedAlbums: 1, reviewIgnores: 0,
});
const mockSettingsRehydrate = jest.fn().mockResolvedValue(undefined);
const mockMediaRehydrate = jest.fn().mockResolvedValue(undefined);
const mockLoadProtectedAlbums = jest.fn().mockResolvedValue(undefined);
const mockRefreshTotalCounts = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-media-library', () => ({ deleteAssetsAsync: (...args: any[]) => mockDeleteAssetsAsync(...args) }));
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
}));
jest.mock('../../services/privacy/mediaCache', () => ({
  clearLegacyMediaCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/mediaProgressStorage', () => ({
  resetMediaProgressPersistenceState: (...args: any[]) => mockResetPersistence(...args),
}));
jest.mock('../../services/scanner', () => ({
  isScanning: () => false,
  stop: jest.fn(),
}));
jest.mock('../../services/backup/records', () => ({
  restoreEncryptedRecords: (...args: any[]) => mockRestoreRecords(...args),
}));
jest.mock('../../stores/useSettingsStore', () => ({
  useSettingsStore: { persist: { rehydrate: (...args: any[]) => mockSettingsRehydrate(...args) } },
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

import { usePrivacyStore } from '../../stores/usePrivacyStore';
import {
  recoverFromEncryptedBackup,
  resetLocalPrivacyIndex,
  resolvePrimaryFailureDomain,
} from '../../services/privacy/recovery';

describe('privacy self-rescue recovery service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePrivacyStore.getState().clearAll();
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

    expect(mockCloseDatabase).toHaveBeenCalledTimes(1);
    expect(mockResetDbFiles).toHaveBeenCalledTimes(1);
    expect(mockResetStorageKeys).toHaveBeenCalledTimes(1);
    expect(mockDeleteDeviceKey).toHaveBeenCalledWith('scanner');
    expect(mockDeleteDeviceKey).toHaveBeenCalledWith('records');
    expect(mockDeleteDeviceKey).toHaveBeenCalledWith('settings');
    expect(mockResetPersistence).toHaveBeenCalledTimes(1);
    expect(mockGetDatabase).toHaveBeenCalledTimes(1);
    expect(mockSettingsRehydrate).toHaveBeenCalledTimes(1);
    expect(mockMediaRehydrate).toHaveBeenCalledTimes(1);
    expect(usePrivacyStore.getState().failures).toEqual({});
    expect(usePrivacyStore.getState().reasons).toEqual({});
    expect(mockDeleteAssetsAsync).not.toHaveBeenCalled();
  });

  it('recovers from an already-verified backup payload by reinitializing local index then restoring records', async () => {
    const payload = { version: 2 as const, platform: 'android' as const, records: [], protectedAlbums: [], reviewIgnores: [] };
    const result = await recoverFromEncryptedBackup(payload, false);

    expect(mockResetDbFiles).toHaveBeenCalledTimes(1);
    expect(mockRestoreRecords).toHaveBeenCalledWith(payload, false, undefined);
    expect(result.kept).toBe(2);
    expect(mockDeleteAssetsAsync).not.toHaveBeenCalled();
  });
});
