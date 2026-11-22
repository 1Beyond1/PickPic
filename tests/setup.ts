// React 19 expects this flag for tests that exercise hooks and components.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// Native rendering/decoding is verified on the isolated Android emulator.
// These boundaries let feature tests exercise real review decisions in Jest.
jest.mock('expo-image', () => ({ Image: require('react-native').Image }));
jest.mock('expo-video', () => ({
  VideoView: require('react-native').View,
  useVideoPlayer: () => require('react').useMemo(() => ({
    replaceAsync: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  }), []),
}));

// Jest has no native binary. Exercise real portable scrypt here; the native
// adapter has its own contract tests and an Android build/runtime smoke test.
jest.mock('../services/backup/keyDerivation', () => jest.requireActual('../services/backup/keyDerivation.ts'));

// Existing feature tests exercise decisions through a persistence boundary.
// Real encryption/migration and failure gates have separate integration tests.
jest.mock('../services/privacy/encryptedStorage', () => {
  const module = require('@react-native-async-storage/async-storage');
  const storage = module.default ?? module;
  return { encryptedRecordStorage: storage, encryptedSettingsStorage: storage,
    canWriteEncryptedStorage: () => true, markEncryptedStorageHydrated: () => {} };
});
jest.mock('../services/privacy/mediaCollectionsStorage', () => {
  let stored = {
    photoProcessedIds: [] as string[],
    videoProcessedIds: [] as string[],
    deleteQueue: [] as any[],
    videoTrashBin: [] as any[],
    collectionQueue: [] as any[],
    pendingDeletionInfo: {} as Record<string, any>,
  };
  return {
    loadPersistedMediaCollections: jest.fn(async () => ({
      photoProcessedIds: [...stored.photoProcessedIds],
      videoProcessedIds: [...stored.videoProcessedIds],
      deleteQueue: [...stored.deleteQueue],
      videoTrashBin: [...stored.videoTrashBin],
      collectionQueue: [...stored.collectionQueue],
      pendingDeletionInfo: { ...stored.pendingDeletionInfo },
    })),
    replacePersistedMediaCollections: jest.fn(async (next: typeof stored) => {
      stored = {
        photoProcessedIds: [...next.photoProcessedIds],
        videoProcessedIds: [...next.videoProcessedIds],
        deleteQueue: [...next.deleteQueue],
        videoTrashBin: [...next.videoTrashBin],
        collectionQueue: [...(next.collectionQueue ?? [])],
        pendingDeletionInfo: { ...(next.pendingDeletionInfo ?? {}) },
      };
    }),
    syncPersistedMediaCollections: jest.fn(async (_prev: typeof stored, next: typeof stored) => {
      stored = {
        photoProcessedIds: [...next.photoProcessedIds],
        videoProcessedIds: [...next.videoProcessedIds],
        deleteQueue: [...next.deleteQueue],
        videoTrashBin: [...next.videoTrashBin],
        collectionQueue: [...(next.collectionQueue ?? [])],
        pendingDeletionInfo: { ...(next.pendingDeletionInfo ?? {}) },
      };
    }),
  };
});
