jest.mock('../../database/db', () => ({
  getDatabase: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('../../database/repositories/DupGroupRepository', () => ({
  addAssetToMatchingGroupsInDatabase: jest.fn(),
  removeAssetsFromGroupsInDatabase: jest.fn().mockResolvedValue(undefined),
  repairDuplicateGroupsInDatabase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../database/repositories/FaceRepository', () => ({
  removeFaceInstancesInDatabase: jest.fn().mockResolvedValue(0),
  repairFaceDataInDatabase: jest.fn().mockResolvedValue(undefined),
}));

import { AssetRepository } from '../../database/repositories/AssetRepository';
import { getDatabase, withTransaction } from '../../database/db';
import { AssetStatus } from '../../database/schema';
import { TestDatabase } from '../helpers/testDatabase';

describe('AssetRepository', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = new TestDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(database);
    (withTransaction as jest.Mock).mockImplementation(async (callback) => callback(database));
  });

  afterEach(async () => {
    await database.closeAsync();
  });

  it('preserves omitted fields but honors explicit null for nullable fields', async () => {
    await AssetRepository.upsert({
      asset_id: 'asset-1',
      taken_at: 100,
      width: 4000,
      height: 3000,
      file_signature: 'signature-1',
      algo_version: 4,
      blur_score: 250,
      mean_luma: 140,
      phash: 'phash-1',
      face_count: 3,
      labels_json: '["landscape"]',
      status: AssetStatus.DONE,
      error_message: 'stale error',
    });

    await AssetRepository.upsert({
      asset_id: 'asset-1',
      width: 4200,
    });

    let row = await database.getFirstAsync<{
      width: number;
      height: number;
      face_count: number | null;
      labels_json: string | null;
      error_message: string | null;
      status: number;
    }>('SELECT width, height, face_count, labels_json, error_message, status FROM assets WHERE asset_id = ?', ['asset-1']);

    expect(row).toMatchObject({
      width: 4200,
      height: 3000,
      face_count: 3,
      labels_json: '["landscape"]',
      error_message: 'stale error',
      status: AssetStatus.DONE,
    });

    await AssetRepository.upsert({
      asset_id: 'asset-1',
      face_count: null,
      labels_json: null,
      error_message: null,
      blur_score: null,
    });

    const clearedRow = await database.getFirstAsync<{
      blur_score: number | null;
      face_count: number | null;
      labels_json: string | null;
      error_message: string | null;
    }>('SELECT blur_score, face_count, labels_json, error_message FROM assets WHERE asset_id = ?', ['asset-1']);

    expect(clearedRow).toEqual({
      blur_score: null,
      face_count: null,
      labels_json: null,
      error_message: null,
    });
  });

  it('keeps cursor pagination stable for equal timestamps', async () => {
    for (const [assetId, takenAt] of [['a', 100], ['b', 100], ['c', 200]] as const) {
      await database.runAsync(
        'INSERT INTO assets (asset_id, taken_at, status) VALUES (?, ?, ?)',
        [assetId, takenAt, AssetStatus.PENDING],
      );
    }

    const nextBatch = await AssetRepository.getPendingBatch(100, 'a', 10);

    expect(nextBatch.map(asset => asset.asset_id)).toEqual(['b', 'c']);
    await expect(AssetRepository.hasPendingAtOrBeforeCursor(100, 'b')).resolves.toBe(true);
  });

  it('does not let a scoped candidate query include assets outside its scope', async () => {
    await database.runAsync(
      'INSERT INTO assets (asset_id, taken_at, status) VALUES (?, ?, ?)',
      ['inside', 100, AssetStatus.PENDING],
    );
    await database.runAsync(
      'INSERT INTO assets (asset_id, taken_at, status) VALUES (?, ?, ?)',
      ['outside', 200, AssetStatus.PENDING],
    );

    const candidates = await AssetRepository.getScanCandidateBatch(4, 20, ['inside']);

    expect(candidates.map(asset => asset.asset_id)).toEqual(['inside']);
  });

  it('batch-reads assets by ID across SQLite-safe chunks without opening transactions', async () => {
    await expect(AssetRepository.getByIds([])).resolves.toEqual(new Map());

    const ids: string[] = [];
    for (let i = 0; i < 450; i++) {
      const id = `chunk-asset-${i}`;
      ids.push(id);
      await database.runAsync(
        'INSERT INTO assets (asset_id, taken_at, width, height, file_signature, status) VALUES (?, ?, ?, ?, ?, ?)',
        [id, 1000 + i, 1200, 900, `1700000000_${1000 + i}`, AssetStatus.DONE],
      );
    }

    (withTransaction as jest.Mock).mockClear();
    const getAllSpy = jest.spyOn(database, 'getAllAsync');

    const map = await AssetRepository.getByIds([...ids, 'chunk-asset-0', 'missing-id']);

    expect(withTransaction).not.toHaveBeenCalled();
    expect(getAllSpy).toHaveBeenCalledTimes(2);
    expect(map.size).toBe(450);
    expect(map.get('chunk-asset-0')?.file_signature).toBe('1700000000_1000');
    expect(map.get('chunk-asset-449')?.taken_at).toBe(1449);
    expect(map.has('missing-id')).toBe(false);
  });

  it('upserts multiple assets in a single transaction while preserving omitted vs null semantics', async () => {
    (withTransaction as jest.Mock).mockClear();
    await AssetRepository.upsertBatch([]);
    expect(withTransaction).not.toHaveBeenCalled();

    await AssetRepository.upsertBatch([
      {
        asset_id: 'batch-1',
        taken_at: 100,
        width: 1000,
        height: 800,
        file_signature: 'sig-1',
        status: AssetStatus.DONE,
        labels_json: '["cat"]',
      },
      {
        asset_id: 'batch-2',
        taken_at: 200,
        width: 1200,
        height: 900,
        file_signature: 'sig-2',
        status: AssetStatus.PENDING,
      },
    ]);

    expect(withTransaction).toHaveBeenCalledTimes(1);

    await AssetRepository.upsertBatch([
      { asset_id: 'batch-1', width: 1024, labels_json: null },
    ]);

    expect(withTransaction).toHaveBeenCalledTimes(2);
    expect(await AssetRepository.getById('batch-1')).toMatchObject({
      width: 1024,
      height: 800,
      status: AssetStatus.DONE,
      labels_json: null,
    });
    expect(await AssetRepository.getById('batch-2')).toMatchObject({
      taken_at: 200,
      status: AssetStatus.PENDING,
    });
  });

  it('paginates blurry assets deterministically across full and >500-ID scoped queries', async () => {
    const seeded = Array.from({ length: 65 }, (_, index) => ({
      asset_id: `blur-${String(index).padStart(3, '0')}`,
      taken_at: 1000 + index,
      width: 1000,
      height: 800,
      blur_score: index + 1,
      mean_luma: 90,
      status: AssetStatus.DONE,
    }));
    await AssetRepository.upsertBatch(seeded);

    const page1 = await AssetRepository.getBlurryAssets(undefined, 25, 0);
    const page2 = await AssetRepository.getBlurryAssets(undefined, 25, 25);
    const page3 = await AssetRepository.getBlurryAssets(undefined, 25, 50);

    expect(page1).toHaveLength(25);
    expect(page2).toHaveLength(25);
    expect(page3).toHaveLength(15);
    expect([...page1, ...page2, ...page3].map(item => item.asset_id)).toEqual(
      seeded.map(item => item.asset_id),
    );

    // Multi-chunk limited scope (>500 IDs) must still return exact global page slices.
    const wideScope = [
      ...Array.from({ length: 510 }, (_, idx) => `missing-${idx}`),
      ...seeded.map(item => item.asset_id),
    ];
    const scopedPage2 = await AssetRepository.getBlurryAssets(wideScope, 10, 50);
    expect(scopedPage2.map(item => item.asset_id)).toEqual(
      seeded.slice(50, 60).map(item => item.asset_id),
    );
  });
});
