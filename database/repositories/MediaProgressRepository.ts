/**
 * Media Progress Repository - Row-level encrypted SQLCipher storage for
 * unbounded organizing progress and pending deletion queues.
 */

import * as SQLite from 'expo-sqlite';
import { getDatabase, withTransaction } from '../db';
import { MetaKeys } from '../schema';
import { LocalPrivacyError } from '../../stores/usePrivacyStore';
import type { PhotoAsset } from '../../stores/useMediaStore';
import {
    dedupeMediaAssets,
    dedupeMediaIds,
    emptyMediaProgressCollections,
    mediaProgressCollectionsEqual,
    normalizeMediaProgressCollections,
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

const SQLITE_BATCH_SIZE = 500;

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
}

const dedupeStrings = dedupeMediaIds;
const dedupeAssets = dedupeMediaAssets;

async function deleteProcessedIdsInDb(
    db: SQLite.SQLiteDatabase,
    mediaType: ProcessedMediaType,
    ids: readonly string[]
): Promise<void> {
    for (let i = 0; i < ids.length; i += SQLITE_BATCH_SIZE) {
        const batch = ids.slice(i, i + SQLITE_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        await db.runAsync(
            `DELETE FROM media_processed_records
             WHERE media_type = ? AND asset_id IN (${placeholders})`,
            [mediaType, ...batch]
        );
    }
}

async function deletePendingIdsInDb(
    db: SQLite.SQLiteDatabase,
    queueType: PendingQueueType,
    ids: readonly string[]
): Promise<void> {
    for (let i = 0; i < ids.length; i += SQLITE_BATCH_SIZE) {
        const batch = ids.slice(i, i + SQLITE_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        await db.runAsync(
            `DELETE FROM media_pending_queue
             WHERE queue_type = ? AND asset_id IN (${placeholders})`,
            [queueType, ...batch]
        );
    }
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

    for (let seq = 0; seq < normalizedNext.length; seq++) {
        const id = normalizedNext[seq];
        if (prevIndex.get(id) === seq) continue;
        await db.runAsync(
            `INSERT OR REPLACE INTO media_processed_records (media_type, asset_id, seq)
             VALUES (?, ?, ?)`,
            [mediaType, id, seq]
        );
    }
}

async function syncPendingQueueInDb(
    db: SQLite.SQLiteDatabase,
    queueType: PendingQueueType,
    prevItems: readonly PhotoAsset[],
    nextItems: readonly PhotoAsset[]
): Promise<void> {
    if (prevItems === nextItems) return;
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

    const prevById = new Map<string, { seq: number; item: PhotoAsset }>();
    prevItems.forEach((item, idx) => {
        if (item?.id && !prevById.has(item.id)) prevById.set(item.id, { seq: idx, item });
    });

    const nextIds = new Set(normalizedNext.map(item => item.id));
    const removed: string[] = [];
    for (const id of prevById.keys()) {
        if (!nextIds.has(id)) removed.push(id);
    }
    if (removed.length > 0) {
        await deletePendingIdsInDb(db, queueType, removed);
    }

    for (let seq = 0; seq < normalizedNext.length; seq++) {
        const item = normalizedNext[seq];
        const prevEntry = prevById.get(item.id);
        if (
            prevEntry
            && prevEntry.seq === seq
            && (prevEntry.item === item || JSON.stringify(prevEntry.item) === JSON.stringify(item))
        ) {
            continue;
        }
        await db.runAsync(
            `INSERT OR REPLACE INTO media_pending_queue (queue_type, asset_id, seq, asset_json)
             VALUES (?, ?, ?, ?)`,
            [queueType, item.id, seq, JSON.stringify(item)]
        );
    }
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
            `SELECT queue_type, asset_id, seq, asset_json
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
            if (row.queue_type === 'photo_delete') {
                deleteQueue.push(parsed as PhotoAsset);
            } else if (row.queue_type === 'video_trash') {
                videoTrashBin.push(parsed as PhotoAsset);
            } else {
                throw new LocalPrivacyError();
            }
        }

        return {
            photoProcessedIds,
            videoProcessedIds,
            deleteQueue,
            videoTrashBin,
        };
    },

    async replaceAll(collections: MediaProgressCollections): Promise<void> {
        const normalized = normalizeMediaProgressCollections(collections);
        await withTransaction(async db => {
            await db.runAsync('DELETE FROM media_processed_records');
            await db.runAsync('DELETE FROM media_pending_queue');

            for (let seq = 0; seq < normalized.photoProcessedIds.length; seq++) {
                await db.runAsync(
                    `INSERT INTO media_processed_records (media_type, asset_id, seq)
                     VALUES (?, ?, ?)`,
                    ['photo', normalized.photoProcessedIds[seq], seq]
                );
            }
            for (let seq = 0; seq < normalized.videoProcessedIds.length; seq++) {
                await db.runAsync(
                    `INSERT INTO media_processed_records (media_type, asset_id, seq)
                     VALUES (?, ?, ?)`,
                    ['video', normalized.videoProcessedIds[seq], seq]
                );
            }
            for (let seq = 0; seq < normalized.deleteQueue.length; seq++) {
                const asset = normalized.deleteQueue[seq];
                await db.runAsync(
                    `INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json)
                     VALUES (?, ?, ?, ?)`,
                    ['photo_delete', asset.id, seq, JSON.stringify(asset)]
                );
            }
            for (let seq = 0; seq < normalized.videoTrashBin.length; seq++) {
                const asset = normalized.videoTrashBin[seq];
                await db.runAsync(
                    `INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json)
                     VALUES (?, ?, ?, ?)`,
                    ['video_trash', asset.id, seq, JSON.stringify(asset)]
                );
            }

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
        ) {
            return;
        }

        await withTransaction(async db => {
            await syncProcessedListInDb(db, 'photo', previous.photoProcessedIds, next.photoProcessedIds);
            await syncProcessedListInDb(db, 'video', previous.videoProcessedIds, next.videoProcessedIds);
            await syncPendingQueueInDb(db, 'photo_delete', previous.deleteQueue, next.deleteQueue);
            await syncPendingQueueInDb(db, 'video_trash', previous.videoTrashBin, next.videoTrashBin);
        });
    },

    async addProcessedIds(mediaType: ProcessedMediaType, ids: readonly string[]): Promise<void> {
        const normalized = dedupeStrings(ids);
        if (normalized.length === 0) return;
        await withTransaction(async db => {
            const maxRow = await db.getFirstAsync<{ max_seq: number | null }>(
                'SELECT MAX(seq) AS max_seq FROM media_processed_records WHERE media_type = ?',
                [mediaType]
            );
            let nextSeq = (maxRow?.max_seq ?? -1) + 1;
            for (const id of normalized) {
                const existing = await db.getFirstAsync<{ asset_id: string }>(
                    'SELECT asset_id FROM media_processed_records WHERE media_type = ? AND asset_id = ?',
                    [mediaType, id]
                );
                if (existing) continue;
                await db.runAsync(
                    `INSERT INTO media_processed_records (media_type, asset_id, seq)
                     VALUES (?, ?, ?)`,
                    [mediaType, id, nextSeq++]
                );
            }
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

    async upsertPendingItems(queueType: PendingQueueType, assets: readonly PhotoAsset[]): Promise<void> {
        const normalized = dedupeAssets(assets);
        if (normalized.length === 0) return;
        await withTransaction(async db => {
            const maxRow = await db.getFirstAsync<{ max_seq: number | null }>(
                'SELECT MAX(seq) AS max_seq FROM media_pending_queue WHERE queue_type = ?',
                [queueType]
            );
            let nextSeq = (maxRow?.max_seq ?? -1) + 1;
            for (const asset of normalized) {
                const existing = await db.getFirstAsync<{ seq: number }>(
                    'SELECT seq FROM media_pending_queue WHERE queue_type = ? AND asset_id = ?',
                    [queueType, asset.id]
                );
                const seq = existing ? existing.seq : nextSeq++;
                await db.runAsync(
                    `INSERT OR REPLACE INTO media_pending_queue (queue_type, asset_id, seq, asset_json)
                     VALUES (?, ?, ?, ?)`,
                    [queueType, asset.id, seq, JSON.stringify(asset)]
                );
            }
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
