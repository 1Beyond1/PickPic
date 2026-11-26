import {
    MediaProgressRepository,
    type MediaProgressCollections,
} from '../../database/repositories/MediaProgressRepository';

/**
 * Persistence boundary for the four unbounded organizing collections stored
 * row-by-row inside the encrypted SQLCipher database (`media_processed_records`
 * and `media_pending_queue`). Kept as a thin module alongside
 * `encryptedStorage.ts` so non-persistence feature tests can isolate it while
 * privacy/database integration tests exercise the real SQLite implementation.
 */
export function loadPersistedMediaCollections(): Promise<MediaProgressCollections> {
    return MediaProgressRepository.loadAll();
}

export function replacePersistedMediaCollections(
    collections: MediaProgressCollections
): Promise<void> {
    return MediaProgressRepository.replaceAll(collections);
}

export function syncPersistedMediaCollections(
    previous: MediaProgressCollections,
    next: MediaProgressCollections
): Promise<void> {
    return MediaProgressRepository.syncCollections(previous, next);
}
