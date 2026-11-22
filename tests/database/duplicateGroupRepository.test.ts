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

  it('paginates actionable duplicate groups and batch-loads members in O(1) SQL queries', async () => {
    const dbModule = require('../../database/db');
    (dbModule.getDatabase as jest.Mock).mockResolvedValue(database);
    (dbModule.withTransaction as jest.Mock).mockImplementation(async (callback: (db: TestDatabase) => Promise<unknown>) => {
      let result: unknown;
      await database.withTransactionAsync(async () => { result = await callback(database); });
      return result;
    });

    for (let g = 1; g <= 5; g++) {
      const gid = `grp-${g}`;
      await insertAsset(database, `${gid}-a`);
      await insertAsset(database, `${gid}-b`);
      await database.runAsync(
        'INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at) VALUES (?, ?, ?, ?)',
        [gid, `${gid}-a`, `${gid}-a`, g * 100],
      );
      await database.runAsync('INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)', [gid, `${gid}-a`, 0]);
      await database.runAsync('INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)', [gid, `${gid}-b`, 2]);
    }
    // Singleton seed group must be excluded from actionable pages.
    await insertAsset(database, 'solo-a');
    await database.runAsync(
      'INSERT INTO dup_groups (group_id, representative_asset_id, best_asset_id, created_at) VALUES (?, ?, ?, ?)',
      ['solo', 'solo-a', 'solo-a', 9999],
    );
    await database.runAsync('INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?, ?, ?)', ['solo', 'solo-a', 0]);

    const { DupGroupRepository } = require('../../database/repositories/DupGroupRepository');
    (dbModule.withTransaction as jest.Mock).mockClear();

    const page1 = await DupGroupRepository.getGroupsPage({ limit: 3, offset: 0, repair: true });
    const page2 = await DupGroupRepository.getGroupsPage({ limit: 3, offset: 3, repair: false });
    expect(page1.map((g: any) => g.group_id)).toEqual(['grp-5', 'grp-4', 'grp-3']);
    expect(page2.map((g: any) => g.group_id)).toEqual(['grp-2', 'grp-1']);
    // Only the initial repair page opens a write transaction.
    expect(dbModule.withTransaction).toHaveBeenCalledTimes(1);

    const getAllSpy = jest.spyOn(database, 'getAllAsync');
    const batched = await DupGroupRepository.getGroupMembersBatch(['grp-5', 'grp-4', 'grp-3', 'missing']);
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(batched.get('grp-5')?.map((m: any) => m.asset_id)).toEqual(['grp-5-a', 'grp-5-b']);
    expect(batched.get('grp-4')?.map((m: any) => m.asset_id)).toEqual(['grp-4-a', 'grp-4-b']);
    expect(batched.get('missing')).toEqual([]);

    // Keyset cursor pagination must not skip or duplicate rows when a newer group is deleted mid-scroll.
    await database.runAsync("DELETE FROM dup_members WHERE group_id = 'grp-5'");
    await database.runAsync("DELETE FROM dup_groups WHERE group_id = 'grp-5'");
    const keysetPage2 = await DupGroupRepository.getGroupsPage({
      limit: 3,
      cursor: { createdAt: page1[2].created_at, groupId: page1[2].group_id },
      repair: false,
    });
    expect(keysetPage2.map((g: any) => g.group_id)).toEqual(['grp-2', 'grp-1']);
  });
});
