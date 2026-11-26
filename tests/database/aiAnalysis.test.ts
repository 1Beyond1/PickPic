jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({ getDatabase: jest.fn(), withTransaction: jest.fn() }));
import { getDatabase, withTransaction } from '../../database/db';
import { AIAnalysisRepository as ai } from '../../database/repositories/AIAnalysisRepository';
import { AssetRepository } from '../../database/repositories/AssetRepository';
import { GLOBAL_ALGO_VERSION } from '../../database/schema';
import { runMigrations } from '../../database/migrations';
import { TestDatabase } from '../helpers/testDatabase';

let db: TestDatabase;
beforeEach(() => {
  db = new TestDatabase();
  (getDatabase as jest.Mock).mockResolvedValue(db);
  (withTransaction as jest.Mock).mockImplementation(async callback => {
    let result: unknown;
    await db.withTransactionAsync(async () => { result = await callback(db); });
    return result;
  });
});
afterEach(() => db.closeAsync());
async function seed(id = 'one') {
  await AssetRepository.upsert({ asset_id: id, taken_at: 100, width: 100, height: 100,
    status: 1, algo_version: GLOBAL_ALGO_VERSION, blur_score: 150, mean_luma: 120,
    phash: '0123456789abcdef', file_signature: 'original', updated_at: 100 });
  return (await AssetRepository.getById(id))!;
}
it('commits an empty classification as done, preserving base results on success and failure', async () => {
  const source = await seed();
  expect(await ai.save(source, { labelsJson: '[]', faceCount: 0 })).toBe(true);
  expect(await ai.getCounts()).toEqual({ done: 1, pending: 0, error: 0 });
  expect(await ai.getCandidates()).toEqual([]);
  expect(await ai.save(source, null)).toBe(true);
  expect(await ai.getCounts()).toEqual({ done: 0, pending: 0, error: 1 });
  expect(await AssetRepository.getById('one')).toMatchObject({ ...source, labels_json: '[]', face_count: 0 });
});
it.each([
  'UPDATE assets SET updated_at = 200',
  "UPDATE assets SET file_signature = 'edited'",
  'UPDATE assets SET status = 0',
  'DELETE FROM assets',
])('rejects stale inference after %s', async sql => {
  const source = await seed();
  await db.runAsync(sql);
  expect(await ai.save(source, { labelsJson: '[{"text":"Cat"}]', faceCount: 1 })).toBe(false);
  expect(await db.getAllAsync('SELECT * FROM ai_analysis')).toEqual([]);
});
it('rolls back label publication if recording completion fails', async () => {
  const source = await seed();
  db.setFailurePredicate(sql => sql.includes('INSERT OR REPLACE INTO ai_analysis'));
  await expect(ai.save(source, { labelsJson: '[]', faceCount: 0 })).rejects.toThrow();
  expect(await AssetRepository.getById('one')).toEqual(source);
});
it('respects an empty or restricted scope and retries only failures', async () => {
  await ai.save(await seed('failed'), null);
  await ai.save(await seed('done'), { labelsJson: '[]', faceCount: 0 });
  await seed('pending');
  expect(await ai.getCandidates([], false)).toEqual([]);
  expect(await ai.getCandidates(undefined, true)).toEqual(['failed']);
  expect(await ai.getCandidates(['pending', 'done', 'pending'])).toEqual(['pending']);
  await AssetRepository.resetAll();
  expect(await db.getAllAsync('SELECT * FROM ai_analysis')).toEqual([]);
});
it('migrates valid legacy arrays including empty results without touching base analysis', async () => {
  for (const [id, labels] of [['empty', '[]'], ['labels', '[{"text":"Cat"}]'], ['bad', '{'], ['object', '{}']]) {
    await seed(id);
    await db.runAsync('UPDATE assets SET labels_json = ? WHERE asset_id = ?', [labels, id]);
  }
  await seed('missing');
  const before = await db.getAllAsync('SELECT * FROM assets ORDER BY asset_id');
  await db.runAsync("INSERT INTO meta (key,value) VALUES ('schema_version','3')");
  await db.execAsync('DROP TABLE ai_analysis');
  await runMigrations(db as any);
  expect(await ai.getCounts()).toEqual({ done: 2, pending: 3, error: 0 });
  expect(await db.getAllAsync('SELECT * FROM assets ORDER BY asset_id')).toEqual(before);
  await runMigrations(db as any);
  expect(await ai.getCounts()).toEqual({ done: 2, pending: 3, error: 0 });
});
