/**
 * Media Progress Repository - Row-level encrypted SQLCipher storage for
 * unbounded organizing progress, pending deletion queues, collection queue,
 * and pending-deletion metadata.
 *
 * Uses monotonic `seq` values (allowing deletion holes) + multi-row VALUES
 * batch inserts so deleting or undoing a single asset from 30,000+ rows executes
 * O(1) SQL statements instead of rewriting every subsequent row.
 */

import * as SQLite from 'expo-sqlite';
import { getDatabase, withTransaction } from '../db';
import { MetaKeys } from '../schema';
import { LocalPrivacyError } from '../../stores/usePrivacyStore';
import type { PhotoAsset } from '../../stores/useMediaStore';
import type { PendingDeletionInfo } from '../../services/pendingDeletion';
import {
    dedupeMediaAssets,
    dedupeMediaIds,
    emptyMediaProgressCollections,
    mediaProgressCollectionsEqual,
    normalizeMediaProgressCollections,
    pendingDeletionInfoEqual,
    validatePendingDeletionInfoEntry,
    type MediaProgressCollections,
    type PendingQueueType,
    type ProcessedMediaType,
} from '../../services/privacy/mediaProgressCollections';

export {
    emptyMediaProgressCollections,
    mediaProgressCollectionsEqual,
    normalizeMediaProgressCollections,
};
export type {
    MediaProgressCollections,
    PendingQueueType,
    ProcessedMediaType,
};

const SQLITE_DELETE_BATCH_SIZE = 500;
const SQLITE_PROCESSED_INSERT_BATCH_SIZE = 250; // 3 params/row = 750 <= 999
const SQLITE_PENDING_INSERT_BATCH_SIZE = 150;   // 6 params/row = 900 <= 999

interface ProcessedRow {
    media_type: string;
    asset_id: string;
    seq: number;
}

interface PendingQueueRow {
    queue_type: string;
    asset_id: string;
    seq: number;
    asset_json: string;
    source: string | null;
    added_at: number | null;
}

const dedupeStrings = dedupeMediaIds;
const dedupeAssets = dedupeMediaAssets;

