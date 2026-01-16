/**
 * Meta Repository - Key/Value storage for scanner state
 */

import { getDatabase } from '../db';
import { MetaKeys } from '../schema';

export interface ScanCursor {
    takenAt: number | null;
    assetId: string | null;
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
        const db = await getDatabase();
        await db.runAsync(
            'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
            [key, value]
        );
    },

    /**
     * Get global algorithm version
     */
    async getGlobalAlgoVersion(): Promise<number> {
        const value = await this.get(MetaKeys.GLOBAL_ALGO_VERSION);
        return value ? parseInt(value, 10) : 1;
    },

    /**
     * Get scan cursor for incremental scanning
     */
    async getScanCursor(): Promise<ScanCursor> {
        const takenAtStr = await this.get(MetaKeys.SCAN_CURSOR_TAKEN_AT);
        const assetId = await this.get(MetaKeys.SCAN_CURSOR_ASSET_ID);

        return {
            takenAt: takenAtStr ? parseInt(takenAtStr, 10) : null,
            assetId: assetId,
        };
    },

    /**
     * Update scan cursor
     */
    async setScanCursor(takenAt: number, assetId: string): Promise<void> {
        await this.set(MetaKeys.SCAN_CURSOR_TAKEN_AT, takenAt.toString());
        await this.set(MetaKeys.SCAN_CURSOR_ASSET_ID, assetId);
    },

    /**
     * Reset scan cursor (start from beginning)
     */
    async resetScanCursor(): Promise<void> {
        const db = await getDatabase();
        await db.runAsync(
            'DELETE FROM meta WHERE key IN (?, ?)',
            [MetaKeys.SCAN_CURSOR_TAKEN_AT, MetaKeys.SCAN_CURSOR_ASSET_ID]
        );
    },
};
