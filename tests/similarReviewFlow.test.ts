jest.mock('expo-sqlite', () => ({}));
jest.mock('../database/db', () => ({ getDatabase: jest.fn(), withTransaction: jest.fn() }));
jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetInfoAsync: jest.fn(), getAssetsAsync: jest.fn(), deleteAssetsAsync: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn() }));
import * as MediaLibrary from 'expo-media-library';
import { getDatabase, withTransaction } from '../database/db';
import { AssetRepository } from '../database/repositories/AssetRepository';
import { DupGroupRepository } from '../database/repositories/DupGroupRepository';
import { SimilarReviewRepository as reviews, isSimilarReviewCurrent } from '../database/repositories/SimilarReviewRepository';
import { keepSimilarPhotos, completeSimilarGroup } from '../services/similarReview';
import { flushMediaProgress } from '../services/mediaProgressStorage';
import { acquireRecordOperation } from '../services/recordOperationLock';
import { useMediaStore } from '../stores/useMediaStore';
import { usePrivacyStore } from '../stores/usePrivacyStore';
import { TestDatabase } from './helpers/testDatabase';
import AsyncStorage from '@react-native-async-storage/async-storage';

let db: TestDatabase;
let key: string;
const photo = (id: string) => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg`, filename: `${id}.jpg`,
    creationTime: 100, modificationTime: 100, duration: 0, width: 1200, height: 900 }) as any;
beforeEach(async () => {
    db = new TestDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(db);
    (withTransaction as jest.Mock).mockImplementation(async callback => {
        let result: unknown;
        await db.withTransactionAsync(async () => { result = await callback(db); });
        return result;
    });
    await useMediaStore.persist.rehydrate();
    usePrivacyStore.setState({ failures: {} });
    useMediaStore.setState({ hasHydrated: true, photoProcessedIds: [], videoProcessedIds: ['movie'],
        deleteQueue: [], collectionQueue: [], videoTrashBin: [], pendingDeletionInfo: {}, recentDecisions: [],
        organizingSessions: { photo: null, video: null }, photos: [], videos: [],
        isConfirmingDeletion: false, isConfirmingVideoTrash: false, permissionScope: 'full',
        permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0 });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async id => photo(typeof id === 'string' ? id : id.id));
    jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: ['one', 'two', 'three'].map(photo), hasNextPage: false } as any);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
    for (const id of ['one', 'two', 'three']) await AssetRepository.upsert({ asset_id: id, taken_at: 100,
        width: 1200, height: 900, file_signature: `source-${id}`, phash: 'same', status: 1 });
    await DupGroupRepository.createGroup('group', 'one');
    for (const id of ['one', 'two', 'three']) await DupGroupRepository.addMember('group', id, 0);
    key = (await reviews.getSnapshot('group'))!.key;
});
afterEach(async () => { await flushMediaProgress(); await db.closeAsync(); });

it('keeps, queues only explicit others, confirms, reopens and re-scans without losing the confirmed group', async () => {
    expect(await completeSimilarGroup('group', key, [], () => true)).toBe('incomplete');
    expect(await keepSimilarPhotos('group', key, ['one', 'three'], () => true)).toBe('saved');
    let state = useMediaStore.getState();
    expect(state.photoProcessedIds).toEqual(['one', 'three']);
    expect(state.deleteQueue).toEqual([]);
    expect(state.videoProcessedIds).toEqual(['movie']);
    expect(await completeSimilarGroup('group', key, ['one', 'three'], () => true)).toBe('incomplete');
    state.enqueuePendingDeletion([photo('two')], 'similar');
    expect(await completeSimilarGroup('group', key, ['one', 'three'], () => true)).toBe('saved');
    await db.runAsync("UPDATE dup_members SET group_id = 'rescanned'");
    await db.runAsync("UPDATE dup_groups SET group_id = 'rescanned'");
    const snapshot = (await reviews.getSnapshot('rescanned'))!;
    const review = await reviews.getReview(snapshot);
    state = useMediaStore.getState();
    expect(isSimilarReviewCurrent(review, state.photoProcessedIds, state.deleteQueue.map(asset => asset.id))).toBe(true);
    expect(state.recentDecisions.map(entry => [entry.assetId, entry.action])).toEqual([['two', 'pending'], ['three', 'keep'], ['one', 'keep']]);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('explicit keep removes an existing pending choice, preserves other media and is individually undoable', async () => {
    useMediaStore.getState().enqueuePendingDeletion([photo('one'), photo('two')], 'blur');
    expect(await keepSimilarPhotos('group', key, ['one'], () => true)).toBe('saved');
    let state = useMediaStore.getState();
    expect(state.deleteQueue.map(asset => asset.id)).toEqual(['two']);
    expect(state.pendingDeletionInfo.two.source).toBe('blur');
    expect(state.photoProcessedIds).toEqual(['one', 'two']);
    expect(state.videoProcessedIds).toEqual(['movie']);
    const latest = state.recentDecisions[0];
    expect(latest).toMatchObject({ assetId: 'one', action: 'keep', before: { pending: { source: 'blur' } }, after: { pending: null, processed: true } });
    expect(await state.changeRecentDecision(latest.eventId, 'undo')).toBe('changed');
    state = useMediaStore.getState();
    expect(state.deleteQueue.map(asset => asset.id).sort()).toEqual(['one', 'two']);
    expect(state.pendingDeletionInfo.one.source).toBe('blur');
});

it('never confirms an inaccessible member even when every visible member has a decision', async () => {
    await keepSimilarPhotos('group', key, ['one'], () => true);
    useMediaStore.getState().enqueuePendingDeletion([photo('two'), photo('three')], 'similar');
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async id => {
        if (id === 'three') throw new Error('Unavailable');
        return photo(String(id));
    });
    expect(await completeSimilarGroup('group', key, ['one'], () => true)).toBe('unavailable');
    expect(await reviews.getReview((await reviews.getSnapshot('group'))!)).toBeNull();
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['two', 'three']);
});

it('does not publish confirmation when its DB write fails, retaining saved keep and queue decisions', async () => {
    await keepSimilarPhotos('group', key, ['one'], () => true);
    useMediaStore.getState().enqueuePendingDeletion([photo('two'), photo('three')], 'similar');
    db.setFailurePredicate(sql => sql.includes('INSERT OR REPLACE INTO similar_reviews'));
    expect(await completeSimilarGroup('group', key, ['one'], () => true)).toBe('failed');
    expect(await reviews.getReview((await reviews.getSnapshot('group'))!)).toBeNull();
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['two', 'three']);
});

it('does not confirm when encrypted decision persistence fails', async () => {
    await keepSimilarPhotos('group', key, ['one'], () => true);
    await flushMediaProgress();
    jest.mocked(AsyncStorage.setItem).mockRejectedValue(new Error('Storage failure'));
    useMediaStore.getState().enqueuePendingDeletion([photo('two'), photo('three')], 'similar');
    expect(await completeSimilarGroup('group', key, ['one'], () => true)).toBe('failed');
    expect(await reviews.getReview((await reviews.getSnapshot('group'))!)).toBeNull();
    jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
});

it('rejects an old group or a permission refresh during media reads without making a keep decision', async () => {
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async id => {
        useMediaStore.setState({ permissionRefreshVersion: 1 }); return photo(String(id));
    });
    expect(await keepSimilarPhotos('group', key, ['one'], () => true)).toBe('stale');
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
    expect(await keepSimilarPhotos('group', 'old-key', ['one'], () => true)).toBe('stale');
});

it('rolls back confirmation when decisions change while the SQL write is pending', async () => {
    await keepSimilarPhotos('group', key, ['one'], () => true);
    useMediaStore.getState().enqueuePendingDeletion([photo('two'), photo('three')], 'similar');
    const original = db.runAsync.bind(db);
    jest.spyOn(db, 'runAsync').mockImplementation(async (sql, params) => {
        const result = await original(sql, params);
        if (sql.includes('INSERT OR REPLACE INTO similar_reviews')) useMediaStore.getState().keepPendingDeletion('two');
        return result;
    });
    expect(await completeSimilarGroup('group', key, ['one'], () => true)).toBe('stale');
    expect(await reviews.getReview((await reviews.getSnapshot('group'))!)).toBeNull();
});

it('does not mutate while deletion, backup or the privacy gate owns the records', async () => {
    useMediaStore.setState({ isConfirmingDeletion: true });
    expect(await keepSimilarPhotos('group', key, ['one'], () => true)).toBe('busy');
    expect(useMediaStore.getState().keepPhotosFromSimilar([photo('one')])).toBe(false);
    useMediaStore.setState({ isConfirmingDeletion: false });
    const release = acquireRecordOperation('backup')!;
    try { expect(await keepSimilarPhotos('group', key, ['one'], () => true)).toBe('busy'); }
    finally { release(); }
    usePrivacyStore.getState().block('records', 'read');
    expect(await completeSimilarGroup('group', key, ['one'], () => true)).toBe('busy');
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
});
