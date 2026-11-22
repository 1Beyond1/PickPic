jest.unmock('../../services/privacy/encryptedStorage');
jest.unmock('../../services/privacy/mediaCollectionsStorage');

let mockDisk: Map<string, string>;
let mockKeys: Map<string, string>;
let mockDb: import('../helpers/testDatabase').TestDatabase | null = null;
let mockDbUnavailable = false;
let mockFailCollectionReadOnce = false;
let mockTamperVerifyOnce = false;

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (name: string) => mockDisk.get(name) ?? null),
  setItem: jest.fn(async (name: string, value: string) => { mockDisk.set(name, value); }),
  removeItem: jest.fn(async (name: string) => { mockDisk.delete(name); }),
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
  getItemAsync: jest.fn(async (name: string) => mockKeys.get(name) ?? null),
  setItemAsync: jest.fn(async (name: string, value: string) => { mockKeys.set(name, value); }),
}));
jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: async (count: number) => new Uint8Array(require('node:crypto').randomBytes(count)),
}));
jest.mock('react-native-quick-base64', () => ({
  fromByteArray: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  toByteArray: (encoded: string) => new Uint8Array(Buffer.from(encoded, 'base64')),
}));
jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({
  getDatabase: jest.fn(async () => {
    if (mockDbUnavailable) throw new Error('SQLCipher locked');
    if (mockFailCollectionReadOnce) {
      mockFailCollectionReadOnce = false;
      throw new Error('Readback verification failed');
    }
    return mockDb;
  }),
  withTransaction: jest.fn(async (callback: (db: any) => Promise<any>) => {
    if (mockDbUnavailable) throw new Error('SQLCipher locked');
    let result: unknown;
    await mockDb!.withTransactionAsync(async () => {
      result = await callback(mockDb);
      if (mockTamperVerifyOnce) {
        mockTamperVerifyOnce = false;
        await mockDb!.runAsync("DELETE FROM media_processed_records WHERE asset_id = 'p-2'");
      }
    });
    return result;
  }),
}));

const STORAGE_KEY = 'photoapp-media-progress';
const ENCRYPTED_KEY = `${STORAGE_KEY}.encrypted-v1`;