async function deleteProcessedIdsInDb(
    db: SQLite.SQLiteDatabase,
    mediaType: ProcessedMediaType,
    ids: readonly string[]
): Promise<void> {
    for (let i = 0; i < ids.length; i += SQLITE_DELETE_BATCH_SIZE) {
        const batch = ids.slice(i, i + SQLITE_DELETE_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        await db.runAsync(
            `DELETE FROM media_processed_records
             WHERE media_type = ? AND asset_id IN (${placeholders})`,
            [mediaType, ...batch]
        );
    }
}

async function insertProcessedRowsBatchInDb(
    db: SQLite.SQLiteDatabase,
    mediaType: ProcessedMediaType,
    rows: readonly { id: string; seq: number }[]
): Promise<void> {
    for (let i = 0; i < rows.length; i += SQLITE_PROCESSED_INSERT_BATCH_SIZE) {
        const batch = rows.slice(i, i + SQLITE_PROCESSED_INSERT_BATCH_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
        const params: (string | number)[] = [];
        for (const row of batch) {
            params.push(mediaType, row.id, row.seq);
        }
        await db.runAsync(
            `INSERT OR REPLACE INTO media_processed_records (media_type, asset_id, seq)
             VALUES ${placeholders}`,
            params
        );
    }
}

async function addProcessedIdsInDb(
    db: SQLite.SQLiteDatabase,
    mediaType: ProcessedMediaType,
    ids: readonly string[],
    checkExisting: boolean
): Promise<void> {
    if (ids.length === 0) return;

    let toInsert: readonly string[] = ids;
    if (checkExisting) {
        const existingSet = new Set<string>();
        for (let i = 0; i < ids.length; i += SQLITE_DELETE_BATCH_SIZE) {
            const batch = ids.slice(i, i + SQLITE_DELETE_BATCH_SIZE);
            const placeholders = batch.map(() => '?').join(', ');
            const existingRows = await db.getAllAsync<{ asset_id: string }>(
                `SELECT asset_id FROM media_processed_records
                 WHERE media_type = ? AND asset_id IN (${placeholders})`,
                [mediaType, ...batch]
            );
            for (const row of existingRows) {
                existingSet.add(row.asset_id);
            }
        }
        toInsert = ids.filter(id => !existingSet.has(id));
        if (toInsert.length === 0) return;
    }

    const maxRow = await db.getFirstAsync<{ max_seq: number | null }>(
        'SELECT MAX(seq) AS max_seq FROM media_processed_records WHERE media_type = ?',
        [mediaType]
    );
    let nextSeq = (maxRow?.max_seq ?? -1) + 1;
    const rows = toInsert.map(id => ({ id, seq: nextSeq++ }));
    await insertProcessedRowsBatchInDb(db, mediaType, rows);
}

async function deletePendingIdsInDb(
    db: SQLite.SQLiteDatabase,
    queueType: PendingQueueType,
    ids: readonly string[]
): Promise<void> {
    for (let i = 0; i < ids.length; i += SQLITE_DELETE_BATCH_SIZE) {
        const batch = ids.slice(i, i + SQLITE_DELETE_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        await db.runAsync(
            `DELETE FROM media_pending_queue
             WHERE queue_type = ? AND asset_id IN (${placeholders})`,
            [queueType, ...batch]
        );
    }
}

async function insertPendingRowsBatchInDb(
    db: SQLite.SQLiteDatabase,
    queueType: PendingQueueType,
    rows: readonly { asset: PhotoAsset; seq: number; info: PendingDeletionInfo | null }[]
): Promise<void> {
    for (let i = 0; i < rows.length; i += SQLITE_PENDING_INSERT_BATCH_SIZE) {
        const batch = rows.slice(i, i + SQLITE_PENDING_INSERT_BATCH_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const params: (string | number | null)[] = [];
        for (const row of batch) {
            const source = queueType === 'collection' ? null : (row.info?.source ?? null);
            const addedAt = queueType === 'collection' ? null : (row.info?.addedAt ?? null);
            params.push(queueType, row.asset.id, row.seq, JSON.stringify(row.asset), source, addedAt);
        }
        await db.runAsync(
            `INSERT OR REPLACE INTO media_pending_queue (queue_type, asset_id, seq, asset_json, source, added_at)
             VALUES ${placeholders}`,
            params
        );
    }
}

async function upsertPendingItemsInDb(
    db: SQLite.SQLiteDatabase,
    queueType: PendingQueueType,
    assets: readonly PhotoAsset[],
    infoMap?: Readonly<Record<string, PendingDeletionInfo>>,
    checkExisting: boolean = true
): Promise<void> {
    if (assets.length === 0) return;

    const existingSeq = new Map<string, number>();
    if (checkExisting) {
        for (let i = 0; i < assets.length; i += SQLITE_DELETE_BATCH_SIZE) {
            const batch = assets.slice(i, i + SQLITE_DELETE_BATCH_SIZE);
            const placeholders = batch.map(() => '?').join(', ');
            const rows = await db.getAllAsync<{ asset_id: string; seq: number }>(
                `SELECT asset_id, seq FROM media_pending_queue
                 WHERE queue_type = ? AND asset_id IN (${placeholders})`,
                [queueType, ...batch.map(item => item.id)]
            );
            for (const row of rows) {
                existingSeq.set(row.asset_id, row.seq);
            }
        }
    }

    const needsNewSeq = assets.some(asset => !existingSeq.has(asset.id));
    let nextSeq = 0;
    if (needsNewSeq) {
        const maxRow = await db.getFirstAsync<{ max_seq: number | null }>(
            'SELECT MAX(seq) AS max_seq FROM media_pending_queue WHERE queue_type = ?',
            [queueType]
        );
        nextSeq = (maxRow?.max_seq ?? -1) + 1;
    }

    const rowsToInsert = assets.map(asset => {
        const seq = existingSeq.get(asset.id) ?? nextSeq++;
        const rawInfo = queueType === 'collection' ? undefined : infoMap?.[asset.id];
        const info = rawInfo !== undefined ? validatePendingDeletionInfoEntry(rawInfo) : null;
        return { asset, seq, info };
    });
    await insertPendingRowsBatchInDb(db, queueType, rowsToInsert);
}

/**
 * Determine whether `nextIds` can be represented purely by deleting removed rows
 * (leaving monotonic `seq` holes) and appending newly added IDs after `MAX(seq)`.
 */
function canApplyMonotonicDiff(
    prevIndex: ReadonlyMap<string, number>,
    nextIds: readonly string[]
): boolean {
    let lastSurvivingPos = -1;
    let seenNew = false;
    for (const id of nextIds) {
        const prevPos = prevIndex.get(id);
        if (prevPos !== undefined) {
            if (seenNew || prevPos <= lastSurvivingPos) {
                return false;
            }
            lastSurvivingPos = prevPos;
        } else {
            seenNew = true;
        }
    }
    return true;
}

async function syncProcessedListInDb(
    db: SQLite.SQLiteDatabase,
    mediaType: ProcessedMediaType,
    prevIds: readonly string[],
    nextIds: readonly string[]
): Promise<void> {
    if (prevIds === nextIds) return;
    const normalizedNext = dedupeStrings(nextIds);
    if (normalizedNext.length === 0) {
        if (prevIds.length > 0) {
            await db.runAsync(
                'DELETE FROM media_processed_records WHERE media_type = ?',
                [mediaType]
            );
        }
        return;
    }

    const prevIndex = new Map<string, number>();
    prevIds.forEach((id, idx) => {
        if (!prevIndex.has(id)) prevIndex.set(id, idx);
    });

    const nextSet = new Set(normalizedNext);
    const removed: string[] = [];
    for (const id of prevIndex.keys()) {
        if (!nextSet.has(id)) removed.push(id);
    }
    if (removed.length > 0) {
        await deleteProcessedIdsInDb(db, mediaType, removed);
    }

    if (canApplyMonotonicDiff(prevIndex, normalizedNext)) {
        const added: string[] = [];
        for (const id of normalizedNext) {
            if (!prevIndex.has(id)) added.push(id);
        }
        if (added.length > 0) {
            await addProcessedIdsInDb(db, mediaType, added, false);
        }
        return;
    }

    // Rare path: caller reordered existing rows or inserted into the middle.
    // Reassign clean dense sequences in multi-row batches so exact order matches.
    await insertProcessedRowsBatchInDb(
        db,
        mediaType,
        normalizedNext.map((id, seq) => ({ id, seq }))
    );
}

async function syncPendingQueueInDb(
    db: SQLite.SQLiteDatabase,
    queueType: PendingQueueType,
    prevItems: readonly PhotoAsset[],
    nextItems: readonly PhotoAsset[],
    prevInfo: Readonly<Record<string, PendingDeletionInfo>>,
    nextInfo: Readonly<Record<string, PendingDeletionInfo>>
): Promise<void> {
    if (prevItems === nextItems && (queueType === 'collection' || prevInfo === nextInfo)) {
        return;
    }
    const normalizedNext = dedupeAssets(nextItems);
    if (normalizedNext.length === 0) {
        if (prevItems.length > 0) {
            await db.runAsync(
                'DELETE FROM media_pending_queue WHERE queue_type = ?',
                [queueType]
            );
        }
        return;
    }

    const prevIndex = new Map<string, number>();
    const prevById = new Map<string, PhotoAsset>();
    prevItems.forEach((item, idx) => {
        if (item?.id && !prevById.has(item.id)) {
            prevIndex.set(item.id, idx);
            prevById.set(item.id, item);
        }
    });

    const nextIds = normalizedNext.map(item => item.id);
    const nextIdSet = new Set(nextIds);
    const removed: string[] = [];
    for (const id of prevById.keys()) {
        if (!nextIdSet.has(id)) removed.push(id);
    }
    if (removed.length > 0) {
        await deletePendingIdsInDb(db, queueType, removed);
    }

    if (canApplyMonotonicDiff(prevIndex, nextIds)) {
        const added: PhotoAsset[] = [];
        for (const item of normalizedNext) {
            const prevItem = prevById.get(item.id);
            if (!prevItem) {
                added.push(item);
                continue;
            }
            const itemChanged = prevItem !== item && JSON.stringify(prevItem) !== JSON.stringify(item);
            const infoChanged = queueType !== 'collection'
                && !pendingDeletionInfoEqual(prevInfo[item.id], nextInfo[item.id]);
            if (itemChanged || infoChanged) {
                const rawInfo = queueType === 'collection' ? undefined : nextInfo[item.id];
                const validInfo = rawInfo !== undefined ? validatePendingDeletionInfoEntry(rawInfo) : null;
                await db.runAsync(
                    `UPDATE media_pending_queue
                     SET asset_json = ?, source = ?, added_at = ?
                     WHERE queue_type = ? AND asset_id = ?`,
                    [
                        JSON.stringify(item),
                        validInfo?.source ?? null,
                        validInfo?.addedAt ?? null,
                        queueType,
                        item.id,
                    ]
                );
            }
        }
        if (added.length > 0) {
            await upsertPendingItemsInDb(db, queueType, added, nextInfo, false);
        }
        return;
    }

    // Rare path: reordered or mid-inserted queue items; rewrite sequences in batches.
    await insertPendingRowsBatchInDb(
        db,
        queueType,
        normalizedNext.map((asset, seq) => {
            const rawInfo = queueType === 'collection' ? undefined : nextInfo[asset.id];
            const info = rawInfo !== undefined ? validatePendingDeletionInfoEntry(rawInfo) : null;
            return { asset, seq, info };
        })
    );
}

export const MediaProgressRepository = {
    async loadAll(): Promise<MediaProgressCollections> {
        const db = await getDatabase();
        const processedRows = await db.getAllAsync<ProcessedRow>(
            `SELECT media_type, asset_id, seq
             FROM media_processed_records
             ORDER BY media_type ASC, seq ASC, asset_id ASC`
        );
        const pendingRows = await db.getAllAsync<PendingQueueRow>(
            `SELECT queue_type, asset_id, seq, asset_json, source, added_at
             FROM media_pending_queue
             ORDER BY queue_type ASC, seq ASC, asset_id ASC`
        );

        const photoProcessedIds: string[] = [];
        const videoProcessedIds: string[] = [];
        for (const row of processedRows) {
            if (typeof row.asset_id !== 'string' || row.asset_id.length === 0) {
                throw new LocalPrivacyError();
            }
            if (row.media_type === 'photo') {
                photoProcessedIds.push(row.asset_id);
            } else if (row.media_type === 'video') {
                videoProcessedIds.push(row.asset_id);
            } else {
                throw new LocalPrivacyError();
            }
        }

        const deleteQueue: PhotoAsset[] = [];
        const videoTrashBin: PhotoAsset[] = [];
        const collectionQueue: PhotoAsset[] = [];
        const pendingDeletionInfo: Record<string, PendingDeletionInfo> = {};

        for (const row of pendingRows) {
            if (typeof row.asset_id !== 'string' || row.asset_id.length === 0 || typeof row.asset_json !== 'string') {
                throw new LocalPrivacyError();
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(row.asset_json);
            } catch {
                throw new LocalPrivacyError();
            }
            if (
                !parsed
                || typeof parsed !== 'object'
                || Array.isArray(parsed)
                || !('id' in parsed)
                || (parsed as { id: unknown }).id !== row.asset_id
            ) {
                throw new LocalPrivacyError();
            }

            if (row.queue_type === 'photo_delete' || row.queue_type === 'video_trash') {
                const hasSource = row.source !== null && row.source !== undefined;
                const hasAddedAt = row.added_at !== null && row.added_at !== undefined;
                if (hasSource !== hasAddedAt) {
                    throw new LocalPrivacyError();
                }
                if (hasSource && hasAddedAt) {
                    pendingDeletionInfo[row.asset_id] = validatePendingDeletionInfoEntry({
                        source: row.source,
                        addedAt: row.added_at,
                    });
                }
                if (row.queue_type === 'photo_delete') {
                    deleteQueue.push(parsed as PhotoAsset);
                } else {
                    videoTrashBin.push(parsed as PhotoAsset);
                }
            } else if (row.queue_type === 'collection') {
                if (
                    (row.source !== null && row.source !== undefined)
                    || (row.added_at !== null && row.added_at !== undefined)
                ) {
                    throw new LocalPrivacyError();
                }
                collectionQueue.push(parsed as PhotoAsset);
            } else {
                throw new LocalPrivacyError();
            }
        }

        return {
            photoProcessedIds,
            videoProcessedIds,
            deleteQueue,
            videoTrashBin,
            collectionQueue,
            pendingDeletionInfo,
        };
    },

    async replaceAll(collections: MediaProgressCollections): Promise<void> {
        const normalized = normalizeMediaProgressCollections(collections);
        await withTransaction(async db => {
            await db.runAsync('DELETE FROM media_processed_records');
            await db.runAsync('DELETE FROM media_pending_queue');

            await insertProcessedRowsBatchInDb(
                db,
                'photo',
                normalized.photoProcessedIds.map((id, seq) => ({ id, seq }))
            );
            await insertProcessedRowsBatchInDb(
                db,
                'video',
                normalized.videoProcessedIds.map((id, seq) => ({ id, seq }))
            );
            await insertPendingRowsBatchInDb(
                db,
                'photo_delete',
                normalized.deleteQueue.map((asset, seq) => ({
                    asset,
                    seq,
                    info: normalized.pendingDeletionInfo[asset.id] ?? null,
                }))
            );
            await insertPendingRowsBatchInDb(
                db,
                'video_trash',
                normalized.videoTrashBin.map((asset, seq) => ({
                    asset,
                    seq,
                    info: normalized.pendingDeletionInfo[asset.id] ?? null,
                }))
            );
            await insertPendingRowsBatchInDb(
                db,
                'collection',
                normalized.collectionQueue.map((asset, seq) => ({
                    asset,
                    seq,
                    info: null,
                }))
            );

            await db.runAsync(
                'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
                [MetaKeys.MEDIA_PROGRESS_SQLITE_MIGRATED, '1']
            );
        });
    },

    async syncCollections(
        previous: MediaProgressCollections,
        next: MediaProgressCollections
    ): Promise<void> {
        if (
            previous.photoProcessedIds === next.photoProcessedIds
            && previous.videoProcessedIds === next.videoProcessedIds
            && previous.deleteQueue === next.deleteQueue
            && previous.videoTrashBin === next.videoTrashBin
            && previous.collectionQueue === next.collectionQueue
            && previous.pendingDeletionInfo === next.pendingDeletionInfo
        ) {
            return;
        }

        await withTransaction(async db => {
            await syncProcessedListInDb(db, 'photo', previous.photoProcessedIds, next.photoProcessedIds);
            await syncProcessedListInDb(db, 'video', previous.videoProcessedIds, next.videoProcessedIds);
            await syncPendingQueueInDb(
                db,
                'photo_delete',
                previous.deleteQueue,
                next.deleteQueue,
                previous.pendingDeletionInfo,
                next.pendingDeletionInfo
            );
            await syncPendingQueueInDb(
                db,
                'video_trash',
                previous.videoTrashBin,
                next.videoTrashBin,
                previous.pendingDeletionInfo,
                next.pendingDeletionInfo
            );
            await syncPendingQueueInDb(
                db,
                'collection',
                previous.collectionQueue,
                next.collectionQueue,
                previous.pendingDeletionInfo,
                next.pendingDeletionInfo
            );
        });
    },

    async addProcessedIds(mediaType: ProcessedMediaType, ids: readonly string[]): Promise<void> {
        const normalized = dedupeStrings(ids);
        if (normalized.length === 0) return;
        await withTransaction(async db => {
            await addProcessedIdsInDb(db, mediaType, normalized, true);
        });
    },

    async removeProcessedIds(mediaType: ProcessedMediaType, ids: readonly string[]): Promise<void> {
        const normalized = dedupeStrings(ids);
        if (normalized.length === 0) return;
        await withTransaction(async db => {
            await deleteProcessedIdsInDb(db, mediaType, normalized);
        });
    },

    async clearProcessedIds(mediaType: ProcessedMediaType): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                'DELETE FROM media_processed_records WHERE media_type = ?',
                [mediaType]
            );
        });
    },

    async upsertPendingItems(
        queueType: PendingQueueType,
        assets: readonly PhotoAsset[],
        pendingDeletionInfo?: Readonly<Record<string, PendingDeletionInfo>>
    ): Promise<void> {
        const normalized = dedupeAssets(assets);
        if (normalized.length === 0) return;
        await withTransaction(async db => {
            await upsertPendingItemsInDb(db, queueType, normalized, pendingDeletionInfo, true);
        });
    },

    async removePendingItems(queueType: PendingQueueType, ids: readonly string[]): Promise<void> {
        const normalized = dedupeStrings(ids);
        if (normalized.length === 0) return;
        await withTransaction(async db => {
            await deletePendingIdsInDb(db, queueType, normalized);
        });
    },

    async clearPendingItems(queueType: PendingQueueType): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                'DELETE FROM media_pending_queue WHERE queue_type = ?',
                [queueType]
            );
        });
    },
};
