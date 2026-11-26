jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({
  getDatabase: jest.fn(),
  withTransaction: jest.fn(),
}));

import { AssetRepository } from '../../database/repositories/AssetRepository';
import { getDatabase, withTransaction } from '../../database/db';
import { AssetStatus } from '../../database/schema';
import { TestDatabase } from '../helpers/testDatabase';

describe('AssetRepository scan-result transaction', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = new TestDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(database);
    (withTransaction as jest.Mock).mockImplementation(async (callback) => {
      await database.execAsync('BEGIN TRANSACTION;');
      try {
        const result = await callback(database);
        await database.execAsync('COMMIT;');
        return result;
      } catch (error) {
        await database.execAsync('ROLLBACK;');
        throw error;
      }
    });
  });

  afterEach(async () => {
    await database.closeAsync();
  });

  async function insertAsset(assetId: string, status: number): Promise<void> {
    await database.runAsync(
      `INSERT INTO assets (
         asset_id, width, height, blur_score, mean_luma, status
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [assetId, 1000, 1000, 100, 140, status],
    );
  }

  it('publishes the DONE asset and duplicate membership together', async () => {
    await insertAsset('target', AssetStatus.PENDING);
    await insertAsset('base', AssetStatus.DONE);

    const groupId = await AssetRepository.markDoneWithDuplicateGroups(
      'target',
      250,
      140,
      'target-phash',
      4,
      0,
      null,
      [{ assetId: 'base', distance: 3 }],
      'new-group',
    );

    const target = await database.getFirstAsync<{ status: number }>(
      'SELECT status FROM assets WHERE asset_id = ?',
      ['target'],
    );
    const members = await database.getAllAsync<{ asset_id: string }>(
      'SELECT asset_id FROM dup_members WHERE group_id = ? ORDER BY asset_id',
      [groupId],
    );

    expect(groupId).toBe('new-group');
    expect(target?.status).toBe(AssetStatus.DONE);
    expect(members.map(member => member.asset_id)).toEqual(['base', 'target']);
  });

  it('rolls back the asset result when duplicate publication fails', async () => {
    await insertAsset('target', AssetStatus.PENDING);
    await insertAsset('base', AssetStatus.DONE);
    database.setFailurePredicate(sql => /INSERT INTO dup_groups/.test(sql));

    await expect(AssetRepository.markDoneWithDuplicateGroups(
      'target',
      250,
      140,
      'target-phash',
      4,
      0,
      null,
      [{ assetId: 'base', distance: 3 }],
      'new-group',
    )).rejects.toThrow('Injected test database failure');

    database.setFailurePredicate(null);
    const target = await database.getFirstAsync<{ status: number; phash: string | null }>(
      'SELECT status, phash FROM assets WHERE asset_id = ?',
      ['target'],
    );
    const groups = await database.getAllAsync('SELECT group_id FROM dup_groups');
    const members = await database.getAllAsync('SELECT group_id FROM dup_members');

    expect(target).toEqual({ status: AssetStatus.PENDING, phash: null });
    expect(groups).toEqual([]);
    expect(members).toEqual([]);
  });

  it('syncs inserts, unchanged skips, metadata updates, and derived invalidations in one transaction', async () => {
    await database.runAsync(
      `INSERT INTO assets (
         asset_id, taken_at, width, height, file_signature, algo_version,
         blur_score, mean_luma, phash, face_count, labels_json, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['unchanged', 100, 1000, 800, '1700000000_2048', 4, 220, 130, 'hash-u', 1, '["cat"]', AssetStatus.DONE, 555],
    );
    await database.runAsync(
      `INSERT INTO assets (
         asset_id, taken_at, width, height, file_signature, algo_version,
         blur_score, mean_luma, phash, face_count, labels_json, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['dims-only', 200, 1000, 800, '1700000000_4096', 4, 210, 125, 'hash-d', 0, '[]', AssetStatus.DONE, 555],
    );
    await database.runAsync(
      `INSERT INTO assets (
         asset_id, taken_at, width, height, file_signature, algo_version,
         blur_score, mean_luma, phash, face_count, labels_json, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['edited', 300, 1000, 800, '1700000000_8192', 4, 200, 120, 'hash-e', 1, '["dog"]', AssetStatus.DONE, 555],
    );
    await database.runAsync(
      `INSERT INTO assets (
         asset_id, taken_at, width, height, file_signature, algo_version,
         blur_score, mean_luma, phash, face_count, labels_json, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['peer', 301, 1000, 800, '1700000000_8193', 4, 205, 122, 'hash-p', 0, '[]', AssetStatus.DONE, 555],
    );
    await database.runAsync(
      'INSERT INTO ai_analysis (asset_id, version, status, source_updated_at, source_signature, source_phash, updated_at) VALUES (?, 1, 1, 555, ?, ?, 555)',
      ['edited', '1700000000_8192', 'hash-e'],
    );
    await database.runAsync(
      'INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at) VALUES (?, ?, ?, ?)',
      ['grp-1', 'edited', 'edited', 555],
    );
    await database.runAsync('INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)', ['grp-1', 'edited', 0]);
    await database.runAsync('INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)', ['grp-1', 'peer', 2]);
    await database.runAsync(
      'INSERT INTO face_groups (face_id, cluster_id, first_seen_asset_id, representative_uri, photo_count, created_at) VALUES (?, 1, ?, ?, 1, 555)',
      ['face-1', 'edited', 'file:///edited.jpg'],
    );
    await database.runAsync(
      'INSERT INTO face_instances (instance_id, face_id, asset_id, bounding_box, confidence) VALUES (?, ?, ?, ?, ?)',
      ['inst-1', 'face-1', 'edited', '{}', 0.9],
    );

    (withTransaction as jest.Mock).mockClear();

    expect(await AssetRepository.syncLibraryMetadataBatch([])).toEqual({
      insertedCount: 0,
      updatedCount: 0,
      invalidatedAssetIds: [],
      shouldResetCursor: false,
    });
    expect(withTransaction).not.toHaveBeenCalled();

    const result = await AssetRepository.syncLibraryMetadataBatch([
      { assetId: 'new-photo', takenAt: 50, width: 1600, height: 1200, fileSignature: '1700000001_5000' },
      { assetId: 'unchanged', takenAt: 100, width: 1000, height: 800, fileSignature: '1700000000_2048' },
      { assetId: 'dims-only', takenAt: 200, width: 1024, height: 768, fileSignature: '1700000000_4096' },
      { assetId: 'edited', takenAt: 300, width: 1000, height: 800, fileSignature: '1700000099_9999' },
    ]);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      insertedCount: 1,
      updatedCount: 2,
      invalidatedAssetIds: ['edited'],
      shouldResetCursor: true,
    });

    expect(await AssetRepository.getById('new-photo')).toMatchObject({
      taken_at: 50,
      width: 1600,
      height: 1200,
      file_signature: '1700000001_5000',
      status: AssetStatus.PENDING,
    });
    expect(await AssetRepository.getById('unchanged')).toMatchObject({
      status: AssetStatus.DONE,
      updated_at: 555,
      labels_json: '["cat"]',
    });
    expect(await AssetRepository.getById('dims-only')).toMatchObject({
      width: 1024,
      height: 768,
      status: AssetStatus.DONE,
      phash: 'hash-d',
    });
    expect(await AssetRepository.getById('edited')).toMatchObject({
      file_signature: '1700000099_9999',
      status: AssetStatus.PENDING,
      algo_version: null,
      blur_score: null,
      phash: null,
      labels_json: null,
      face_count: 0,
    });
    expect(await database.getAllAsync('SELECT * FROM ai_analysis WHERE asset_id = ?', ['edited'])).toEqual([]);
    expect(await database.getAllAsync('SELECT * FROM face_instances WHERE asset_id = ?', ['edited'])).toEqual([]);
    expect(await database.getAllAsync('SELECT * FROM face_groups')).toEqual([]);
    expect(await database.getAllAsync('SELECT * FROM dup_members')).toEqual([]);
    expect(await database.getAllAsync('SELECT * FROM dup_groups')).toEqual([]);
  });

  it('rolls back the entire metadata sync batch when group cleanup fails', async () => {
    await insertAsset('edited', AssetStatus.DONE);
    await database.runAsync('UPDATE assets SET taken_at = 100, file_signature = ? WHERE asset_id = ?', ['sig-old', 'edited']);
    await database.runAsync(
      'INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at) VALUES (?, ?, ?, ?)',
      ['grp-rollback', 'edited', 'edited', 1],
    );
    await database.runAsync('INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)', ['grp-rollback', 'edited', 0]);

    database.setFailurePredicate(sql => /DELETE FROM dup_members/.test(sql));

    await expect(AssetRepository.syncLibraryMetadataBatch([
      { assetId: 'brand-new', takenAt: 50, width: 800, height: 600, fileSignature: 'sig-new' },
      { assetId: 'edited', takenAt: 100, width: 1000, height: 1000, fileSignature: 'sig-updated' },
    ])).rejects.toThrow('Injected test database failure');

    database.setFailurePredicate(null);
    expect(await AssetRepository.getById('brand-new')).toBeNull();
    expect(await AssetRepository.getById('edited')).toMatchObject({
      status: AssetStatus.DONE,
      file_signature: 'sig-old',
    });
  });
});
