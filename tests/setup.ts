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
    canWriteEncryptedStorage: () => true, markEncryptedStorageHydrated: () => {},
    disableEncryptedStorageWrites: jest.fn(),
    resetEncryptedStorageKeys: jest.fn(async () => {}) };
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

jest.mock('../services/reviewIgnores', () => {
  const entries = new Map<string, { ignoreType: 'blur' | 'similar_group'; targetKey: string; createdAt: number }>();
  return {
    getIgnoredReviewKeys: jest.fn(async (ignoreType: 'blur' | 'similar_group') => {
      const keys = new Set<string>();
      for (const entry of entries.values()) {
        if (entry.ignoreType === ignoreType) keys.add(entry.targetKey);
      }
      return keys;
    }),
    getAllIgnoredSimilarGroupKeys: jest.fn(async () => {
      const keys = new Set<string>();
      for (const entry of entries.values()) {
        if (entry.ignoreType === 'similar_group') keys.add(entry.targetKey);
      }
      return keys;
    }),
    ignoreSimilarGroupKeys: jest.fn(async (targetKeys: readonly string[], createdAt = Date.now()) => {
      const normalized = Array.from(new Set(targetKeys.map(k => k.trim()).filter(Boolean)));
      for (const targetKey of normalized) {
        entries.set(`similar_group:${targetKey}`, { ignoreType: 'similar_group', targetKey, createdAt });
      }
      return normalized;
    }),
    getAllReviewIgnores: jest.fn(async () => Array.from(entries.values())),
    addReviewIgnore: jest.fn(async (ignoreType: 'blur' | 'similar_group', targetKey: string, createdAt = Date.now()) => {
      entries.set(`${ignoreType}:${targetKey}`, { ignoreType, targetKey, createdAt });
    }),
    addReviewIgnores: jest.fn(async (list: readonly { ignoreType: 'blur' | 'similar_group'; targetKey: string; createdAt?: number }[]) => {
      let count = 0;
      for (const item of list) {
        entries.set(`${item.ignoreType}:${item.targetKey}`, {
          ignoreType: item.ignoreType,
          targetKey: item.targetKey,
          createdAt: item.createdAt ?? Date.now(),
        });
        count++;
      }
      return count;
    }),
    removeReviewIgnore: jest.fn(async (ignoreType: 'blur' | 'similar_group', targetKey: string) => {
      entries.delete(`${ignoreType}:${targetKey}`);
    }),
    mergeReviewIgnores: jest.fn(async (list: readonly { ignoreType: 'blur' | 'similar_group'; targetKey: string; createdAt: number }[]) => {
      let added = 0;
      for (const item of list) {
        const key = `${item.ignoreType}:${item.targetKey}`;
        if (!entries.has(key)) {
          entries.set(key, { ...item });
          added++;
        }
      }
      return added;
    }),
    __resetMockReviewIgnores: () => { entries.clear(); },
  };
});

jest.mock('../services/protectedAlbums', () => {
  const core = jest.requireActual('../services/protectedAlbumsCore');
  let stored: { albumId: string; title: string; createdAt: number }[] = [];
  return {
    ...core,
    loadProtectedAlbums: jest.fn(async () => stored.map(item => ({ ...item }))),
    saveProtectedAlbums: jest.fn(async (albums: readonly { albumId: string; title: string; createdAt?: number }[]) => {
      stored = albums.map(item => ({
        albumId: item.albumId,
        title: item.title || item.albumId,
        createdAt: item.createdAt ?? Date.now(),
      }));
      return stored.map(item => ({ ...item }));
    }),
    mergeProtectedAlbums: jest.fn(async (albums: readonly { albumId: string; title: string; createdAt?: number }[]) => {
      const existing = new Set(stored.map(item => item.albumId));
      let added = 0;
      for (const item of albums) {
        if (!existing.has(item.albumId)) {
          stored.push({
            albumId: item.albumId,
            title: item.title || item.albumId,
            createdAt: item.createdAt ?? Date.now(),
          });
          existing.add(item.albumId);
          added++;
        }
      }
      return added;
    }),
    __resetMockProtectedAlbums: () => { stored = []; },
  };
});

jest.mock('../services/backup/changeTracker', () => {
  const { create } = require('zustand');
  const useBackupReminderStore = create(() => ({
    pendingChanges: 0,
    lastBackupAt: null as number | null,
    loaded: true,
  }));
  return {
    BACKUP_REMINDER_THRESHOLD: 20,
    useBackupReminderStore,
    loadBackupChangeState: jest.fn(async () => ({
      pendingChanges: useBackupReminderStore.getState().pendingChanges,
      lastBackupAt: useBackupReminderStore.getState().lastBackupAt,
    })),
    recordBackupChanges: jest.fn(async (delta = 1) => {
      const next = useBackupReminderStore.getState().pendingChanges + delta;
      useBackupReminderStore.setState({ pendingChanges: next });
      return next;
    }),
    markBackupCompleted: jest.fn(async (timestamp = Date.now()) => {
      useBackupReminderStore.setState({ pendingChanges: 0, lastBackupAt: timestamp, loaded: true });
    }),
    suspendBackupChangeWrites: jest.fn(() => () => {}),
    resetBackupChangeState: jest.fn(async () => {
      useBackupReminderStore.setState({ pendingChanges: 0, lastBackupAt: null, loaded: false });
    }),
  };
});
