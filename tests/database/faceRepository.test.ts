jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({
  getDatabase: jest.fn(),
  withTransaction: jest.fn(),
}));

import { repairFaceDataInDatabase } from '../../database/repositories/FaceRepository';
import { AssetStatus } from '../../database/schema';
import { TestDatabase } from '../helpers/testDatabase';

describe('face data repair', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = new TestDatabase();
  });

  afterEach(async () => {
    await database.closeAsync();
  });

  it('removes dangling instances and repairs first-seen metadata after an asset disappears', async () => {
    await database.runAsync('INSERT INTO assets (asset_id, status) VALUES (?, ?)', ['a', AssetStatus.DONE]);
    await database.runAsync('INSERT INTO assets (asset_id, status) VALUES (?, ?)', ['b', AssetStatus.DONE]);
    await database.runAsync('INSERT INTO assets (asset_id, status) VALUES (?, ?)', ['pending', AssetStatus.PENDING]);
    await database.runAsync(
      `INSERT INTO face_groups (face_id, first_seen_asset_id, representative_uri, photo_count, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['face-1', 'a', 'file://a.jpg', 99, 1],
    );
    await database.runAsync(
      'INSERT INTO face_instances (instance_id, face_id, asset_id, bounding_box, confidence) VALUES (?, ?, ?, ?, ?)',
      ['instance-a', 'face-1', 'a', '{}', 0.9],
    );
    await database.runAsync(
      'INSERT INTO face_instances (instance_id, face_id, asset_id, bounding_box, confidence) VALUES (?, ?, ?, ?, ?)',
      ['instance-b', 'face-1', 'b', '{}', 0.8],
    );
    await database.runAsync(
      'INSERT INTO face_instances (instance_id, face_id, asset_id, bounding_box, confidence) VALUES (?, ?, ?, ?, ?)',
      ['instance-pending', 'face-1', 'pending', '{}', 0.7],
    );

    await repairFaceDataInDatabase(database as never);

    let group = await database.getFirstAsync<{
      photo_count: number;
      first_seen_asset_id: string | null;
      representative_uri: string | null;
    }>('SELECT photo_count, first_seen_asset_id, representative_uri FROM face_groups WHERE face_id = ?', ['face-1']);
    expect(group).toEqual({ photo_count: 2, first_seen_asset_id: 'a', representative_uri: 'file://a.jpg' });

    await database.runAsync('DELETE FROM face_instances WHERE asset_id = ?', ['a']);
    await repairFaceDataInDatabase(database as never);

    group = await database.getFirstAsync<{
      photo_count: number;
      first_seen_asset_id: string | null;
      representative_uri: string | null;
    }>('SELECT photo_count, first_seen_asset_id, representative_uri FROM face_groups WHERE face_id = ?', ['face-1']);
    expect(group).toEqual({ photo_count: 1, first_seen_asset_id: 'b', representative_uri: null });
  });
});
