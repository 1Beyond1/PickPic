jest.unmock('../../services/backup/changeTracker');
jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({
  getDatabase: jest.fn(),
  withTransaction: jest.fn(),
}));

import { DatabaseSync } from 'node:sqlite';
import { getDatabase, withTransaction } from '../../database/db';
import { runMigrations } from '../../database/migrations';
import { AssetRepository } from '../../database/repositories/AssetRepository';
import { ProtectedAlbumRepository } from '../../database/repositories/ProtectedAlbumRepository';
import { ReviewIgnoreRepository } from '../../database/repositories/ReviewIgnoreRepository';
import { AssetStatus } from '../../database/schema';
import {
  BACKUP_REMINDER_THRESHOLD,
  loadBackupChangeState,
  markBackupCompleted,
  recordBackupChanges,
  resetBackupChangeState,
  useBackupReminderStore,
} from '../../services/backup/changeTracker';
import { TestDatabase } from '../helpers/testDatabase';

function createRawAdapter(rawDb: DatabaseSync) {
  return {
    execAsync: async (sql: string) => { rawDb.exec(sql); },
    withTransactionAsync: async (cb: () => Promise<void>) => {
      rawDb.exec('BEGIN');
      try { await cb(); rawDb.exec('COMMIT'); }
      catch (error) { rawDb.exec('ROLLBACK'); throw error; }
    },
    runAsync: async (sql: string, params: any[] = []) => {
      const res = rawDb.prepare(sql).run(...params);
      return { changes: Number(res.changes), lastInsertRowId: Number(res.lastInsertRowid) };
    },
    getFirstAsync: async (sql: string, params: any[] = []) => (rawDb.prepare(sql).get(...params) ?? null) as any,
    getAllAsync: async (sql: string, params: any[] = []) => rawDb.prepare(sql).all(...params) as any[],
  } as any;
}

