import {
    canWriteEncryptedStorage,
    encryptedRecordStorage,
} from './privacy/encryptedStorage';
import {
    loadPersistedMediaCollections,
    replacePersistedMediaCollections,
    syncPersistedMediaCollections,
} from './privacy/mediaCollectionsStorage';
import {
    emptyMediaProgressCollections,
    mediaProgressCollectionsEqual,
    normalizeMediaProgressCollections,
    type MediaProgressCollections,
} from './privacy/mediaProgressCollections';
import { LocalPrivacyError, usePrivacyStore } from '../stores/usePrivacyStore';
import type { StateStorage } from 'zustand/middleware';

export const MEDIA_PROGRESS_STORAGE_KEY = 'photoapp-media-progress';

const LEGACY_COLLECTION_KEYS = [
    'photoProcessedIds',
    'videoProcessedIds',
    'deleteQueue',
    'videoTrashBin',
] as const;

const ALLOWED_PERSISTED_MEDIA_KEYS = new Set<string>([
    ...LEGACY_COLLECTION_KEYS,
    'collectionQueue',
    'pendingDeletionInfo',
    'deletedCounts',
    'organizingSessions',
    'recentDecisions',
]);

function cloneCollections(collections: MediaProgressCollections): MediaProgressCollections {
    return {
        photoProcessedIds: [...collections.photoProcessedIds],
        videoProcessedIds: [...collections.videoProcessedIds],
        deleteQueue: [...collections.deleteQueue],
        videoTrashBin: [...collections.videoTrashBin],
    };
}

function isEmptyCollections(collections: MediaProgressCollections): boolean {
    return collections.photoProcessedIds.length === 0
        && collections.videoProcessedIds.length === 0
        && collections.deleteQueue.length === 0
        && collections.videoTrashBin.length === 0;
}

function validateParsedEnvelope(raw: string): { state: Record<string, unknown>; version?: number } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new LocalPrivacyError();
    }
    if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || !('state' in parsed)
        || !parsed.state
        || typeof parsed.state !== 'object'
        || Array.isArray(parsed.state)
    ) {
        throw new LocalPrivacyError();
    }
    const envelope = parsed as { state: Record<string, unknown>; version?: unknown };
    if ('version' in envelope && envelope.version !== 0) {
        throw new LocalPrivacyError();
    }
    for (const key of Object.keys(envelope.state)) {
        if (!ALLOWED_PERSISTED_MEDIA_KEYS.has(key)) {
            throw new LocalPrivacyError();
        }
    }
    return {
        state: envelope.state,
        ...('version' in envelope ? { version: 0 } : {}),
    };
}

// Serialize persisted decisions so slow earlier writes cannot overwrite newer
// ones. Keep errors observable to an explicit backup/import flush, without
// leaving unhandled promises in Zustand's synchronous action setters.
let queue = Promise.resolve();
let lastWriteFailed = false;
let latest: { name: string; value: string } | null = null;
let lastCollectionsWriteFailed = false;
let latestCollections: MediaProgressCollections | null = null;
let lastPersistedCollections: MediaProgressCollections = emptyMediaProgressCollections();
let collectionsReady = false;

async function drainQueue(): Promise<void> {
    let observed: Promise<void>;
    do {
        observed = queue;
        await observed;
    } while (observed !== queue);
}