describe('SQLCipher migration and fail-closed privacy gate for large media collections', () => {
  beforeEach(() => {
    jest.resetModules();
    const { TestDatabase } = require('../helpers/testDatabase');
    mockDb = new TestDatabase();
    mockDisk = new Map();
    mockKeys = new Map();
    mockDbUnavailable = false;
    mockFailCollectionReadOnce = false;
    mockTamperVerifyOnce = false;
  });

  afterEach(async () => {
    if (mockDb) {
      await mockDb.closeAsync();
      mockDb = null;
    }
  });

  it('migrates legacy AsyncStorage large fields to SQLCipher, verifies readback, and strips them from AsyncStorage', async () => {
    const legacyPayload = JSON.stringify({
      state: {
        photoProcessedIds: ['p-1', 'p-2'],
        videoProcessedIds: ['v-1'],
        deleteQueue: [{ id: 'p-2', mediaType: 'photo', uri: 'file:///p-2.jpg' }],
        collectionQueue: [{ id: 'c-1', mediaType: 'photo' }],
        videoTrashBin: [{ id: 'v-1', mediaType: 'video', uri: 'file:///v-1.mp4' }],
        pendingDeletionInfo: {
          'p-2': { source: 'photos', addedAt: 100 },
          'v-1': { source: 'videos', addedAt: 200 },
        },
        deletedCounts: { photos: 3, videos: 1 },
        organizingSessions: { photo: null, video: null },
        recentDecisions: [],
      },
      version: 0,
    });
    mockDisk.set(STORAGE_KEY, legacyPayload);

    const { mediaProgressStorage } = require('../../services/mediaProgressStorage');
    const { encryptedRecordStorage } = require('../../services/privacy/encryptedStorage');
    const { MediaProgressRepository } = require('../../database/repositories/MediaProgressRepository');

    const hydratedRaw = await mediaProgressStorage.getItem(STORAGE_KEY);
    const hydrated = JSON.parse(hydratedRaw!);
    expect(hydrated.state.photoProcessedIds).toEqual(['p-1', 'p-2']);
    expect(hydrated.state.videoProcessedIds).toEqual(['v-1']);
    expect(hydrated.state.deleteQueue).toEqual([{ id: 'p-2', mediaType: 'photo', uri: 'file:///p-2.jpg' }]);
    expect(hydrated.state.videoTrashBin).toEqual([{ id: 'v-1', mediaType: 'video', uri: 'file:///v-1.mp4' }]);
    expect(hydrated.state.deletedCounts).toEqual({ photos: 3, videos: 1 });
    expect(hydrated.state.collectionQueue).toEqual([{ id: 'c-1', mediaType: 'photo' }]);

    // Legacy plaintext key is gone, and encrypted AsyncStorage no longer holds the 4 big fields.
    expect(mockDisk.has(STORAGE_KEY)).toBe(false);
    const decryptedSmall = JSON.parse((await encryptedRecordStorage.getItem(STORAGE_KEY))!);
    expect(decryptedSmall.state).not.toHaveProperty('photoProcessedIds');
    expect(decryptedSmall.state).not.toHaveProperty('videoProcessedIds');
    expect(decryptedSmall.state).not.toHaveProperty('deleteQueue');
    expect(decryptedSmall.state).not.toHaveProperty('videoTrashBin');
    expect(decryptedSmall.state.deletedCounts).toEqual({ photos: 3, videos: 1 });
    expect(decryptedSmall.state.collectionQueue).toEqual([{ id: 'c-1', mediaType: 'photo' }]);

    // SQLCipher tables hold the exact migrated rows.
    expect(await MediaProgressRepository.loadAll()).toEqual({
      photoProcessedIds: ['p-1', 'p-2'],
      videoProcessedIds: ['v-1'],
      deleteQueue: [{ id: 'p-2', mediaType: 'photo', uri: 'file:///p-2.jpg' }],
      videoTrashBin: [{ id: 'v-1', mediaType: 'video', uri: 'file:///v-1.mp4' }],
    });
  });

  it('preserves old AsyncStorage large fields and blocks reads if SQLCipher write or verification fails', async () => {
    const legacyState = {
      photoProcessedIds: ['p-1', 'p-2'],
      videoProcessedIds: ['v-1'],
      deleteQueue: [{ id: 'p-2', mediaType: 'photo' }],
      collectionQueue: [],
      videoTrashBin: [],
    };
    const legacyPayload = JSON.stringify({ state: legacyState, version: 0 });
    mockDisk.set(STORAGE_KEY, legacyPayload);
    mockTamperVerifyOnce = true;

    const { mediaProgressStorage } = require('../../services/mediaProgressStorage');
    const { encryptedRecordStorage } = require('../../services/privacy/encryptedStorage');
    const { usePrivacyStore } = require('../../stores/usePrivacyStore');

    await expect(mediaProgressStorage.getItem(STORAGE_KEY)).rejects.toThrow('original data was preserved');
    expect(usePrivacyStore.getState().failures.records).toBe('read');

    // Old large fields must STILL be intact inside AsyncStorage so retry can recover losslessly!
    const preserved = JSON.parse((await encryptedRecordStorage.getItem(STORAGE_KEY))!);
    expect(preserved.state.photoProcessedIds).toEqual(['p-1', 'p-2']);
    expect(preserved.state.deleteQueue).toEqual([{ id: 'p-2', mediaType: 'photo' }]);

    // Explicit retry after transient failure succeeds losslessly and strips AsyncStorage only now.
    const retried = JSON.parse((await mediaProgressStorage.getItem(STORAGE_KEY))!);
    expect(retried.state.photoProcessedIds).toEqual(['p-1', 'p-2']);
    const afterRetrySmall = JSON.parse((await encryptedRecordStorage.getItem(STORAGE_KEY))!);
    expect(afterRetrySmall.state).not.toHaveProperty('photoProcessedIds');
  });

  it('fails closed when SQLCipher cannot be opened and preserves legacy encrypted records untouched', async () => {
    const { encryptedRecordStorage } = require('../../services/privacy/encryptedStorage');
    const legacyPayload = JSON.stringify({
      state: { photoProcessedIds: ['legacy-keep'], videoProcessedIds: [], deleteQueue: [], videoTrashBin: [] },
      version: 0,
    });
    await encryptedRecordStorage.getItem(STORAGE_KEY);
    await encryptedRecordStorage.setItem(STORAGE_KEY, legacyPayload);
    const cipherBefore = mockDisk.get(ENCRYPTED_KEY);

    mockDbUnavailable = true;
    const { mediaProgressStorage } = require('../../services/mediaProgressStorage');
    const { usePrivacyStore } = require('../../stores/usePrivacyStore');

    await expect(mediaProgressStorage.getItem(STORAGE_KEY)).rejects.toThrow('original data was preserved');
    expect(usePrivacyStore.getState().failures.records).toBe('read');
    expect(mockDisk.get(ENCRYPTED_KEY)).toBe(cipherBefore);
  });

  it('blocks writes when SQLCipher incremental sync fails and recovers cleanly on flushMediaProgress retry', async () => {
    const { mediaProgressStorage, scheduleMediaCollectionsPersist, flushMediaProgress } = require('../../services/mediaProgressStorage');
    const { markEncryptedStorageHydrated } = require('../../services/privacy/encryptedStorage');
    const { MediaProgressRepository } = require('../../database/repositories/MediaProgressRepository');
    const { usePrivacyStore } = require('../../stores/usePrivacyStore');

    await mediaProgressStorage.getItem(STORAGE_KEY);
    markEncryptedStorageHydrated('records', STORAGE_KEY);

    mockDbUnavailable = true;
    scheduleMediaCollectionsPersist({
      photoProcessedIds: ['new-1'],
      videoProcessedIds: [],
      deleteQueue: [{ id: 'new-1', mediaType: 'photo' } as any],
      videoTrashBin: [],
    });

    await expect(flushMediaProgress()).rejects.toThrow('Could not persist organizing records');
    expect(usePrivacyStore.getState().failures.records).toBe('write');

    // Recover SQLCipher and retry flush -> persists the unsaved incremental state and clears gate.
    mockDbUnavailable = false;
    await expect(flushMediaProgress()).resolves.toBeUndefined();
    expect(usePrivacyStore.getState().failures).toEqual({});
    expect(await MediaProgressRepository.loadAll()).toEqual({
      photoProcessedIds: ['new-1'],
      videoProcessedIds: [],
      deleteQueue: [{ id: 'new-1', mediaType: 'photo' }],
      videoTrashBin: [],
    });
  });
});
