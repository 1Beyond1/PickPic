jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn() }));
import { TextEncoder } from 'node:util';
import type { Asset } from 'expo-media-library';
import {
    BackupPayload,
    BackupPayloadV1,
    BackupPayloadV2,
    buildContentFingerprint,
    mediaFingerprint,
    parseBackupPayload,
    planRestore,
    RecordSnapshot,
} from '../../services/backup/payload';
Object.assign(globalThis, { TextEncoder });
const asset = (id: string, kind = 'photo', overrides: Partial<Asset> = {}) => ({ id, filename: `${id}.jpg`, uri: `file:///current/${id}`, mediaType: kind,
    width: 100, height: 100, creationTime: 100, modificationTime: 200, duration: 0, ...overrides } as Asset);
const blank = (): RecordSnapshot => ({ photoProcessedIds: [], videoProcessedIds: [], deleteQueue: [], collectionQueue: [], videoTrashBin: [] });
const record = (id: string, decision: 'keep' | 'delete' | 'collect', kind: 'photo' | 'video' = 'photo') => ({ id, kind, decision, fingerprint: mediaFingerprint(asset(id, kind)) });
const file = (records: BackupPayloadV1['records']): BackupPayloadV1 => ({ version: 1, platform: 'android', records });

it('restores v1 decisions using current assets and keeps current choices (100% v1 backward compatibility)', () => {
    const current = blank(); current.photoProcessedIds = ['already-kept'];
    const payload = file([record('keep', 'keep'), record('collect', 'collect'), record('delete', 'delete'), record('already-kept', 'delete')]);
    const visible = new Map(payload.records.map(row => [`photo:${row.id}`, asset(row.id)]));
    const { merged, preview } = planRestore(payload, current, visible, true);
    expect(merged.photoProcessedIds).toEqual(['already-kept', 'keep', 'collect', 'delete']);
    expect(merged.deleteQueue.map(row => row.id)).toEqual(['delete']);
    expect(merged.collectionQueue[0].uri).toBe('file:///current/collect');
    expect(preview).toEqual({
        kept: 1, collected: 1, pendingDeletion: 1, existing: 1, skipped: 0,
        rebound: 0, ambiguousSkipped: 0, protectedAlbums: 0, reviewIgnores: 0,
    });
    expect(current.photoProcessedIds).toEqual(['already-kept']);
});
it('does not silently mark excluded pending deletions as processed', () => {
    const payload = file([record('photo', 'delete'), record('video', 'delete', 'video')]);
    const visible = new Map([['photo:photo', asset('photo')], ['video:video', asset('video', 'video')]]);
    expect(planRestore(payload, blank(), visible, false).merged).toEqual(blank());
    const applied = planRestore(payload, blank(), visible, true).merged;
    expect(applied.photoProcessedIds).toEqual(['photo']); expect(applied.videoProcessedIds).toEqual(['video']);
});
it('skips invisible, edited and reused IDs without guessing a match', () => {
    const payload = file([record('missing', 'keep'), record('edited', 'delete'), record('reused', 'keep')]);
    const visible = new Map([['photo:edited', { ...asset('edited'), modificationTime: 300 }], ['photo:reused', { ...asset('reused'), filename: 'different.jpg' }]]);
    const result = planRestore(payload, blank(), visible, true);
    expect(result.merged).toEqual(blank()); expect(result.preview.skipped).toBe(3);
});
it.each([
    { version: 2, platform: 'android', records: [] },
    { version: 3, platform: 'android', records: [], protectedAlbums: [], reviewIgnores: [] },
    { version: 1, platform: 'ios', records: [] },
    { version: 1, platform: 'android', records: [], uri: 'file:///secret' },
    file([record('a', 'keep'), record('a', 'delete')]),
    file([{ ...record('a', 'keep'), fingerprint: 'invalid' }]),
    file([{ ...record('a', 'keep'), decision: 'erase-now' } as any]),
])('rejects incompatible or malformed payloads', value => {
    expect(() => parseBackupPayload(value, 'android')).toThrow();
});

