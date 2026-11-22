import { getDatabase, withTransaction } from '../db';

export interface ProtectedAlbumRecord {
    albumId: string;
    title: string;
    createdAt: number;
}

interface ProtectedAlbumRow {
    album_id: string;
    title: string;
    created_at: number;
}

const SQLITE_BATCH_SIZE = 300;

function normalizeAlbum(input: {
    albumId: string;
    title: string;
    createdAt?: number;
}): ProtectedAlbumRecord | null {
    const albumId = typeof input.albumId === 'string' ? input.albumId.trim() : '';
    if (!albumId || albumId.length > 512) return null;
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 256) : '';
    const createdAt = typeof input.createdAt === 'number' && Number.isSafeInteger(input.createdAt) && input.createdAt >= 0
        ? input.createdAt
        : Date.now();
    return { albumId, title: title || albumId, createdAt };
}

export const ProtectedAlbumRepository = {
    async getAll(): Promise<ProtectedAlbumRecord[]> {
        const db = await getDatabase();
        const rows = await db.getAllAsync<ProtectedAlbumRow>(
            `SELECT album_id, title, created_at
             FROM protected_albums
             ORDER BY created_at ASC, album_id ASC`,
        );
        const result: ProtectedAlbumRecord[] = [];
        for (const row of rows) {
            if (typeof row.album_id !== 'string' || row.album_id.length === 0) continue;
            result.push({
                albumId: row.album_id,
                title: typeof row.title === 'string' && row.title.length > 0 ? row.title : row.album_id,
                createdAt: Number.isSafeInteger(row.created_at) && row.created_at >= 0 ? row.created_at : 0,
            });
        }
        return result;
    },

    async getAlbumIds(): Promise<string[]> {
        const all = await this.getAll();
        return all.map(album => album.albumId);
    },

    async replaceAll(
        albums: readonly { albumId: string; title: string; createdAt?: number }[],
    ): Promise<ProtectedAlbumRecord[]> {
        const deduped = new Map<string, ProtectedAlbumRecord>();
        for (const raw of albums) {
            const normalized = normalizeAlbum(raw);
            if (!normalized) continue;
            if (!deduped.has(normalized.albumId)) {
                deduped.set(normalized.albumId, normalized);
            }
        }
        const records = Array.from(deduped.values());

        await withTransaction(async db => {
            await db.runAsync('DELETE FROM protected_albums');
            for (let i = 0; i < records.length; i += SQLITE_BATCH_SIZE) {
                const batch = records.slice(i, i + SQLITE_BATCH_SIZE);
                const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
                const params: (string | number)[] = [];
                for (const record of batch) {
                    params.push(record.albumId, record.title, record.createdAt);
                }
                await db.runAsync(
                    `INSERT INTO protected_albums (album_id, title, created_at)
                     VALUES ${placeholders}`,
                    params,
                );
            }
        });

        return records;
    },

    async mergeAlbums(
        albums: readonly { albumId: string; title: string; createdAt?: number }[],
    ): Promise<number> {
        const deduped = new Map<string, ProtectedAlbumRecord>();
        for (const raw of albums) {
            const normalized = normalizeAlbum(raw);
            if (!normalized) continue;
            if (!deduped.has(normalized.albumId)) {
                deduped.set(normalized.albumId, normalized);
            }
        }
        const records = Array.from(deduped.values());
        if (records.length === 0) return 0;

        return withTransaction(async db => {
            let inserted = 0;
            for (let i = 0; i < records.length; i += SQLITE_BATCH_SIZE) {
                const batch = records.slice(i, i + SQLITE_BATCH_SIZE);
                const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
                const params: (string | number)[] = [];
                for (const record of batch) {
                    params.push(record.albumId, record.title, record.createdAt);
                }
                const result = await db.runAsync(
                    `INSERT OR IGNORE INTO protected_albums (album_id, title, created_at)
                     VALUES ${placeholders}`,
                    params,
                );
                inserted += result.changes;
            }
            return inserted;
        });
    },

    async addAlbum(albumId: string, title: string, createdAt = Date.now()): Promise<void> {
        const normalized = normalizeAlbum({ albumId, title, createdAt });
        if (!normalized) return;
        await withTransaction(async db => {
            await db.runAsync(
                `INSERT OR REPLACE INTO protected_albums (album_id, title, created_at)
                 VALUES (?, ?, ?)`,
                [normalized.albumId, normalized.title, normalized.createdAt],
            );
        });
    },

    async removeAlbum(albumId: string): Promise<void> {
        if (!albumId) return;
        await withTransaction(async db => {
            await db.runAsync('DELETE FROM protected_albums WHERE album_id = ?', [albumId]);
        });
    },
};
