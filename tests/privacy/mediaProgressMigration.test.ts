jest.unmock('../../services/privacy/encryptedStorage');
jest.unmock('../../services/privacy/mediaCollectionsStorage');

let mockDisk: Map<string, string>;
let mockKeys: Map<string, string>;
let mockDb: import('../helpers/testDatabase').TestDatabase | null = null;
let mockDbUnavailable = false;
let mockFailCollectionReadOnce = false;
let mockTamperVerifyOnce = false;
let mockTxHook: (() => Promise<void>) | null = null;
let mockTxCount = 0;

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
    mockTxCount++;
    if (mockTxHook) await mockTxHook();
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

describe('SQLCipher V7 migration, coalescing, split-brain & privacy gate protection', () => {
  beforeEach(() => {
    jest.resetModules();
    const { TestDatabase } = require('../helpers/testDatabase');
    mockDb = new TestDatabase();
    mockDisk = new Map();
    mockKeys = new Map();
    mockDbUnavailable = false;
    mockFailCollectionReadOnce = false;
    mockTamperVerifyOnce = false;
    mockTxHook = null;
    mockTxCount = 0;
  });

  afterEach(async () => {
    if (mockDb) {
      await mockDb.closeAsync();
      mockDb = null;
    }
  });

  it('migrates all 6 unbounded AsyncStorage fields (including collectionQueue & pendingDeletionInfo) to SQLCipher, verifies readback, and strips them', async () => {
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
    expect(hydrated.state.collectionQueue).toEqual([{ id: 'c-1', mediaType: 'photo' }]);
    expect(hydrated.state.pendingDeletionInfo).toEqual({
      'p-2': { source: 'photos', addedAt: 100 },
      'v-1': { source: 'videos', addedAt: 200 },
    });
    expect(hydrated.state.deletedCounts).toEqual({ photos: 3, videos: 1 });

    // Legacy plaintext key is gone, and encrypted AsyncStorage holds ONLY small bounded metadata.
    expect(mockDisk.has(STORAGE_KEY)).toBe(false);
    const decryptedSmall = JSON.parse((await encryptedRecordStorage.getItem(STORAGE_KEY))!);
    expect(decryptedSmall.state).not.toHaveProperty('photoProcessedIds');
    expect(decryptedSmall.state).not.toHaveProperty('videoProcessedIds');
    expect(decryptedSmall.state).not.toHaveProperty('deleteQueue');
    expect(decryptedSmall.state).not.toHaveProperty('videoTrashBin');
    expect(decryptedSmall.state).not.toHaveProperty('collectionQueue');
    expect(decryptedSmall.state).not.toHaveProperty('pendingDeletionInfo');
    expect(decryptedSmall.state.deletedCounts).toEqual({ photos: 3, videos: 1 });

    // SQLCipher tables hold all 6 migrated collections losslessly.
    expect(await MediaProgressRepository.loadAll()).toEqual({
      photoProcessedIds: ['p-1', 'p-2'],
      videoProcessedIds: ['v-1'],
      deleteQueue: [{ id: 'p-2', mediaType: 'photo', uri: 'file:///p-2.jpg' }],
      videoTrashBin: [{ id: 'v-1', mediaType: 'video', uri: 'file:///v-1.mp4' }],
      collectionQueue: [{ id: 'c-1', mediaType: 'photo' }],
      pendingDeletionInfo: {
        'p-2': { source: 'photos', addedAt: 100 },
        'v-1': { source: 'videos', addedAt: 200 },
      },
    });
  });

  it('losslessly upgrades a V6 installation where 4 collections are already in SQLCipher and only collectionQueue/pendingDeletionInfo remain in AsyncStorage', async () => {
    const { MediaProgressRepository } = require('../../database/repositories/MediaProgressRepository');
    const { encryptedRecordStorage } = require('../../services/privacy/encryptedStorage');

    // Seed V6 state: 4 collections already in SQLCipher, only collectionQueue & pendingDeletionInfo in AsyncStorage.
    await MediaProgressRepository.replaceAll({
      photoProcessedIds: ['v6-p1', 'v6-p2'],
      videoProcessedIds: ['v6-v1'],
      deleteQueue: [{ id: 'v6-p2', mediaType: 'photo', uri: 'file:///v6-p2.jpg' }],
      videoTrashBin: [{ id: 'v6-v1', mediaType: 'video', uri: 'file:///v6-v1.mp4' }],
      collectionQueue: [],
      pendingDeletionInfo: {},
    });
    const v6AsyncPayload = JSON.stringify({
      state: {
        collectionQueue: [{ id: 'v6-c1', mediaType: 'photo' }],
        pendingDeletionInfo: {
          'v6-p2': { source: 'blur', addedAt: 42 },
          'v6-v1': { source: 'videos', addedAt: 99 },
        },
        deletedCounts: { photos: 7, videos: 2 },
        organizingSessions: { photo: null, video: null },
        recentDecisions: [],
      },
      version: 0,
    });
    await encryptedRecordStorage.getItem(STORAGE_KEY);
    await encryptedRecordStorage.setItem(STORAGE_KEY, v6AsyncPayload);

    const { createMediaProgressPersistStorage } = require('../../services/mediaProgressStorage');
    const storage = createMediaProgressPersistStorage();
    const hydrated = await storage.getItem(STORAGE_KEY);

    expect(hydrated?.state).toMatchObject({
      photoProcessedIds: ['v6-p1', 'v6-p2'],
      videoProcessedIds: ['v6-v1'],
      deleteQueue: [{ id: 'v6-p2', mediaType: 'photo', uri: 'file:///v6-p2.jpg' }],
      videoTrashBin: [{ id: 'v6-v1', mediaType: 'video', uri: 'file:///v6-v1.mp4' }],
      collectionQueue: [{ id: 'v6-c1', mediaType: 'photo' }],
      pendingDeletionInfo: {
        'v6-p2': { source: 'blur', addedAt: 42 },
        'v6-v1': { source: 'videos', addedAt: 99 },
      },
      deletedCounts: { photos: 7, videos: 2 },
    });

    const smallAfter = JSON.parse((await encryptedRecordStorage.getItem(STORAGE_KEY))!);
    expect(smallAfter.state).not.toHaveProperty('collectionQueue');
    expect(smallAfter.state).not.toHaveProperty('pendingDeletionInfo');
    expect(await MediaProgressRepository.loadAll()).toMatchObject({
      photoProcessedIds: ['v6-p1', 'v6-p2'],
      collectionQueue: [{ id: 'v6-c1', mediaType: 'photo' }],
      pendingDeletionInfo: {
        'v6-p2': { source: 'blur', addedAt: 42 },
        'v6-v1': { source: 'videos', addedAt: 99 },
      },
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

    const preserved = JSON.parse((await encryptedRecordStorage.getItem(STORAGE_KEY))!);
    expect(preserved.state.photoProcessedIds).toEqual(['p-1', 'p-2']);
    expect(preserved.state.deleteQueue).toEqual([{ id: 'p-2', mediaType: 'photo' }]);

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

  it('prevents split-brain and privacy-gate microtask flicker when SQLCipher fails while AsyncStorage writes keep arriving', async () => {
    const {
      mediaProgressStorage,
      scheduleMediaCollectionsPersist,
      flushMediaProgress,
    } = require('../../services/mediaProgressStorage');
    const { markEncryptedStorageHydrated, encryptedRecordStorage } = require('../../services/privacy/encryptedStorage');
    const { MediaProgressRepository } = require('../../database/repositories/MediaProgressRepository');
    const { usePrivacyStore } = require('../../stores/usePrivacyStore');

    await mediaProgressStorage.getItem(STORAGE_KEY);
    markEncryptedStorageHydrated('records', STORAGE_KEY);

    // Persist an initial clean baseline.
    const initialMeta = JSON.stringify({ state: { deletedCounts: { photos: 0, videos: 0 } }, version: 0 });
    mediaProgressStorage.setItem(STORAGE_KEY, initialMeta);
    await flushMediaProgress();
    const cipherBeforeFailure = mockDisk.get(ENCRYPTED_KEY);

    // Now break SQLCipher and simulate a decision writing both metadata & collections.
    mockDbUnavailable = true;
    const failedMeta = JSON.stringify({ state: { deletedCounts: { photos: 1, videos: 0 } }, version: 0 });
    mediaProgressStorage.setItem(STORAGE_KEY, failedMeta);
    scheduleMediaCollectionsPersist({
      photoProcessedIds: ['new-1'],
      videoProcessedIds: [],
      deleteQueue: [{ id: 'new-1', mediaType: 'photo' } as any],
      videoTrashBin: [],
      collectionQueue: [],
      pendingDeletionInfo: { 'new-1': { source: 'photos', addedAt: 500 } },
    });

    await expect(flushMediaProgress()).rejects.toThrow('Could not persist organizing records');
    expect(usePrivacyStore.getState().failures.records).toBe('write');
    // Split-brain check: AsyncStorage metadata MUST NOT have advanced while SQLCipher failed!
    expect(mockDisk.get(ENCRYPTED_KEY)).toBe(cipherBeforeFailure);

    // Subscribe to usePrivacyStore to guarantee ZERO microtask flicker when background setItem fires!
    const observedRecordStates: (string | undefined)[] = [];
    const unsub = usePrivacyStore.subscribe((state: any) => {
      observedRecordStates.push(state.failures.records);
    });
    const bgMeta = JSON.stringify({ state: { deletedCounts: { photos: 2, videos: 0 } }, version: 0 });
    mediaProgressStorage.setItem(STORAGE_KEY, bgMeta);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    unsub();

    expect(observedRecordStates.every(status => status === 'write')).toBe(true);
    expect(usePrivacyStore.getState().failures.records).toBe('write');
    expect(mockDisk.get(ENCRYPTED_KEY)).toBe(cipherBeforeFailure);

    // Recover SQLCipher and retry flush -> persists BOTH collections and latest metadata atomically.
    mockDbUnavailable = false;
    await expect(flushMediaProgress()).resolves.toBeUndefined();
    expect(usePrivacyStore.getState().failures).toEqual({});
    expect(await MediaProgressRepository.loadAll()).toEqual({
      photoProcessedIds: ['new-1'],
      videoProcessedIds: [],
      deleteQueue: [{ id: 'new-1', mediaType: 'photo' }],
      videoTrashBin: [],
      collectionQueue: [],
      pendingDeletionInfo: { 'new-1': { source: 'photos', addedAt: 500 } },
    });
    const finalSmall = JSON.parse((await encryptedRecordStorage.getItem(STORAGE_KEY))!);
    expect(finalSmall.state.deletedCounts).toEqual({ photos: 2, videos: 0 });
  });

  it('coalesces 20 rapid swipes so superseded intermediate snapshots skip redundant SQLCipher transactions', async () => {
    const {
      mediaProgressStorage,
      scheduleMediaCollectionsPersist,
      flushMediaProgress,
    } = require('../../services/mediaProgressStorage');
    const { markEncryptedStorageHydrated } = require('../../services/privacy/encryptedStorage');
    const { MediaProgressRepository } = require('../../database/repositories/MediaProgressRepository');

    await mediaProgressStorage.getItem(STORAGE_KEY);
    markEncryptedStorageHydrated('records', STORAGE_KEY);

    let releaseFirstTx!: () => void;
    let blockedOnce = false;
    mockTxHook = async () => {
      if (!blockedOnce) {
        blockedOnce = true;
        await new Promise<void>(resolve => { releaseFirstTx = resolve; });
      }
    };
    mockTxCount = 0;

    // Trigger swipe 1 and let its transaction start and block.
    scheduleMediaCollectionsPersist({
      photoProcessedIds: ['p-1'],
      videoProcessedIds: [],
      deleteQueue: [],
      videoTrashBin: [],
      collectionQueue: [],
      pendingDeletionInfo: {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockTxCount).toBe(1);

    // Fire 19 more rapid swipes while swipe 1 is still in flight.
    for (let i = 2; i <= 20; i++) {
      scheduleMediaCollectionsPersist({
        photoProcessedIds: Array.from({ length: i }, (_, idx) => `p-${idx + 1}`),
        videoProcessedIds: [],
        deleteQueue: [],
        videoTrashBin: [],
        collectionQueue: [],
        pendingDeletionInfo: {},
      });
    }

    releaseFirstTx();
    await flushMediaProgress();

    // Only 2 SQLCipher transactions total (swipe 1 + final coalesced swipe 20), NOT 20!
    expect(mockTxCount).toBe(2);
    const loaded = await MediaProgressRepository.loadAll();
    expect(loaded.photoProcessedIds).toHaveLength(20);
    expect(loaded.photoProcessedIds[19]).toBe('p-20');
  });

  it('eliminates cold-start JSON.stringify -> JSON.parse double serialization via createMediaProgressPersistStorage', async () => {
    const { MediaProgressRepository } = require('../../database/repositories/MediaProgressRepository');
    const { createMediaProgressPersistStorage } = require('../../services/mediaProgressStorage');

    const ids = Array.from({ length: 1000 }, (_, idx) => `cold-photo-${idx}`);
    await MediaProgressRepository.replaceAll({
      photoProcessedIds: ids,
      videoProcessedIds: [],
      deleteQueue: [],
      videoTrashBin: [],
      collectionQueue: [],
      pendingDeletionInfo: {},
    });

    const stringifySpy = jest.spyOn(JSON, 'stringify');
    const storage = createMediaProgressPersistStorage();
    const hydrated = await storage.getItem(STORAGE_KEY);

    expect(hydrated?.state.photoProcessedIds).toHaveLength(1000);
    // Cold-start direct object hydration must NOT stringify the 1,000 SQLCipher rows!
    expect(stringifySpy).not.toHaveBeenCalled();
    stringifySpy.mockRestore();
  });
});
