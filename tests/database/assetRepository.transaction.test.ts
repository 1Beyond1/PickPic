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
});