describe('Backup v2 cross-device content fingerprint rebinding and metadata restore', () => {
    it('rebinds a missing assetId across devices when contentFingerprint uniquely matches within creationTime tolerance', () => {
        const sourcePhoto = asset('old-device-1', 'photo', {
            filename: 'IMG_20260101.jpg', width: 4000, height: 3000, creationTime: 1700000000000,
        });
        const sourceVideo = asset('old-device-vid', 'video', {
            filename: 'VID_001.mp4', width: 1920, height: 1080, creationTime: 1700000050000, duration: 15.2,
        });
        const v2: BackupPayloadV2 = {
            version: 2,
            platform: 'ios',
            records: [
                {
                    id: sourcePhoto.id,
                    kind: 'photo',
                    decision: 'keep',
                    fingerprint: mediaFingerprint(sourcePhoto),
                    contentFingerprint: buildContentFingerprint(sourcePhoto, 2450123),
                },
                {
                    id: sourceVideo.id,
                    kind: 'video',
                    decision: 'delete',
                    fingerprint: mediaFingerprint(sourceVideo),
                    contentFingerprint: buildContentFingerprint(sourceVideo, 9876543),
                },
            ],
            protectedAlbums: [
                { albumId: 'ios-alb-1', title: 'Documents', createdAt: 100 },
                { albumId: 'ios-alb-dup', title: 'Shared', createdAt: 101 },
            ],
            reviewIgnores: [
                { ignoreType: 'similar_group', targetKey: 'snap-stable-hash', createdAt: 200 },
                {
                    ignoreType: 'blur',
                    targetKey: sourcePhoto.id,
                    createdAt: 201,
                    contentFingerprint: buildContentFingerprint(sourcePhoto, 2450123),
                },
            ],
        };

        // Cross-platform v2 payload passes schema validation on Android.
        expect(parseBackupPayload(v2, 'android')).toEqual(v2);

        const localPhoto = asset('android-999', 'photo', {
            filename: 'IMG_20260101.jpg', width: 4000, height: 3000, creationTime: 1700000001200, // +1.2s within 2s tolerance
        });
        const localVideo = asset('android-888', 'video', {
            filename: 'VID_001.mp4', width: 1920, height: 1080, creationTime: 1700000049000, duration: 15.2,
        });
        const visible = new Map<string, Asset>([
            ['photo:android-999', localPhoto],
            ['video:android-888', localVideo],
        ]);
        const localSizes = new Map<string, number | null>([
            ['photo:android-999', 2450123],
            ['video:android-888', 9876543],
        ]);

        const plan = planRestore(v2, blank(), visible, true, {
            localSizes,
            localAlbums: [
                { id: 'android-alb-docs', title: 'Documents' },
                { id: 'android-alb-shared-1', title: 'Shared' },
                { id: 'android-alb-shared-2', title: 'Shared' }, // Ambiguous title -> must skip!
            ],
        });

        expect(plan.merged.photoProcessedIds).toEqual(['android-999']);
        expect(plan.merged.videoProcessedIds).toEqual(['android-888']);
        expect(plan.merged.videoTrashBin.map(v => v.id)).toEqual(['android-888']);
        expect(plan.preview).toEqual({
            kept: 1,
            collected: 0,
            pendingDeletion: 1,
            skipped: 0,
            existing: 0,
            rebound: 2,
            ambiguousSkipped: 0,
            protectedAlbums: 1,
            reviewIgnores: 2,
            unmatchedProtectedAlbums: 1,
        });
        expect(plan.protectedAlbumsToMerge).toEqual([
            { albumId: 'android-alb-docs', title: 'Documents', createdAt: 100 },
        ]);
        expect(plan.reviewIgnoresToMerge).toEqual([
            { ignoreType: 'similar_group', targetKey: 'snap-stable-hash', createdAt: 200 },
            { ignoreType: 'blur', targetKey: 'android-999', createdAt: 201 },
        ]);
    });

    it('safely skips ambiguous (>1) contentFingerprint matches and counts ambiguousSkipped without mis-binding', () => {
        const exported = asset('old-1', 'photo', {
            filename: 'DUPLICATE.jpg', width: 3000, height: 2000, creationTime: 1700000000000,
        });
        const wrongSizeExported = asset('old-2', 'photo', {
            filename: 'SIZE_DIFF.jpg', width: 3000, height: 2000, creationTime: 1700000000000,
        });
        const outOfToleranceExported = asset('old-3', 'photo', {
            filename: 'TIME_DIFF.jpg', width: 3000, height: 2000, creationTime: 1700000000000,
        });
        const v2: BackupPayloadV2 = {
            version: 2,
            platform: 'android',
            records: [
                {
                    id: exported.id,
                    kind: 'photo',
                    decision: 'delete',
                    fingerprint: mediaFingerprint(exported),
                    contentFingerprint: buildContentFingerprint(exported, 500000),
                },
                {
                    id: wrongSizeExported.id,
                    kind: 'photo',
                    decision: 'delete',
                    fingerprint: mediaFingerprint(wrongSizeExported),
                    contentFingerprint: buildContentFingerprint(wrongSizeExported, 500000),
                },
                {
                    id: outOfToleranceExported.id,
                    kind: 'photo',
                    decision: 'keep',
                    fingerprint: mediaFingerprint(outOfToleranceExported),
                    contentFingerprint: buildContentFingerprint(outOfToleranceExported, 500000),
                },
            ],
            protectedAlbums: [],
            reviewIgnores: [],
        };

        const visible = new Map<string, Asset>([
            // Two local copies matching exported -> ambiguous!
            ['photo:copy-a', asset('copy-a', 'photo', { filename: 'DUPLICATE.jpg', width: 3000, height: 2000, creationTime: 1700000000500 })],
            ['photo:copy-b', asset('copy-b', 'photo', { filename: 'DUPLICATE.jpg', width: 3000, height: 2000, creationTime: 1700000000800 })],
            // Different file size -> must NOT match!
            ['photo:size-mismatch', asset('size-mismatch', 'photo', { filename: 'SIZE_DIFF.jpg', width: 3000, height: 2000, creationTime: 1700000000000 })],
            // Beyond 2000ms creationTime tolerance -> must NOT match!
            ['photo:time-mismatch', asset('time-mismatch', 'photo', { filename: 'TIME_DIFF.jpg', width: 3000, height: 2000, creationTime: 1700000010000 })],
        ]);
        const localSizes = new Map<string, number | null>([
            ['photo:copy-a', 500000],
            ['photo:copy-b', 500000],
            ['photo:size-mismatch', 999999],
            ['photo:time-mismatch', 500000],
        ]);

        const plan = planRestore(v2, blank(), visible, true, { localSizes });
        expect(plan.merged).toEqual(blank());
        expect(plan.preview.rebound).toBe(0);
        expect(plan.preview.ambiguousSkipped).toBe(1);
        expect(plan.preview.skipped).toBe(3);
    });

    it('P0-2: never writes foreign-platform albumId into protectedAlbumsToMerge when localAlbums is undefined', () => {
        const v2: BackupPayloadV2 = {
            version: 2,
            platform: 'ios',
            records: [],
            protectedAlbums: [
                { albumId: '7A3E1234-5678-4ABC-9DEF-1234567890AB/L0/040', title: 'ID Cards', createdAt: 100 },
            ],
            reviewIgnores: [],
        };

        const plan = planRestore(v2, blank(), new Map(), false, {
            localAlbums: undefined,
            targetPlatform: 'android',
        });

        expect(plan.protectedAlbumsToMerge).toEqual([]);
        expect(plan.preview.protectedAlbums).toBe(0);
        expect(plan.preview.unmatchedProtectedAlbums).toBe(1);
    });

    it('P1-1: excludes pending deletions belonging to existing or restored protected albums even when includePending is true', () => {
        const protectedPhoto = asset('p-prot', 'photo', { albumId: 'alb-docs' });
        const iOSNoAlbumIdPhoto = asset('p-ios-prot', 'photo');
        const normalPhoto = asset('p-norm', 'photo', { albumId: 'alb-cam' });
        const v2: BackupPayloadV2 = {
            version: 2,
            platform: 'android',
            records: [
                { id: protectedPhoto.id, kind: 'photo', decision: 'delete', fingerprint: mediaFingerprint(protectedPhoto), contentFingerprint: buildContentFingerprint(protectedPhoto, null) },
                { id: iOSNoAlbumIdPhoto.id, kind: 'photo', decision: 'delete', fingerprint: mediaFingerprint(iOSNoAlbumIdPhoto), contentFingerprint: buildContentFingerprint(iOSNoAlbumIdPhoto, null) },
                { id: normalPhoto.id, kind: 'photo', decision: 'delete', fingerprint: mediaFingerprint(normalPhoto), contentFingerprint: buildContentFingerprint(normalPhoto, null) },
            ],
            protectedAlbums: [{ albumId: 'alb-docs', title: 'Docs', createdAt: 10 }],
            reviewIgnores: [],
        };

        const visible = new Map<string, Asset>([
            ['photo:p-prot', protectedPhoto],
            ['photo:p-ios-prot', iOSNoAlbumIdPhoto],
            ['photo:p-norm', normalPhoto],
        ]);
        const plan = planRestore(v2, blank(), visible, true, {
            targetPlatform: 'android',
            localAlbums: [{ id: 'alb-docs', title: 'Docs' }, { id: 'alb-cam', title: 'Camera' }],
            protectedAssetIds: new Set(['p-ios-prot']),
        });

        expect(plan.merged.deleteQueue.map(item => item.id)).toEqual(['p-norm']);
        expect(plan.merged.photoProcessedIds).toEqual(['p-norm']);
        expect(plan.preview.pendingDeletion).toBe(1);
        expect(plan.preview.skipped).toBe(2);
    });

    it('P1-4: verifies contentFingerprint on blur ignores so Android small-integer _ID collisions never mis-bind', () => {
        const oldBlurryPhoto = asset('42', 'photo', {
            filename: 'IMG_OLD_BLUR.jpg', width: 3000, height: 2000, creationTime: 1700000000000,
        });
        const v2: BackupPayloadV2 = {
            version: 2,
            platform: 'android',
            records: [],
            protectedAlbums: [],
            reviewIgnores: [
                {
                    ignoreType: 'blur',
                    targetKey: '42',
                    createdAt: 500,
                    contentFingerprint: buildContentFingerprint(oldBlurryPhoto, 123456),
                },
            ],
        };

        // New Android phone has a completely unrelated photo at _ID = 42,
        // while the real photo moved to _ID = 900.
        const unrelatedCollidingPhoto = asset('42', 'photo', {
            filename: 'IMG_OTHER_PHOTO.jpg', width: 4000, height: 3000, creationTime: 1710000000000,
        });
        const realRelocatedPhoto = asset('900', 'photo', {
            filename: 'IMG_OLD_BLUR.jpg', width: 3000, height: 2000, creationTime: 1700000000500,
        });
        const visible = new Map<string, Asset>([
            ['photo:42', unrelatedCollidingPhoto],
            ['photo:900', realRelocatedPhoto],
        ]);
        const localSizes = new Map<string, number | null>([
            ['photo:42', 999999],
            ['photo:900', 123456],
        ]);

        const plan = planRestore(v2, blank(), visible, false, { localSizes, targetPlatform: 'android' });
        expect(plan.reviewIgnoresToMerge).toEqual([
            { ignoreType: 'blur', targetKey: '900', createdAt: 500 },
        ]);
        expect(plan.preview.reviewIgnores).toBe(1);
    });

    it('P1-4: rebinds cross-device copy whose mtime changed when contentFingerprint + fileSize match, while skipping genuine same-device edits', () => {
        const exportedAndroid = asset('101', 'photo', {
            filename: 'IMG_COPY.jpg', width: 4000, height: 3000, creationTime: 1700000000000, modificationTime: 1700000000000,
        });
        const v2Android: BackupPayloadV2 = {
            version: 2,
            platform: 'android',
            records: [{
                id: '101',
                kind: 'photo',
                decision: 'keep',
                fingerprint: mediaFingerprint(exportedAndroid),
                contentFingerprint: buildContentFingerprint(exportedAndroid, 2450123),
            }],
            protectedAlbums: [],
            reviewIgnores: [],
        };

        // Cross-device copy updated modificationTime, kept exact fileSize/dimensions/filename, and collided on _ID=101.
        const copiedPhoto = asset('101', 'photo', {
            filename: 'IMG_COPY.jpg', width: 4000, height: 3000, creationTime: 1700000000000, modificationTime: 1700999999000,
        });
        const copyPlan = planRestore(v2Android, blank(), new Map([['photo:101', copiedPhoto]]), false, {
            localSizes: new Map([['photo:101', 2450123]]),
            targetPlatform: 'android',
        });
        expect(copyPlan.merged.photoProcessedIds).toEqual(['101']);
        expect(copyPlan.preview.kept).toBe(1);
        expect(copyPlan.preview.rebound).toBe(1);

        // Genuine same-device edit changes fileSize -> rejected!
        const editedAndroidPlan = planRestore(v2Android, blank(), new Map([['photo:101', copiedPhoto]]), false, {
            localSizes: new Map([['photo:101', 2510000]]),
            targetPlatform: 'android',
        });
        expect(editedAndroidPlan.merged.photoProcessedIds).toEqual([]);
        expect(editedAndroidPlan.preview.skipped).toBe(1);

        // Same-device iOS in-place edit (UUID match, hasFileSize=false, mtime changed) -> rejected!
        const exportedIos = asset('IOS-UUID-1', 'photo', {
            filename: 'IMG_IOS.heic', width: 4032, height: 3024, creationTime: 1700000000000, modificationTime: 1700000000000,
        });
        const v2Ios: BackupPayloadV2 = {
            version: 2,
            platform: 'ios',
            records: [{
                id: 'IOS-UUID-1',
                kind: 'photo',
                decision: 'keep',
                fingerprint: mediaFingerprint(exportedIos),
                contentFingerprint: buildContentFingerprint(exportedIos, null),
            }],
            protectedAlbums: [],
            reviewIgnores: [],
        };
        const editedIos = { ...exportedIos, modificationTime: 1700500000000 };
        const editedIosPlan = planRestore(v2Ios, blank(), new Map([['photo:IOS-UUID-1', editedIos]]), false, {
            targetPlatform: 'ios',
        });
        expect(editedIosPlan.merged.photoProcessedIds).toEqual([]);
        expect(editedIosPlan.preview.skipped).toBe(1);
    });
});
