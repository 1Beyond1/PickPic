import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase, withTransaction } from '../db';

export type ReviewIgnoreType = 'blur' | 'similar_group';

export interface MediaReviewIgnore {
    ignoreType: ReviewIgnoreType;
    targetKey: string;
    createdAt: number;
}

interface ReviewIgnoreRow {
    ignore_type: string;
    target_key: string;
    created_at: number;
}

const SQLITE_BATCH_SIZE = 300;

function isValidIgnoreType(value: unknown): value is ReviewIgnoreType {
    return value === 'blur' || value === 'similar_group';
}

function normalizeEntry(entry: {
    ignoreType: ReviewIgnoreType;
    targetKey: string;
    createdAt?: number;
}): MediaReviewIgnore | null {
    if (!isValidIgnoreType(entry.ignoreType)) return null;
    const key = typeof entry.targetKey === 'string' ? entry.targetKey.trim() : '';
    if (!key || key.length > 512) return null;
    const createdAt = typeof entry.createdAt === 'number' && Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0
        ? entry.createdAt
        : Date.now();
    return { ignoreType: entry.ignoreType, targetKey: key, createdAt };
}

export async function removeBlurIgnoresForAssetsInDatabase(
    db: SQLiteDatabase,
    assetIds: readonly string[],
): Promise<void> {
    const uniqueIds = Array.from(new Set(assetIds.filter(id => typeof id === 'string' && id.length > 0)));
    if (uniqueIds.length === 0) return;

    for (let i = 0; i < uniqueIds.length; i += SQLITE_BATCH_SIZE) {
        const batch = uniqueIds.slice(i, i + SQLITE_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        await db.runAsync(
            `DELETE FROM media_review_ignores
             WHERE ignore_type = 'blur' AND target_key IN (${placeholders})`,
            batch,
        );
    }
}

export const ReviewIgnoreRepository = {
    async addIgnore(ignoreType: ReviewIgnoreType, targetKey: string, createdAt = Date.now()): Promise<void> {
        const entry = normalizeEntry({ ignoreType, targetKey, createdAt });
        if (!entry) return;
        await withTransaction(async db => {
            await db.runAsync(
                `INSERT OR REPLACE INTO media_review_ignores (ignore_type, target_key, created_at)
                 VALUES (?, ?, ?)`,
                [entry.ignoreType, entry.targetKey, entry.createdAt],
            );
        });
    },

    async addIgnores(entries: readonly { ignoreType: ReviewIgnoreType; targetKey: string; createdAt?: number }[]): Promise<number> {
        const deduped = new Map<string, MediaReviewIgnore>();
        for (const raw of entries) {
            const entry = normalizeEntry(raw);
            if (!entry) continue;
            deduped.set(`${entry.ignoreType}:${entry.targetKey}`, entry);
        }
        const normalized = Array.from(deduped.values());
        if (normalized.length === 0) return 0;

        await withTransaction(async db => {
            for (let i = 0; i < normalized.length; i += SQLITE_BATCH_SIZE) {
                const batch = normalized.slice(i, i + SQLITE_BATCH_SIZE);
                const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
                const params: (string | number)[] = [];
                for (const item of batch) {
                    params.push(item.ignoreType, item.targetKey, item.createdAt);
                }
                await db.runAsync(
                    `INSERT OR REPLACE INTO media_review_ignores (ignore_type, target_key, created_at)
                     VALUES ${placeholders}`,
                    params,
                );
            }
        });

        return normalized.length;
    },

    /** Merge ignores during encrypted backup restore without overwriting newer local entries. */
    async mergeIgnores(entries: readonly MediaReviewIgnore[]): Promise<number> {
        const deduped = new Map<string, MediaReviewIgnore>();
        for (const raw of entries) {
            const entry = normalizeEntry(raw);
            if (!entry) continue;
            deduped.set(`${entry.ignoreType}:${entry.targetKey}`, entry);
        }
        const normalized = Array.from(deduped.values());
        if (normalized.length === 0) return 0;

        return withTransaction(async db => {
            let inserted = 0;
            for (let i = 0; i < normalized.length; i += SQLITE_BATCH_SIZE) {
                const batch = normalized.slice(i, i + SQLITE_BATCH_SIZE);
                const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
                const params: (string | number)[] = [];
                for (const item of batch) {
                    params.push(item.ignoreType, item.targetKey, item.createdAt);
                }
                const result = await db.runAsync(
                    `INSERT OR IGNORE INTO media_review_ignores (ignore_type, target_key, created_at)
                     VALUES ${placeholders}`,
                    params,
                );
                inserted += result.changes;
            }
            return inserted;
        });
    },

    async removeIgnore(ignoreType: ReviewIgnoreType, targetKey: string): Promise<void> {
        if (!isValidIgnoreType(ignoreType) || !targetKey) return;
        await withTransaction(async db => {
            await db.runAsync(
                `DELETE FROM media_review_ignores WHERE ignore_type = ? AND target_key = ?`,
                [ignoreType, targetKey],
            );
        });
    },

    async isIgnored(ignoreType: ReviewIgnoreType, targetKey: string): Promise<boolean> {
        if (!isValidIgnoreType(ignoreType) || !targetKey) return false;
        const db = await getDatabase();
        const row = await db.getFirstAsync<{ target_key: string }>(
            `SELECT target_key FROM media_review_ignores WHERE ignore_type = ? AND target_key = ?`,
            [ignoreType, targetKey],
        );
        return row !== null;
    },

    async getIgnoredKeys(ignoreType: ReviewIgnoreType): Promise<Set<string>> {
        if (!isValidIgnoreType(ignoreType)) return new Set();
        const db = await getDatabase();
        const rows = await db.getAllAsync<{ target_key: string }>(
            `SELECT target_key FROM media_review_ignores WHERE ignore_type = ? ORDER BY created_at DESC, target_key ASC`,
            [ignoreType],
        );
        return new Set(rows.map(row => row.target_key));
    },

    async getAll(): Promise<MediaReviewIgnore[]> {
        const db = await getDatabase();
        const rows = await db.getAllAsync<ReviewIgnoreRow>(
            `SELECT ignore_type, target_key, created_at
             FROM media_review_ignores
             ORDER BY ignore_type ASC, created_at DESC, target_key ASC`,
        );
        const result: MediaReviewIgnore[] = [];
        for (const row of rows) {
            if (!isValidIgnoreType(row.ignore_type) || typeof row.target_key !== 'string' || row.target_key.length === 0) {
                continue;
            }
            result.push({
                ignoreType: row.ignore_type,
                targetKey: row.target_key,
                createdAt: Number.isSafeInteger(row.created_at) && row.created_at >= 0 ? row.created_at : 0,
            });
        }
        return result;
    },

    async clearAll(): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync('DELETE FROM media_review_ignores');
        });
    },
};
