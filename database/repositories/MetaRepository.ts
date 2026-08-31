/**
 * Meta Repository - Key/Value storage for scanner state
 */

import { getDatabase, withTransaction } from '../db';
import { GLOBAL_ALGO_VERSION, MetaKeys } from '../schema';

export interface ScanCursor {
    takenAt: number | null;
    assetId: string | null;
}

function parseStoredInteger(value: string | null): number | null {
    if (value === null) return null;

    const normalized = value.trim();
    if (!/^-?\d+$/.test(normalized)) return null;

    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export const MetaRepository = {
    /**
     * Get a meta value by key
     */
    async get(key: string): Promise<string | null> {
        const db = await getDatabase();
        const result = await db.getFirstAsync<{ value: string }>(
            'SELECT value FROM meta WHERE key = ?',
            [key]
        );
        return result?.value ?? null;
    },

    /**
     * Set a meta value
     */
    async set(key: string, value: string): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
                [key, value]
            );
        });
    },

    /**
     * Get global algorithm version
     */
    async getGlobalAlgoVersion(): Promise<number> {
        const value = await this.get(MetaKeys.GLOBAL_ALGO_VERSION);
        const parsedVersion = parseStoredInteger(value);
        const storedVersion = parsedVersion ?? 0;

        if (value !== null && parsedVersion === null) {
            console.warn(`[MetaRepository] Invalid stored algorithm version: ${value}`);
        }

        // Keep existing databases aligned when the app ships a new scanner
        // implementation. The next scan will then invalidate old results.
        if (storedVersion !== GLOBAL_ALGO_VERSION) {
            await this.set(MetaKeys.GLOBAL_ALGO_VERSION, GLOBAL_ALGO_VERSION.toString());
            return GLOBAL_ALGO_VERSION;
        }

        return storedVersion;
    },

    /**
     * Get scan cursor for incremental scanning
     */
    async getScanCursor(): Promise<ScanCursor> {
        const takenAtStr = await this.get(MetaKeys.SCAN_CURSOR_TAKEN_AT);
        const assetId = await this.get(MetaKeys.SCAN_CURSOR_ASSET_ID);
        const takenAt = parseStoredInteger(takenAtStr);
        const hasAssetId = assetId !== null && assetId.length > 0;

        if (
            (takenAtStr !== null && takenAt === null) ||
            (takenAt === null) !== (!hasAssetId)
        ) {
            console.warn('[MetaRepository] Invalid or incomplete scan cursor; restarting from the beginning.');
        }

        if (takenAt === null || !hasAssetId) {
            return { takenAt: null, assetId: null };
        }

        return {
            takenAt,
            assetId,
        };
    },

    /**
     * Update scan cursor
     */
    async setScanCursor(takenAt: number, assetId: string): Promise<void> {
        if (!Number.isSafeInteger(takenAt) || !assetId) {
            throw new Error('Cannot persist an invalid scan cursor');
        }
        await withTransaction(async db => {
            await db.runAsync(
                'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
                [MetaKeys.SCAN_CURSOR_TAKEN_AT, takenAt.toString()]
            );
            await db.runAsync(
                'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
                [MetaKeys.SCAN_CURSOR_ASSET_ID, assetId]
            );
        });
    },

    /**
     * Reset scan cursor (start from beginning)
     */
    async resetScanCursor(): Promise<void> {
        await withTransaction(async db => {
            await db.runAsync(
                'DELETE FROM meta WHERE key IN (?, ?)',
                [MetaKeys.SCAN_CURSOR_TAKEN_AT, MetaKeys.SCAN_CURSOR_ASSET_ID]
            );
        });
    },
};
