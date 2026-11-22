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

describe('MediaProgressRepository (SQLCipher row-level storage)', () => {
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

  it('replaces and loads all four collections preserving exact order and asset payloads', async () => {
    const initial = {
      photoProcessedIds: ['p-3', 'p-1', 'p-2'],
      videoProcessedIds: ['v-2', 'v-1'],
      deleteQueue: [makePhoto('p-del-2'), makePhoto('p-del-1')],
      videoTrashBin: [makeVideo('v-trash-1')],
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
    };
    await MediaProgressRepository.replaceAll(base);

    const runSpy = jest.spyOn(db, 'runAsync');
    const afterAppend = {
      ...base,
      photoProcessedIds: [...base.photoProcessedIds, 'p-4'],
      deleteQueue: [...base.deleteQueue, makePhoto('d-3')],
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
    };
    await MediaProgressRepository.syncCollections(afterAppend, afterRemove);
    expect(await MediaProgressRepository.loadAll()).toEqual(afterRemove);
  });

  it('handles large multi-thousand-row batches safely within SQLite bind parameter limits', async () => {
    const largeIds = Array.from({ length: 1200 }, (_, i) => `photo-${i}`);
    const largeQueue = Array.from({ length: 650 }, (_, i) => makePhoto(`del-${i}`));
    const initial = {
      photoProcessedIds: largeIds,
      videoProcessedIds: ['vid-1'],
      deleteQueue: largeQueue,
      videoTrashBin: [],
    };

    await MediaProgressRepository.replaceAll(initial);
    const loaded = await MediaProgressRepository.loadAll();
    expect(loaded.photoProcessedIds).toHaveLength(1200);
    expect(loaded.photoProcessedIds[0]).toBe('photo-0');
    expect(loaded.photoProcessedIds[1199]).toBe('photo-1199');
    expect(loaded.deleteQueue).toHaveLength(650);

    // Removing >500 rows at once must chunk DELETE ... IN (...) queries cleanly.
    const trimmed = {
      ...initial,
      photoProcessedIds: largeIds.slice(600),
      deleteQueue: largeQueue.slice(600),
    };
    await MediaProgressRepository.syncCollections(initial, trimmed);
    const afterTrim = await MediaProgressRepository.loadAll();
    expect(afterTrim.photoProcessedIds).toEqual(largeIds.slice(600));
    expect(afterTrim.deleteQueue.map(item => item.id)).toEqual(largeQueue.slice(600).map(item => item.id));
  });

  it('supports direct row-level add, remove, upsert, and clear primitives', async () => {
    await MediaProgressRepository.addProcessedIds('photo', ['a', 'b']);
    await MediaProgressRepository.addProcessedIds('photo', ['b', 'c']);
    await MediaProgressRepository.upsertPendingItems('video_trash', [makeVideo('v1'), makeVideo('v2')]);
    expect(await MediaProgressRepository.loadAll()).toEqual({
      photoProcessedIds: ['a', 'b', 'c'],
      videoProcessedIds: [],
      deleteQueue: [],
      videoTrashBin: [makeVideo('v1'), makeVideo('v2')],
    });

    await MediaProgressRepository.removeProcessedIds('photo', ['b']);
    await MediaProgressRepository.removePendingItems('video_trash', ['v1']);
    expect(await MediaProgressRepository.loadAll()).toEqual({
      photoProcessedIds: ['a', 'c'],
      videoProcessedIds: [],
      deleteQueue: [],
      videoTrashBin: [makeVideo('v2')],
    });

    await MediaProgressRepository.clearProcessedIds('photo');
    await MediaProgressRepository.clearPendingItems('video_trash');
    expect(await MediaProgressRepository.loadAll()).toEqual(emptyMediaProgressCollections());
  });

  it('fails closed when persisted SQLCipher rows contain corrupt JSON or mismatched IDs', async () => {
    await db.runAsync(
      `INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json)
       VALUES (?, ?, ?, ?)`,
      ['photo_delete', 'photo-1', 0, '{corrupt']
    );
    await expect(MediaProgressRepository.loadAll()).rejects.toThrow('original data was preserved');

    await db.runAsync('DELETE FROM media_pending_queue');
    await db.runAsync(
      `INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json)
       VALUES (?, ?, ?, ?)`,
      ['photo_delete', 'photo-1', 0, JSON.stringify({ id: 'different-id' })]
    );
    await expect(MediaProgressRepository.loadAll()).rejects.toThrow('original data was preserved');
  });

  it('keeps organizing progress tables untouched when AI scanner resetAll runs', async () => {
    await MediaProgressRepository.replaceAll({
      photoProcessedIds: ['keep-me'],
      videoProcessedIds: ['keep-video'],
      deleteQueue: [makePhoto('pending-photo')],
      videoTrashBin: [makeVideo('pending-video')],
    });

    await AssetRepository.resetAll();

    const loaded = await MediaProgressRepository.loadAll();
    expect(loaded.photoProcessedIds).toEqual(['keep-me']);
    expect(loaded.videoProcessedIds).toEqual(['keep-video']);
    expect(loaded.deleteQueue.map(item => item.id)).toEqual(['pending-photo']);
    expect(loaded.videoTrashBin.map(item => item.id)).toEqual(['pending-video']);
  });

  it('upgrades a fresh database through migration V6 creating media progress tables and indexes', async () => {
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
      expect(version.value).toBe('6');
      const tables = rawDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('media_processed_records', 'media_pending_queue') ORDER BY name"
      ).all() as { name: string }[];
      expect(tables.map(t => t.name)).toEqual(['media_pending_queue', 'media_processed_records']);
    } finally {
      rawDb.close();
    }
  });
});
