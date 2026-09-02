jest.mock('../../database/db', () => ({
  getDatabase: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('../../database/repositories/DupGroupRepository', () => ({
  addAssetToMatchingGroupsInDatabase: jest.fn(),
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
});
