jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({
  getDatabase: jest.fn(),
  withTransaction: jest.fn(),
}));

import {
  addAssetToMatchingGroupsInDatabase,
  repairDuplicateGroupsInDatabase,
} from '../../database/repositories/DupGroupRepository';
import { AssetStatus } from '../../database/schema';
import { TestDatabase } from '../helpers/testDatabase';

async function insertAsset(
  database: TestDatabase,
  assetId: string,
  status: number = AssetStatus.DONE,
  quality: { width?: number; height?: number; blurScore?: number; meanLuma?: number } = {},
): Promise<void> {
  await database.runAsync(
    `INSERT INTO assets (asset_id, width, height, blur_score, mean_luma, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      assetId,
      quality.width ?? 1000,
      quality.height ?? 1000,
      quality.blurScore ?? 100,
      quality.meanLuma ?? 140,
      status,
    ],
  );
}

describe('duplicate group repair', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = new TestDatabase();
  });

  afterEach(async () => {
    await database.closeAsync();
  });

  it('removes invalid members and rebuilds a deleted best-shot pointer', async () => {
    await insertAsset(database, 'a', AssetStatus.DONE, { blurScore: 10, meanLuma: 100 });
    await insertAsset(database, 'b', AssetStatus.DONE, { width: 2200, height: 1800, blurScore: 300 });
    await insertAsset(database, 'pending', AssetStatus.PENDING);
    await database.runAsync(
      'INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at) VALUES (?, ?, ?, ?)',
      ['group-1', 'a', 'missing', 1],
    );
    for (const [assetId, distance] of [['a', 0], ['b', 4], ['pending', 2]] as Array<[string, number]>) {
      await database.runAsync(
        'INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)',
        ['group-1', assetId, distance],
      );
    }

    await repairDuplicateGroupsInDatabase(database as never);

    const members = await database.getAllAsync<{ asset_id: string }>(
      'SELECT asset_id FROM dup_members WHERE group_id = ? ORDER BY asset_id',
      ['group-1'],
    );
    const group = await database.getFirstAsync<{ best_asset_id: string | null }>(
      'SELECT best_asset_id FROM dup_groups WHERE group_id = ?',
      ['group-1'],
    );

    expect(members.map(member => member.asset_id)).toEqual(['a', 'b']);
    expect(group?.best_asset_id).toBe('b');
  });

  it('can preserve a singleton as a scoped recovery seed', async () => {
    await insertAsset(database, 'hidden');
    await database.runAsync(
      'INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at) VALUES (?, ?, ?, ?)',
      ['seed-group', 'hidden', 'hidden', 1],
    );
    await database.runAsync(
      'INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)',
      ['seed-group', 'hidden', 0],
    );

    await repairDuplicateGroupsInDatabase(database as never, { removeSingletonGroups: false });
    expect(await database.getFirstAsync('SELECT group_id FROM dup_groups WHERE group_id = ?', ['seed-group'])).not.toBeNull();

    await repairDuplicateGroupsInDatabase(database as never);
    expect(await database.getFirstAsync('SELECT group_id FROM dup_groups WHERE group_id = ?', ['seed-group'])).toBeNull();
  });

  it('merges valid matches into the existing connected group using the closest distance', async () => {
    await insertAsset(database, 'a');
    await insertAsset(database, 'b');
    await insertAsset(database, 'c');
    await database.runAsync(
      'INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at) VALUES (?, ?, ?, ?)',
      ['existing', 'a', 'a', 1],
    );
    await database.runAsync('INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)', ['existing', 'a', 0]);
    await database.runAsync('INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)', ['existing', 'b', 3]);

    const groupId = await addAssetToMatchingGroupsInDatabase(
      database as never,
      'c',
      [{ assetId: 'a', distance: 5 }, { assetId: 'b', distance: 2 }],
      'new-group',
    );

    const members = await database.getAllAsync<{ asset_id: string; distance: number }>(
      'SELECT asset_id, distance FROM dup_members WHERE group_id = ? ORDER BY asset_id',
      ['existing'],
    );

    expect(groupId).toBe('existing');
    expect(members).toEqual([
      { asset_id: 'a', distance: 0 },
      { asset_id: 'b', distance: 2 },
      { asset_id: 'c', distance: 2 },
    ]);
  });
});
