jest.mock('expo-sqlite', () => ({}));
jest.mock('../../database/db', () => ({ getDatabase: jest.fn(), withTransaction: jest.fn() }));
import { getDatabase, withTransaction } from '../../database/db';
import { AssetRepository } from '../../database/repositories/AssetRepository';
import { DupGroupRepository } from '../../database/repositories/DupGroupRepository';
import { SimilarReviewRepository as reviews, isSimilarReviewCurrent } from '../../database/repositories/SimilarReviewRepository';
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
async function seedAsset(id: string) {
    await AssetRepository.upsert({ asset_id: id, taken_at: 100, width: 1200, height: 900,
        status: 1, phash: '0123456789abcdef', file_signature: `source-${id}`,
        blur_score: 250, mean_luma: 140, updated_at: 100 });
}
async function seedGroup(id = 'group', members = ['one', 'two']) {
    for (const member of members) await seedAsset(member);
    await DupGroupRepository.createGroup(id, members[0]);
    for (const member of [...members].reverse()) await DupGroupRepository.addMember(id, member, 0);
    await DupGroupRepository.updateBestAsset(id, members[0]);
    return (await reviews.getSnapshot(id))!;
}

it('persists explicit keep/pending decisions and reads them from a freshly loaded snapshot', async () => {
    const snapshot = await seedGroup();
    expect(snapshot.assets.map(asset => asset.asset_id)).toEqual(['one', 'two']);
    expect(await reviews.getReview(snapshot)).toBeNull();
    expect(await reviews.save('group', snapshot.key, ['one'], ['two'])).toBe(true);
    const reloaded = (await reviews.getSnapshot('group'))!;
    expect(await reviews.getReview(reloaded)).toEqual({ keptIds: ['one'], pendingIds: ['two'], reviewedAt: expect.any(Number) });
    expect(reloaded.recommendedAssetId).toBe('one');
});

it('does not depend on a recreated group ID, member order, recommendation or scan time', async () => {
    const snapshot = await seedGroup();
    await reviews.save('group', snapshot.key, ['one', 'two'], []);
    await DupGroupRepository.deleteGroup('group');
    await seedGroup('new-group', ['two', 'one']);
    await db.runAsync('UPDATE assets SET updated_at = 200, blur_score = 100, mean_luma = 80, phash = ?', ['new-derived-hash']);
    const rescanned = (await reviews.getSnapshot('new-group'))!;
    expect(rescanned.key).toBe(snapshot.key);
    expect(await reviews.getReview(rescanned)).toMatchObject({ keptIds: ['one', 'two'], pendingIds: [] });
});

it.each([
    "UPDATE assets SET file_signature = 'edited' WHERE asset_id = 'one'",
    "UPDATE assets SET width = 2400 WHERE asset_id = 'one'",
    "UPDATE assets SET taken_at = 200 WHERE asset_id = 'one'",
    "DELETE FROM dup_members WHERE asset_id = 'one'",
    "UPDATE assets SET status = 0 WHERE asset_id = 'one'",
    "DELETE FROM assets WHERE asset_id = 'one'",
])('refuses a stale confirmation after %s', async sql => {
    const snapshot = await seedGroup();
    await db.runAsync(sql);
    expect(await reviews.save('group', snapshot.key, ['one'], ['two'])).toBe(false);
    expect(await db.getAllAsync('SELECT * FROM similar_reviews')).toEqual([]);
});

it('reopens when a new member joins and never confirms just the accessible subset', async () => {
    const snapshot = await seedGroup();
    await reviews.save('group', snapshot.key, ['one'], ['two']);
    await seedAsset('three');
    await DupGroupRepository.addMember('group', 'three', 1);
    const changed = (await reviews.getSnapshot('group'))!;
    expect(await reviews.getReview(changed)).toBeNull();
    expect(await reviews.save('group', snapshot.key, ['one'], ['two'])).toBe(false);
    expect(await reviews.save('group', changed.key, ['one'], ['two'])).toBe(false);
    expect(await reviews.save('group', changed.key, ['one'], ['two', 'three'])).toBe(true);
});

