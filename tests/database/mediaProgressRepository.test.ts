jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({
  getDatabase: jest.fn(),
  withTransaction: jest.fn(),
}));

import { getDatabase, withTransaction } from '../../database/db';
import { runMigrations } from '../../database/migrations';
import { AssetRepository } from '../../database/repositories/AssetRepository';
import {
  MediaProgressRepository,
  emptyMediaProgressCollections,
} from '../../database/repositories/MediaProgressRepository';
import { TestDatabase } from '../helpers/testDatabase';
import { DatabaseSync } from 'node:sqlite';

const makePhoto = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  filename: `${id}.jpg`,
  uri: `file:///${id}.jpg`,
  mediaType: 'photo',
  width: 1200,
  height: 900,
  creationTime: 1000,
  modificationTime: 1000,
  duration: 0,
  ...extra,
}) as any;

const makeVideo = (id: string) => ({
  ...makePhoto(id),
  filename: `${id}.mp4`,
  uri: `file:///${id}.mp4`,
  mediaType: 'video',
  duration: 12,
}) as any;

describe('MediaProgressRepository (SQLCipher row-level storage V7)', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = new TestDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(db);
    (withTransaction as jest.Mock).mockImplementation(async (callback: (database: TestDatabase) => Promise<unknown>) => {
      let result: unknown;
      await db.withTransactionAsync(async () => {
        result = await callback(db);
      });
      return result;
    });
  });

  afterEach(async () => {
    await db.closeAsync();
  });

  it('replaces and loads all six collections preserving exact order, payloads, and pendingDeletionInfo metadata', async () => {
    const initial = {
      photoProcessedIds: ['p-3', 'p-1', 'p-2'],
      videoProcessedIds: ['v-2', 'v-1'],
      deleteQueue: [makePhoto('p-del-2'), makePhoto('p-del-1')],
      videoTrashBin: [makeVideo('v-trash-1')],
      collectionQueue: [makePhoto('c-1'), makePhoto('c-2')],
      pendingDeletionInfo: {
        'p-del-2': { source: 'blur' as const, addedAt: 100 },
        'v-trash-1': { source: 'videos' as const, addedAt: 200 },
      },
    };

    await MediaProgressRepository.replaceAll(initial);
    const loaded = await MediaProgressRepository.loadAll();

    expect(loaded).toEqual(initial);
    const processedRows = await db.getAllAsync<{ media_type: string; asset_id: string; seq: number }>(
      'SELECT media_type, asset_id, seq FROM media_processed_records ORDER BY media_type ASC, seq ASC'
    );
    expect(processedRows).toEqual([
      { media_type: 'photo', asset_id: 'p-3', seq: 0 },
      { media_type: 'photo', asset_id: 'p-1', seq: 1 },
      { media_type: 'photo', asset_id: 'p-2', seq: 2 },
      { media_type: 'video', asset_id: 'v-2', seq: 0 },
      { media_type: 'video', asset_id: 'v-1', seq: 1 },
    ]);
  });

  it('performs incremental row-level diff writes on append/remove without rewriting unchanged rows', async () => {
    const base = {
      photoProcessedIds: ['p-1', 'p-2', 'p-3'],
      videoProcessedIds: ['v-1'],
      deleteQueue: [makePhoto('d-1'), makePhoto('d-2')],
      videoTrashBin: [makeVideo('vt-1')],
      collectionQueue: [makePhoto('c-1')],
      pendingDeletionInfo: {
        'd-1': { source: 'photos' as const, addedAt: 10 },
      },
    };
    await MediaProgressRepository.replaceAll(base);

    const runSpy = jest.spyOn(db, 'runAsync');
    const afterAppend = {
      ...base,
      photoProcessedIds: [...base.photoProcessedIds, 'p-4'],
      deleteQueue: [...base.deleteQueue, makePhoto('d-3')],
      pendingDeletionInfo: {
        ...base.pendingDeletionInfo,
        'd-3': { source: 'similar' as const, addedAt: 30 },
      },
    };
    await MediaProgressRepository.syncCollections(base, afterAppend);

    const sqlCalls = runSpy.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[0]).toContain('INSERT OR REPLACE INTO media_processed_records');
    expect(sqlCalls[1]).toContain('INSERT OR REPLACE INTO media_pending_queue');
    expect(await MediaProgressRepository.loadAll()).toEqual(afterAppend);

    runSpy.mockClear();
    const afterRemove = {
      ...afterAppend,
      photoProcessedIds: ['p-1', 'p-3', 'p-4'],
      deleteQueue: [afterAppend.deleteQueue[0], afterAppend.deleteQueue[2]],
      videoTrashBin: [],
      collectionQueue: [],
    };
    await MediaProgressRepository.syncCollections(afterAppend, afterRemove);
    expect(await MediaProgressRepository.loadAll()).toEqual(afterRemove);
  });

  it('uses monotonic seq holes so deleting index 0 of 5,000 processed records executes only 1 DELETE statement', async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `photo-${i}`);
    const initial = {
      ...emptyMediaProgressCollections(),
      photoProcessedIds: ids,
    };

    const runSpy = jest.spyOn(db, 'runAsync');
    await MediaProgressRepository.replaceAll(initial);
    // Multi-row VALUES batching: 5000 / 250 = 20 INSERT statements (+ 2 DELETEs + 1 meta) << 5000.
    expect(runSpy.mock.calls.length).toBeLessThan(30);

    runSpy.mockClear();
    const afterDeleteHead = {
      ...initial,
      photoProcessedIds: ids.slice(1),
    };
    await MediaProgressRepository.syncCollections(initial, afterDeleteHead);

    // Must execute ONLY 1 DELETE statement — zero rewrites of the remaining 4,999 rows!
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toContain('DELETE FROM media_processed_records');

    // Appending after a hole keeps strict monotonic ordering.
    runSpy.mockClear();
    const afterAppend = {
      ...afterDeleteHead,
      photoProcessedIds: [...afterDeleteHead.photoProcessedIds, 'photo-5000'],
    };
    await MediaProgressRepository.syncCollections(afterDeleteHead, afterAppend);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toContain('INSERT OR REPLACE INTO media_processed_records');

    const loaded = await MediaProgressRepository.loadAll();
    expect(loaded.photoProcessedIds).toHaveLength(5000);
    expect(loaded.photoProcessedIds[0]).toBe('photo-1');
    expect(loaded.photoProcessedIds[4999]).toBe('photo-5000');
  });

  it('handles large multi-thousand-row batches safely within SQLite bind parameter limits', async () => {
    const largeIds = Array.from({ length: 1200 }, (_, i) => `photo-${i}`);
    const largeQueue = Array.from({ length: 650 }, (_, i) => makePhoto(`del-${i}`));
    const largeCollection = Array.from({ length: 320 }, (_, i) => makePhoto(`col-${i}`));
    const largeInfo = Object.fromEntries(
      largeQueue.map((item, idx) => [item.id, { source: 'photos' as const, addedAt: idx }])
    );
    const initial = {
      photoProcessedIds: largeIds,
      videoProcessedIds: ['vid-1'],
      deleteQueue: largeQueue,
      videoTrashBin: [],
      collectionQueue: largeCollection,
      pendingDeletionInfo: largeInfo,
    };

    await MediaProgressRepository.replaceAll(initial);
    const loaded = await MediaProgressRepository.loadAll();
    expect(loaded.photoProcessedIds).toHaveLength(1200);
    expect(loaded.photoProcessedIds[0]).toBe('photo-0');
    expect(loaded.photoProcessedIds[1199]).toBe('photo-1199');
    expect(loaded.deleteQueue).toHaveLength(650);
    expect(loaded.collectionQueue).toHaveLength(320);
    expect(loaded.pendingDeletionInfo['del-649']).toEqual({ source: 'photos', addedAt: 649 });

    // Removing >500 rows at once must chunk DELETE ... IN (...) queries cleanly.
    const trimmedInfo = Object.fromEntries(
      largeQueue.slice(600).map((item, idx) => [item.id, { source: 'photos' as const, addedAt: 600 + idx }])
    );
    const trimmed = {
      ...initial,
      photoProcessedIds: largeIds.slice(600),
      deleteQueue: largeQueue.slice(600),
      collectionQueue: largeCollection.slice(300),
      pendingDeletionInfo: trimmedInfo,
    };
    await MediaProgressRepository.syncCollections(initial, trimmed);
    const afterTrim = await MediaProgressRepository.loadAll();
    expect(afterTrim.photoProcessedIds).toEqual(largeIds.slice(600));
    expect(afterTrim.deleteQueue.map(item => item.id)).toEqual(largeQueue.slice(600).map(item => item.id));
    expect(afterTrim.collectionQueue.map(item => item.id)).toEqual(largeCollection.slice(300).map(item => item.id));
    expect(Object.keys(afterTrim.pendingDeletionInfo)).toHaveLength(50);
  });

  it('supports direct row-level add, remove, upsert, and clear primitives including collection queue', async () => {
    await MediaProgressRepository.addProcessedIds('photo', ['a', 'b']);
    await MediaProgressRepository.addProcessedIds('photo', ['b', 'c']);
    await MediaProgressRepository.upsertPendingItems(
      'video_trash',
      [makeVideo('v1'), makeVideo('v2')],
      { v1: { source: 'videos', addedAt: 11 } }
    );
    await MediaProgressRepository.upsertPendingItems('collection', [makePhoto('col-1')]);
    expect(await MediaProgressRepository.loadAll()).toEqual({
      photoProcessedIds: ['a', 'b', 'c'],
      videoProcessedIds: [],
      deleteQueue: [],
      videoTrashBin: [makeVideo('v1'), makeVideo('v2')],
      collectionQueue: [makePhoto('col-1')],
      pendingDeletionInfo: { v1: { source: 'videos', addedAt: 11 } },
    });

    await MediaProgressRepository.removeProcessedIds('photo', ['b']);
    await MediaProgressRepository.removePendingItems('video_trash', ['v1']);
    await MediaProgressRepository.removePendingItems('collection', ['col-1']);
    expect(await MediaProgressRepository.loadAll()).toEqual({
      photoProcessedIds: ['a', 'c'],
      videoProcessedIds: [],
      deleteQueue: [],
      videoTrashBin: [makeVideo('v2')],
      collectionQueue: [],
      pendingDeletionInfo: {},
    });

    await MediaProgressRepository.clearProcessedIds('photo');
    await MediaProgressRepository.clearPendingItems('video_trash');
    expect(await MediaProgressRepository.loadAll()).toEqual(emptyMediaProgressCollections());
  });

  it('fails closed when persisted SQLCipher rows contain corrupt JSON, mismatched IDs, or malformed metadata', async () => {
    await db.runAsync(
      `INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json, source, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['photo_delete', 'photo-1', 0, '{corrupt', null, null]
    );
    await expect(MediaProgressRepository.loadAll()).rejects.toThrow('original data was preserved');

    await db.runAsync('DELETE FROM media_pending_queue');
    await db.runAsync(
      `INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json, source, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['photo_delete', 'photo-1', 0, JSON.stringify({ id: 'different-id' }), null, null]
    );
    await expect(MediaProgressRepository.loadAll()).rejects.toThrow('original data was preserved');

    await db.runAsync('DELETE FROM media_pending_queue');
    await db.runAsync(
      `INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json, source, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['photo_delete', 'photo-1', 0, JSON.stringify({ id: 'photo-1' }), 'invalid-source', 10]
    );
    await expect(MediaProgressRepository.loadAll()).rejects.toThrow('original data was preserved');

    await db.runAsync('DELETE FROM media_pending_queue');
    await db.runAsync(
      `INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json, source, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['photo_delete', 'photo-1', 0, JSON.stringify({ id: 'photo-1' }), 'photos', null]
    );
    await expect(MediaProgressRepository.loadAll()).rejects.toThrow('original data was preserved');
  });

  it('keeps organizing progress tables untouched when AI scanner resetAll runs', async () => {
    await MediaProgressRepository.replaceAll({
      photoProcessedIds: ['keep-me'],
      videoProcessedIds: ['keep-video'],
      deleteQueue: [makePhoto('pending-photo')],
      videoTrashBin: [makeVideo('pending-video')],
      collectionQueue: [makePhoto('keep-collection')],
      pendingDeletionInfo: { 'pending-photo': { source: 'blur', addedAt: 55 } },
    });

    await AssetRepository.resetAll();

    const loaded = await MediaProgressRepository.loadAll();
    expect(loaded.photoProcessedIds).toEqual(['keep-me']);
    expect(loaded.videoProcessedIds).toEqual(['keep-video']);
    expect(loaded.deleteQueue.map(item => item.id)).toEqual(['pending-photo']);
    expect(loaded.videoTrashBin.map(item => item.id)).toEqual(['pending-video']);
    expect(loaded.collectionQueue.map(item => item.id)).toEqual(['keep-collection']);
    expect(loaded.pendingDeletionInfo).toEqual({ 'pending-photo': { source: 'blur', addedAt: 55 } });
  });

  it('upgrades both fresh and V6 databases through migration V7 with new columns and composite indexes', async () => {
    const rawDb = new DatabaseSync(':memory:');
    const adapter = {
      execAsync: async (sql: string) => { rawDb.exec(sql); },
      withTransactionAsync: async (cb: () => Promise<void>) => {
        rawDb.exec('BEGIN');
        try { await cb(); rawDb.exec('COMMIT'); } catch (e) { rawDb.exec('ROLLBACK'); throw e; }
      },
      runAsync: async (sql: string, params: any[] = []) => {
        const res = rawDb.prepare(sql).run(...params);
        return { changes: Number(res.changes), lastInsertRowId: Number(res.lastInsertRowid) };
      },
      getFirstAsync: async (sql: string, params: any[] = []) => (rawDb.prepare(sql).get(...params) ?? null) as any,
      getAllAsync: async (sql: string, params: any[] = []) => rawDb.prepare(sql).all(...params) as any[],
    } as any;

    try {
      await runMigrations(adapter);
      const version = rawDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      expect(version.value).toBe('8');
      const tables = rawDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('media_processed_records', 'media_pending_queue') ORDER BY name"
      ).all() as { name: string }[];
      expect(tables.map(t => t.name)).toEqual(['media_pending_queue', 'media_processed_records']);
      const columns = rawDb.prepare('PRAGMA table_info(media_pending_queue)').all() as { name: string }[];
      expect(columns.map(c => c.name)).toEqual(expect.arrayContaining(['source', 'added_at']));
      const indexes = rawDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_assets_status_blur', 'idx_dup_groups_created') ORDER BY name"
      ).all() as { name: string }[];
      expect(indexes.map(i => i.name)).toEqual(['idx_assets_status_blur', 'idx_dup_groups_created']);
    } finally {
      rawDb.close();
    }

    // Also test upgrading an actual V6 database (without source/added_at or V7 indexes) preserving rows.
    const v6Db = new DatabaseSync(':memory:');
    const v6Adapter = {
      execAsync: async (sql: string) => { v6Db.exec(sql); },
      withTransactionAsync: async (cb: () => Promise<void>) => {
        v6Db.exec('BEGIN');
        try { await cb(); v6Db.exec('COMMIT'); } catch (e) { v6Db.exec('ROLLBACK'); throw e; }
      },
      runAsync: async (sql: string, params: any[] = []) => {
        const res = v6Db.prepare(sql).run(...params);
        return { changes: Number(res.changes), lastInsertRowId: Number(res.lastInsertRowid) };
      },
      getFirstAsync: async (sql: string, params: any[] = []) => (v6Db.prepare(sql).get(...params) ?? null) as any,
      getAllAsync: async (sql: string, params: any[] = []) => v6Db.prepare(sql).all(...params) as any[],
    } as any;
    try {
      v6Db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta (key, value) VALUES ('schema_version', '6');
        CREATE TABLE assets (asset_id TEXT PRIMARY KEY, status INTEGER DEFAULT 0, blur_score REAL, mean_luma REAL);
        CREATE TABLE dup_groups (group_id TEXT PRIMARY KEY, representative_asset_id TEXT, best_asset_id TEXT, created_at INTEGER);
        CREATE TABLE media_processed_records (media_type TEXT NOT NULL, asset_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (media_type, asset_id));
        CREATE TABLE media_pending_queue (queue_type TEXT NOT NULL, asset_id TEXT NOT NULL, seq INTEGER NOT NULL, asset_json TEXT NOT NULL, PRIMARY KEY (queue_type, asset_id));
        INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json) VALUES ('photo_delete', 'p-1', 0, '{"id":"p-1"}');
      `);
      await runMigrations(v6Adapter);
      const version = v6Db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      expect(version.value).toBe('8');
      const cols = v6Db.prepare('PRAGMA table_info(media_pending_queue)').all() as { name: string }[];
      expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(['source', 'added_at']));
      const row = v6Db.prepare("SELECT asset_id, source, added_at FROM media_pending_queue WHERE asset_id = 'p-1'").get() as any;
      expect(row).toEqual({ asset_id: 'p-1', source: null, added_at: null });
      const idx = v6Db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_assets_status_blur', 'idx_dup_groups_created') ORDER BY name"
      ).all() as { name: string }[];
      expect(idx.map(i => i.name)).toEqual(['idx_assets_status_blur', 'idx_dup_groups_created']);
    } finally {
      v6Db.close();
    }
  });
});
