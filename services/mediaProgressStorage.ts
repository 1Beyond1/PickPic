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
import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';

export const MEDIA_PROGRESS_STORAGE_KEY = 'photoapp-media-progress';

const LEGACY_V6_COLLECTION_KEYS = [
    'photoProcessedIds',
    'videoProcessedIds',
    'deleteQueue',
    'videoTrashBin',
] as const;

const LEGACY_COLLECTION_KEYS = [
    ...LEGACY_V6_COLLECTION_KEYS,
    'collectionQueue',
    'pendingDeletionInfo',
] as const;

const ALLOWED_PERSISTED_MEDIA_KEYS = new Set<string>([
    ...LEGACY_COLLECTION_KEYS,
    'deletedCounts',
    'organizingSessions',
    'recentDecisions',
]);

function isEmptyCollections(collections: MediaProgressCollections): boolean {
    return collections.photoProcessedIds.length === 0
        && collections.videoProcessedIds.length === 0
        && collections.deleteQueue.length === 0
        && collections.videoTrashBin.length === 0
        && collections.collectionQueue.length === 0
        && Object.keys(collections.pendingDeletionInfo).length === 0;
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

// Coalesced, serialized persistence worker:
// 1. Rapid swipes overwrite the pending slot instead of queueing 20 back-to-back
//    SQLCipher transactions and AsyncStorage writes.
// 2. SQLCipher collections commit BEFORE AsyncStorage small metadata; if SQLCipher
//    fails, AsyncStorage metadata is held back so the two stores never split-brain
//    and encryptedRecordStorage.setItem cannot clear the privacy gate mid-failure.
let workerPromise: Promise<void> | null = null;
let lastWriteFailed = false;
let latestMetadata: { name: string; value: string } | null = null;
let pendingMetadata: { name: string; value: string } | null = null;

let lastCollectionsWriteFailed = false;
let latestCollections: MediaProgressCollections | null = null;
let pendingCollections: MediaProgressCollections | null = null;
let lastPersistedCollections: MediaProgressCollections = emptyMediaProgressCollections();
let collectionsReady = false;

// Non-MEDIA_PROGRESS_STORAGE_KEY calls (e.g. direct unit-test keys) preserve
// first-write serialization while coalescing superseded intermediate writes.
let otherActiveWrite: { name: string; value: string } | null = null;
let otherPendingWrite: { name: string; value: string } | null = null;
let otherLatestWrite: { name: string; value: string } | null = null;

function scheduleWorker(): void {
    if (workerPromise !== null) return;
    workerPromise = Promise.resolve()
        .then(runWorker)
        .finally(() => {
            workerPromise = null;
        });
}

async function runWorker(): Promise<void> {
    while (
        otherActiveWrite !== null
        || otherPendingWrite !== null
        || pendingCollections !== null
        || pendingMetadata !== null
    ) {
        if (otherActiveWrite !== null || otherPendingWrite !== null) {
            const job = otherActiveWrite ?? otherPendingWrite!;
            if (job === otherPendingWrite) {
                otherPendingWrite = null;
            }
            otherActiveWrite = job;
            try {
                await encryptedRecordStorage.setItem(job.name, job.value);
                lastWriteFailed = false;
                if (!lastCollectionsWriteFailed && otherPendingWrite === null) {
                    usePrivacyStore.getState().clear('records');
                }
            } catch {
                lastWriteFailed = true;
                otherActiveWrite = null;
                break;
            }
            otherActiveWrite = null;
            continue;
        }

        // Step 1: Commit SQLCipher collections FIRST to avoid split-brain.
        if (pendingCollections !== null) {
            const nextCollections = pendingCollections;
            pendingCollections = null;
            try {
                await syncPersistedMediaCollections(lastPersistedCollections, nextCollections);
                lastPersistedCollections = nextCollections;
                lastCollectionsWriteFailed = false;
                if (!lastWriteFailed && pendingMetadata === null && pendingCollections === null) {
                    usePrivacyStore.getState().clear('records');
                }
            } catch {
                lastCollectionsWriteFailed = true;
                usePrivacyStore.getState().block('records', 'write');
                // Do NOT advance AsyncStorage metadata while SQLCipher failed.
                break;
            }
        }

        // Step 2: While SQLCipher collections are unpersisted, hold back
        // AsyncStorage metadata writes so neither split-brain nor gate flicker occurs.
        if (lastCollectionsWriteFailed) {
            usePrivacyStore.getState().block('records', 'write');
            break;
        }

        // Step 3: Commit bounded small AsyncStorage metadata.
        if (pendingMetadata !== null) {
            const metaJob = pendingMetadata;
            pendingMetadata = null;
            try {
                await encryptedRecordStorage.setItem(metaJob.name, metaJob.value);
                lastWriteFailed = false;
                if (!lastCollectionsWriteFailed && pendingCollections === null && pendingMetadata === null) {
                    usePrivacyStore.getState().clear('records');
                }
            } catch {
                lastWriteFailed = true;
                break;
            }
        }
    }
}

async function drainQueue(): Promise<void> {
    while (workerPromise !== null) {
        const observed = workerPromise;
        await observed;
    }
}

async function loadMediaProgressEnvelope(
    name: string
): Promise<{ state: Record<string, unknown>; version: number } | null> {
    await drainQueue();
    collectionsReady = false;
    const rawSmall = await encryptedRecordStorage.getItem(name);

    try {
        const envelope = rawSmall === null ? null : validateParsedEnvelope(rawSmall);
        const hasLegacyBigFields = envelope !== null
            && LEGACY_COLLECTION_KEYS.some(key => key in envelope.state);

        if (hasLegacyBigFields && envelope !== null) {
            const hasAllV6Keys = LEGACY_V6_COLLECTION_KEYS.every(key => key in envelope.state);
            const existing = hasAllV6Keys
                ? emptyMediaProgressCollections()
                : await loadPersistedMediaCollections();

            const legacyCollections = normalizeMediaProgressCollections({
                photoProcessedIds: 'photoProcessedIds' in envelope.state
                    ? (envelope.state.photoProcessedIds as string[] | undefined) ?? []
                    : existing.photoProcessedIds,
                videoProcessedIds: 'videoProcessedIds' in envelope.state
                    ? (envelope.state.videoProcessedIds as string[] | undefined) ?? []
                    : existing.videoProcessedIds,
                deleteQueue: 'deleteQueue' in envelope.state
                    ? (envelope.state.deleteQueue as MediaProgressCollections['deleteQueue'] | undefined) ?? []
                    : existing.deleteQueue,
                videoTrashBin: 'videoTrashBin' in envelope.state
                    ? (envelope.state.videoTrashBin as MediaProgressCollections['videoTrashBin'] | undefined) ?? []
                    : existing.videoTrashBin,
                collectionQueue: 'collectionQueue' in envelope.state
                    ? (envelope.state.collectionQueue as MediaProgressCollections['collectionQueue'] | undefined) ?? []
                    : existing.collectionQueue,
                pendingDeletionInfo: 'pendingDeletionInfo' in envelope.state
                    ? (envelope.state.pendingDeletionInfo as MediaProgressCollections['pendingDeletionInfo'] | undefined) ?? {}
                    : existing.pendingDeletionInfo,
            });

            // 1. Atomically write legacy unbounded collections into encrypted SQLCipher.
            await replacePersistedMediaCollections(legacyCollections);

            // 2. Read back from SQLCipher and verify exact row-level integrity
            //    BEFORE removing the legacy fields from AsyncStorage.
            const verified = await loadPersistedMediaCollections();
            if (!mediaProgressCollectionsEqual(legacyCollections, verified)) {
                throw new LocalPrivacyError();
            }

            // 3. Only after SQLCipher verification succeeds, strip all unbounded
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

            lastPersistedCollections = verified;
            latestCollections = null;
            pendingCollections = null;
            latestMetadata = null;
            pendingMetadata = null;
            lastWriteFailed = false;
            lastCollectionsWriteFailed = false;
            collectionsReady = true;

            return {
                state: {
                    ...strippedState,
                    ...verified,
                },
                version: envelope.version ?? 0,
            };
        }

        const persisted = await loadPersistedMediaCollections();
        lastPersistedCollections = persisted;
        latestCollections = null;
        pendingCollections = null;
        latestMetadata = null;
        pendingMetadata = null;
        lastWriteFailed = false;
        lastCollectionsWriteFailed = false;
        collectionsReady = true;

        if (envelope === null && isEmptyCollections(persisted)) {
            return null;
        }

        return {
            state: {
                ...(envelope?.state ?? {}),
                ...persisted,
            },
            version: envelope?.version ?? 0,
        };
    } catch {
        collectionsReady = false;
        usePrivacyStore.getState().block('records', 'read');
        throw new LocalPrivacyError();
    }
}

function enqueueMetadataWrite(name: string, value: string): void {
    // Permission/count setters can run before automatic hydration. Their
    // default snapshots are never allowed to replace a stored decision.
    if (!canWriteEncryptedStorage('records', name)) return;
    if (name === MEDIA_PROGRESS_STORAGE_KEY) {
        const entry = { name, value };
        latestMetadata = entry;
        pendingMetadata = entry;
        scheduleWorker();
        return;
    }

    const entry = { name, value };
    otherLatestWrite = entry;
    if (otherActiveWrite === null) {
        otherActiveWrite = entry;
    } else {
        otherPendingWrite = entry;
    }
    scheduleWorker();
}

async function removeMediaProgressItem(name: string): Promise<void> {
    await drainQueue();
    await encryptedRecordStorage.removeItem(name);
    if (name === MEDIA_PROGRESS_STORAGE_KEY && collectionsReady) {
        const empty = emptyMediaProgressCollections();
        await replacePersistedMediaCollections(empty);
        lastPersistedCollections = empty;
        latestCollections = null;
        pendingCollections = null;
        latestMetadata = null;
        pendingMetadata = null;
        lastWriteFailed = false;
        lastCollectionsWriteFailed = false;
    }
}

/**
 * Direct object PersistStorage for Zustand `persist`, eliminating cold-start
 * JSON.stringify -> JSON.parse double serialization on 30,000+ SQLCipher rows.
 */
export function createMediaProgressPersistStorage<S>(): PersistStorage<S> {
    return {
        getItem: async name => {
            if (name !== MEDIA_PROGRESS_STORAGE_KEY) {
                const raw = await encryptedRecordStorage.getItem(name);
                return raw === null ? null : (JSON.parse(raw) as StorageValue<S>);
            }
            const envelope = await loadMediaProgressEnvelope(name);
            return envelope as StorageValue<S> | null;
        },
        setItem: (name, value) => {
            enqueueMetadataWrite(name, JSON.stringify(value));
        },
        removeItem: removeMediaProgressItem,
    };
}

/**
 * String-based StateStorage adapter preserved for direct storage tests.
 */
export const mediaProgressStorage: StateStorage = {
    getItem: async name => {
        if (name !== MEDIA_PROGRESS_STORAGE_KEY) {
            await drainQueue();
            return encryptedRecordStorage.getItem(name);
        }
        const envelope = await loadMediaProgressEnvelope(name);
        return envelope === null ? null : JSON.stringify(envelope);
    },
    setItem: enqueueMetadataWrite,
    removeItem: removeMediaProgressItem,
};

export function scheduleMediaCollectionsPersist(
    collections: MediaProgressCollections
): void {
    if (!canWriteEncryptedStorage('records', MEDIA_PROGRESS_STORAGE_KEY)) return;
    if (!collectionsReady && usePrivacyStore.getState().failures.records === 'read') return;
    const snapshot: MediaProgressCollections = {
        photoProcessedIds: collections.photoProcessedIds,
        videoProcessedIds: collections.videoProcessedIds,
        deleteQueue: collections.deleteQueue,
        videoTrashBin: collections.videoTrashBin,
        collectionQueue: collections.collectionQueue,
        pendingDeletionInfo: collections.pendingDeletionInfo,
    };
    latestCollections = snapshot;
    pendingCollections = snapshot;
    scheduleWorker();
}

export async function flushMediaProgress(): Promise<void> {
    // Include writes added by an in-flight gallery event while we awaited.
    await drainQueue();
    if (lastCollectionsWriteFailed && latestCollections) {
        pendingCollections = latestCollections;
        if (latestMetadata) {
            pendingMetadata = latestMetadata;
        }
        scheduleWorker();
        await drainQueue();
    }
    if (!lastCollectionsWriteFailed && lastWriteFailed) {
        if (latestMetadata) {
            pendingMetadata = latestMetadata;
            scheduleWorker();
            await drainQueue();
        }
        if (otherLatestWrite) {
            otherActiveWrite = otherLatestWrite;
            scheduleWorker();
            await drainQueue();
        }
    }
    if (!lastCollectionsWriteFailed && pendingMetadata !== null) {
        scheduleWorker();
        await drainQueue();
    }
    if (lastWriteFailed || lastCollectionsWriteFailed) {
        throw new Error('Could not persist organizing records');
    }
}