it.each([
    [[], ['one', 'two']], // Cannot delete the whole group without an explicit keep.
    [['one'], []],
    [['one'], ['one']],
    [['one', 'one'], ['two']],
    [['one'], ['unknown']],
])('rejects missing, overlapping, duplicated or foreign decisions: %j / %j', async (kept, pending) => {
    const snapshot = await seedGroup();
    expect(await reviews.save('group', snapshot.key, kept, pending)).toBe(false);
    expect(await db.getAllAsync('SELECT * FROM similar_reviews')).toEqual([]);
});

it('uses a hash fallback only where source signatures are missing', async () => {
    await seedGroup();
    await db.runAsync("UPDATE assets SET file_signature = NULL WHERE asset_id = 'one'");
    const before = (await reviews.getSnapshot('group'))!;
    await reviews.save('group', before.key, ['one', 'two'], []);
    await db.runAsync("UPDATE assets SET phash = 'changed' WHERE asset_id = 'one'");
    expect(await reviews.getReview((await reviews.getSnapshot('group'))!)).toBeNull();
});

it('does not invent a recommendation when the best pointer is unavailable', async () => {
    await seedGroup();
    await db.runAsync("UPDATE dup_groups SET best_asset_id = 'missing'");
    expect((await reviews.getSnapshot('group'))?.recommendedAssetId).toBeNull();
});

it('does not label a group handled after its underlying decisions change or are undone', () => {
    const review = { keptIds: ['one'], pendingIds: ['two'], reviewedAt: 100 };
    expect(isSimilarReviewCurrent(review, ['one', 'two'], ['two'])).toBe(true);
    expect(isSimilarReviewCurrent(review, ['one'], ['two'])).toBe(false);
    expect(isSimilarReviewCurrent(review, ['one', 'two'], [])).toBe(false);
    expect(isSimilarReviewCurrent(review, ['one', 'two'], ['one', 'two'])).toBe(false);
    expect(isSimilarReviewCurrent(null, ['one', 'two'], ['two'])).toBe(false);
});

it('rolls back a failed write instead of losing the previously confirmed decisions', async () => {
    const snapshot = await seedGroup();
    await reviews.save('group', snapshot.key, ['one', 'two'], []);
    const before = await reviews.getReview(snapshot);
    db.setFailurePredicate(sql => sql.includes('INSERT OR REPLACE INTO similar_reviews'));
    await expect(reviews.save('group', snapshot.key, ['one'], ['two'])).rejects.toThrow();
    expect(await reviews.getReview(snapshot)).toEqual(before);
});

it('drops only reviews referencing physically removed media and rolls back cleanup failures', async () => {
    const first = await seedGroup();
    await reviews.save('group', first.key, ['one'], ['two']);
    const second = await seedGroup('other', ['three', 'four']);
    await reviews.save('other', second.key, ['three', 'four'], []);
    db.setFailurePredicate(sql => sql.includes('DELETE FROM assets'));
    await expect(AssetRepository.removeAssetAndDerivedData('two')).rejects.toThrow();
    expect(await reviews.getReview(first)).not.toBeNull();
    db.setFailurePredicate(null);
    await AssetRepository.removeAssetAndDerivedData('two');
    expect(await reviews.getReview(first)).toBeNull();
    expect(await reviews.getReview(second)).not.toBeNull();
});

it('clears similar_reviews records alongside derived analysis during a full scan reset', async () => {
    const snapshot = await seedGroup();
    await reviews.save('group', snapshot.key, ['one', 'two'], []);
    await AssetRepository.resetAll();
    expect(await reviews.getSnapshot('group')).toBeNull();
    expect(await reviews.getReview(snapshot)).toBeNull();
    expect(await db.getAllAsync('SELECT * FROM similar_reviews')).toEqual([]);
});