export const mediaProgressStorage: StateStorage = {
    getItem: async name => {
        await drainQueue();
        if (name !== MEDIA_PROGRESS_STORAGE_KEY) {
            return encryptedRecordStorage.getItem(name);
        }

        collectionsReady = false;
        const rawSmall = await encryptedRecordStorage.getItem(name);

        try {
            const envelope = rawSmall === null ? null : validateParsedEnvelope(rawSmall);
            const hasLegacyBigFields = envelope !== null
                && LEGACY_COLLECTION_KEYS.some(key => key in envelope.state);

            if (hasLegacyBigFields && envelope !== null) {
                const legacyCollections = normalizeMediaProgressCollections({
                    photoProcessedIds: (envelope.state.photoProcessedIds as string[] | undefined) ?? [],
                    videoProcessedIds: (envelope.state.videoProcessedIds as string[] | undefined) ?? [],
                    deleteQueue: (envelope.state.deleteQueue as MediaProgressCollections['deleteQueue'] | undefined) ?? [],
                    videoTrashBin: (envelope.state.videoTrashBin as MediaProgressCollections['videoTrashBin'] | undefined) ?? [],
                });

                // 1. Atomically write legacy large collections into encrypted SQLCipher.
                await replacePersistedMediaCollections(legacyCollections);

                // 2. Read back from SQLCipher and verify exact row-level integrity
                //    BEFORE removing the legacy big fields from AsyncStorage.
                const verified = await loadPersistedMediaCollections();
                if (!mediaProgressCollectionsEqual(legacyCollections, verified)) {
                    throw new LocalPrivacyError();
                }

                // 3. Only after SQLCipher verification succeeds, strip the large
                //    collections from the AsyncStorage encrypted record.
                const strippedState: Record<string, unknown> = { ...envelope.state };
                for (const key of LEGACY_COLLECTION_KEYS) {
                    delete strippedState[key];
                }
                const strippedPayload = JSON.stringify({
                    ...envelope,
                    state: strippedState,
                });
                await encryptedRecordStorage.setItem(name, strippedPayload);

                lastPersistedCollections = cloneCollections(verified);
                latestCollections = null;
                lastCollectionsWriteFailed = false;
                collectionsReady = true;

                return JSON.stringify({
                    ...envelope,
                    state: {
                        ...strippedState,
                        ...verified,
                    },
                });
            }

            const persisted = await loadPersistedMediaCollections();
            lastPersistedCollections = cloneCollections(persisted);
            latestCollections = null;
            lastCollectionsWriteFailed = false;
            collectionsReady = true;

            if (envelope === null && isEmptyCollections(persisted)) {
                return null;
            }

            return JSON.stringify({
                state: {
                    ...(envelope?.state ?? {}),
                    ...persisted,
                },
                version: envelope?.version ?? 0,
            });
        } catch {
            collectionsReady = false;
            usePrivacyStore.getState().block('records', 'read');
            throw new LocalPrivacyError();
        }
    },

    setItem: (name, value) => {
        // Permission/count setters can run before automatic hydration. Their
        // default snapshots are never allowed to replace a stored decision.
        if (!canWriteEncryptedStorage('records', name)) return;
        latest = { name, value };
        queue = queue.then(async () => {
            try {
                await encryptedRecordStorage.setItem(name, value);
                lastWriteFailed = false;
                if (lastCollectionsWriteFailed) {
                    // Do not let a small-metadata write clear an active SQLCipher
                    // write failure while large collections are still unpersisted.
                    usePrivacyStore.getState().block('records', 'write');
                }
            } catch {
                lastWriteFailed = true;
            }
        });
    },

    removeItem: async name => {
        await drainQueue();
        await encryptedRecordStorage.removeItem(name);
        if (name === MEDIA_PROGRESS_STORAGE_KEY && collectionsReady) {
            const empty = emptyMediaProgressCollections();
            await replacePersistedMediaCollections(empty);
            lastPersistedCollections = empty;
            latestCollections = null;
            lastCollectionsWriteFailed = false;
        }
    },
};

export function scheduleMediaCollectionsPersist(
    collections: MediaProgressCollections
): void {
    if (!canWriteEncryptedStorage('records', MEDIA_PROGRESS_STORAGE_KEY)) return;
    if (!collectionsReady && usePrivacyStore.getState().failures.records === 'read') return;
    const snapshot = cloneCollections(collections);
    latestCollections = snapshot;
    queue = queue.then(async () => {
        if (lastWriteFailed) {
            // Keep AsyncStorage metadata and SQLCipher collections aligned when
            // the encrypted AsyncStorage write already failed; retry both on flush.
            lastCollectionsWriteFailed = true;
            usePrivacyStore.getState().block('records', 'write');
            return;
        }
        try {
            await syncPersistedMediaCollections(lastPersistedCollections, snapshot);
            lastPersistedCollections = snapshot;
            lastCollectionsWriteFailed = false;
            if (!lastWriteFailed) {
                usePrivacyStore.getState().clear('records');
            }
        } catch {
            lastCollectionsWriteFailed = true;
            usePrivacyStore.getState().block('records', 'write');
        }
    });
}

export async function flushMediaProgress(): Promise<void> {
    // Include writes added by an in-flight gallery event while we awaited.
    await drainQueue();
    if (lastWriteFailed && latest) {
        // Permit recovery after storage becomes available again. A failed
        // import must not permanently lock every subsequent transfer.
        mediaProgressStorage.setItem(latest.name, latest.value);
        await drainQueue();
    }
    if (!lastWriteFailed && lastCollectionsWriteFailed && latestCollections) {
        scheduleMediaCollectionsPersist(latestCollections);
        await drainQueue();
    }
    if (lastWriteFailed || lastCollectionsWriteFailed) {
        throw new Error('Could not persist organizing records');
    }
}