describe('SQLCipher Schema V8 migration & repositories', () => {
  let db: TestDatabase;

  beforeEach(() => {
    resetBackupChangeState();
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

  it('idempotently migrates a real V7 database to V8 while preserving existing rows and indexes', async () => {
    const v7Db = new DatabaseSync(':memory:');
    const adapter = createRawAdapter(v7Db);
    try {
      v7Db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta (key, value) VALUES ('schema_version', '7');
        CREATE TABLE assets (asset_id TEXT PRIMARY KEY, status INTEGER DEFAULT 0, blur_score REAL, mean_luma REAL);
        INSERT INTO assets (asset_id, status, blur_score, mean_luma) VALUES ('existing-asset', 1, 20.5, 128.0);
        CREATE TABLE media_processed_records (media_type TEXT NOT NULL, asset_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (media_type, asset_id));
        INSERT INTO media_processed_records (media_type, asset_id, seq) VALUES ('photo', 'p-keep', 0);
        CREATE TABLE media_pending_queue (queue_type TEXT NOT NULL, asset_id TEXT NOT NULL, seq INTEGER NOT NULL, asset_json TEXT NOT NULL, source TEXT, added_at INTEGER, PRIMARY KEY (queue_type, asset_id));
        INSERT INTO media_pending_queue (queue_type, asset_id, seq, asset_json, source, added_at) VALUES ('photo_delete', 'p-del', 0, '{"id":"p-del"}', 'blur', 100);
      `);

      await runMigrations(adapter);

      const version = v7Db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      expect(version.value).toBe('8');

      const tables = v7Db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('media_review_ignores', 'protected_albums') ORDER BY name",
      ).all() as { name: string }[];
      expect(tables.map(row => row.name)).toEqual(['media_review_ignores', 'protected_albums']);

      const indexes = v7Db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_media_review_ignores_type_created', 'idx_protected_albums_created') ORDER BY name",
      ).all() as { name: string }[];
      expect(indexes.map(row => row.name)).toEqual([
        'idx_media_review_ignores_type_created',
        'idx_protected_albums_created',
      ]);

      // Existing V7 rows are intact.
      expect(v7Db.prepare('SELECT asset_id FROM assets').all()).toEqual([{ asset_id: 'existing-asset' }]);
      expect(v7Db.prepare('SELECT asset_id FROM media_processed_records').all()).toEqual([{ asset_id: 'p-keep' }]);
      expect(v7Db.prepare('SELECT asset_id FROM media_pending_queue').all()).toEqual([{ asset_id: 'p-del' }]);

      // Insert V8 rows, then run migrations a second time to verify strict idempotency.
      v7Db.exec("INSERT INTO media_review_ignores (ignore_type, target_key, created_at) VALUES ('blur', 'existing-asset', 1000);");
      v7Db.exec("INSERT INTO protected_albums (album_id, title, created_at) VALUES ('alb-id', 'Documents', 2000);");

      await runMigrations(adapter);

      expect(v7Db.prepare('SELECT * FROM media_review_ignores').all()).toEqual([
        { ignore_type: 'blur', target_key: 'existing-asset', created_at: 1000 },
      ]);
      expect(v7Db.prepare('SELECT * FROM protected_albums').all()).toEqual([
        { album_id: 'alb-id', title: 'Documents', created_at: 2000 },
      ]);
    } finally {
      v7Db.close();
    }
  });

  it('persists review ignores, filters blur queries in SQL, and cleans up deleted blur ignores', async () => {
    await AssetRepository.upsertBatch([
      { asset_id: 'blur-1', status: AssetStatus.DONE, blur_score: 12, mean_luma: 120 },
      { asset_id: 'blur-2', status: AssetStatus.DONE, blur_score: 18, mean_luma: 120 },
      { asset_id: 'blur-3', status: AssetStatus.DONE, blur_score: 25, mean_luma: 120 },
    ]);

    expect((await AssetRepository.getBlurryAssets()).map(a => a.asset_id)).toEqual(['blur-1', 'blur-2', 'blur-3']);

    await ReviewIgnoreRepository.addIgnore('blur', 'blur-2', 1000);
    await ReviewIgnoreRepository.addIgnore('similar_group', 'snap-key-1', 1500);

    expect(await ReviewIgnoreRepository.isIgnored('blur', 'blur-2')).toBe(true);
    expect(await ReviewIgnoreRepository.isIgnored('similar_group', 'snap-key-1')).toBe(true);
    expect(await ReviewIgnoreRepository.getIgnoredKeys('blur')).toEqual(new Set(['blur-2']));
    expect(await ReviewIgnoreRepository.getIgnoredKeys('similar_group')).toEqual(new Set(['snap-key-1']));

    // SQL query excludes ignored blurry asset cleanly even with keyset pagination.
    expect((await AssetRepository.getBlurryAssets()).map(a => a.asset_id)).toEqual(['blur-1', 'blur-3']);

    // Merge ignores does not overwrite existing createdAt timestamps.
    const merged = await ReviewIgnoreRepository.mergeIgnores([
      { ignoreType: 'blur', targetKey: 'blur-2', createdAt: 9999 },
      { ignoreType: 'blur', targetKey: 'blur-3', createdAt: 2000 },
    ]);
    expect(merged).toBe(1);
    expect((await AssetRepository.getBlurryAssets()).map(a => a.asset_id)).toEqual(['blur-1']);

    // Scanner reset preserves explicit user ignores and protected albums.
    await ProtectedAlbumRepository.addAlbum('alb-work', 'Work', 500);
    await AssetRepository.resetAll();
    expect(await ReviewIgnoreRepository.getIgnoredKeys('blur')).toEqual(new Set(['blur-2', 'blur-3']));
    expect(await ProtectedAlbumRepository.getAlbumIds()).toEqual(['alb-work']);

    // Removing a physically deleted asset also cleans up its blur ignore row.
    await AssetRepository.removeAssetsAndDerivedData(['blur-2']);
    expect(await ReviewIgnoreRepository.getIgnoredKeys('blur')).toEqual(new Set(['blur-3']));
  });

  it('persists, replaces, and merges protected albums cleanly', async () => {
    await ProtectedAlbumRepository.replaceAll([
      { albumId: 'alb-1', title: 'ID Cards', createdAt: 10 },
      { albumId: 'alb-2', title: 'Work', createdAt: 20 },
      { albumId: 'alb-1', title: 'Duplicate Ignored', createdAt: 30 },
    ]);
    expect(await ProtectedAlbumRepository.getAll()).toEqual([
      { albumId: 'alb-1', title: 'ID Cards', createdAt: 10 },
      { albumId: 'alb-2', title: 'Work', createdAt: 20 },
    ]);

    const added = await ProtectedAlbumRepository.mergeAlbums([
      { albumId: 'alb-2', title: 'Other Title', createdAt: 99 },
      { albumId: 'alb-3', title: 'Favorites', createdAt: 30 },
    ]);
    expect(added).toBe(1);
    expect(await ProtectedAlbumRepository.getAlbumIds()).toEqual(['alb-1', 'alb-2', 'alb-3']);

    await ProtectedAlbumRepository.removeAlbum('alb-2');
    expect(await ProtectedAlbumRepository.getAlbumIds()).toEqual(['alb-1', 'alb-3']);
  });

  it('tracks unbacked-up local changes in encrypted meta and resets on backup completion', async () => {
    expect(await loadBackupChangeState()).toEqual({ pendingChanges: 0, lastBackupAt: null });

    await recordBackupChanges(5);
    await recordBackupChanges(BACKUP_REMINDER_THRESHOLD);
    expect(useBackupReminderStore.getState().pendingChanges).toBe(5 + BACKUP_REMINDER_THRESHOLD);

    // Reload from SQLite meta to verify durability.
    resetBackupChangeState();
    const reloaded = await loadBackupChangeState();
    expect(reloaded.pendingChanges).toBe(5 + BACKUP_REMINDER_THRESHOLD);

    await markBackupCompleted(1700000000000);
    expect(useBackupReminderStore.getState()).toMatchObject({
      pendingChanges: 0,
      lastBackupAt: 1700000000000,
    });

    resetBackupChangeState();
    expect(await loadBackupChangeState()).toEqual({
      pendingChanges: 0,
      lastBackupAt: 1700000000000,
    });
  });
});