it('drops similar_reviews referencing assets removed by removeMissingAssets while preserving intact groups', async () => {
    const first = await seedGroup('group-gone', ['one', 'two']);
    await reviews.save('group-gone', first.key, ['one'], ['two']);
    const second = await seedGroup('group-intact', ['three', 'four']);
    await reviews.save('group-intact', second.key, ['three', 'four'], []);

    const removed = await AssetRepository.removeMissingAssets(new Set(['one', 'three', 'four']));
    expect(removed).toEqual(['two']);
    expect(await reviews.getReview(first)).toBeNull();
    expect(await reviews.getReview(second)).toMatchObject({ keptIds: ['four', 'three'], pendingIds: [] });
});

it('reports malformed review JSON without disclosing its contents', async () => {
    const snapshot = await seedGroup();
    await reviews.save('group', snapshot.key, ['one'], ['two']);
    await db.runAsync('UPDATE similar_reviews SET kept_ids_json = ?', ['private-media-fragment{']);
    await expect(reviews.getReview(snapshot)).rejects.toThrow(/^Similar review record is invalid$/);
});

it('upgrades V4 without touching existing data, and rejects future schemas', async () => {
    await seedGroup();
    const before = await db.getAllAsync('SELECT * FROM assets ORDER BY asset_id');
    await db.execAsync('DROP TABLE similar_reviews');
    await db.runAsync("INSERT INTO meta (key, value) VALUES ('schema_version', '4')");
    await runMigrations(db as any);
    expect(await db.getFirstAsync('SELECT value FROM meta WHERE key = ?', ['schema_version'])).toEqual({ value: '7' });
    expect(await db.getAllAsync('SELECT * FROM assets ORDER BY asset_id')).toEqual(before);
    await runMigrations(db as any);
    expect(await db.getAllAsync('SELECT * FROM similar_reviews')).toEqual([]);
    await db.runAsync("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
    await expect(runMigrations(db as any)).rejects.toThrow('newer than supported');
});

it('does not advance the migration version when its commit cannot be recorded', async () => {
    await db.execAsync('DROP TABLE similar_reviews');
    await db.runAsync("INSERT INTO meta (key, value) VALUES ('schema_version', '4')");
    db.setFailurePredicate(sql => sql.includes('INSERT OR REPLACE INTO meta'));
    await expect(runMigrations(db as any)).rejects.toThrow();
    expect(await db.getFirstAsync("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: '4' });
    expect(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name = 'similar_reviews'")).toBeNull();
    db.setFailurePredicate(null);
    await runMigrations(db as any);
    expect(await db.getFirstAsync("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: '7' });
});

it('batch-loads snapshots and reviews for multiple groups in O(1) SQL queries', async () => {
    const first = await seedGroup('grp-1', ['a1', 'a2']);
    const second = await seedGroup('grp-2', ['b1', 'b2', 'b3']);
    await reviews.save('grp-1', first.key, ['a1'], ['a2']);
    await reviews.save('grp-2', second.key, ['b1', 'b2'], ['b3']);

    const querySpy = jest.spyOn(db, 'getAllAsync');
    const snapshots = await reviews.getSnapshotsBatch(['grp-1', 'grp-2', 'missing']);
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(snapshots.size).toBe(2);
    expect(snapshots.get('grp-1')?.key).toBe(first.key);
    expect(snapshots.get('grp-2')?.key).toBe(second.key);

    querySpy.mockClear();
    const reviewMap = await reviews.getReviewsBatch(Array.from(snapshots.values()));
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(reviewMap.get(first.key)).toMatchObject({ keptIds: ['a1'], pendingIds: ['a2'] });
    expect(reviewMap.get(second.key)).toMatchObject({ keptIds: ['b1', 'b2'], pendingIds: ['b3'] });
});
