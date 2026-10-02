jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn() }));
import { TextEncoder } from 'node:util';
import type { Asset } from 'expo-media-library';
import { BackupPayload, mediaFingerprint, parseBackupPayload, planRestore, RecordSnapshot } from '../../services/backup/payload';
Object.assign(globalThis, { TextEncoder });
const asset = (id: string, kind = 'photo') => ({ id, filename: `${id}.jpg`, uri: `file:///current/${id}`, mediaType: kind,
    width: 100, height: 100, creationTime: 100, modificationTime: 200, duration: 0 } as Asset);
const blank = (): RecordSnapshot => ({ photoProcessedIds: [], videoProcessedIds: [], deleteQueue: [], collectionQueue: [], videoTrashBin: [] });
const record = (id: string, decision: 'keep' | 'delete' | 'collect', kind: 'photo' | 'video' = 'photo') => ({ id, kind, decision, fingerprint: mediaFingerprint(asset(id, kind)) });
const file = (records: BackupPayload['records']): BackupPayload => ({ version: 1, platform: 'android', records });

it('restores decisions using current assets and keeps current choices', () => {
    const current = blank(); current.photoProcessedIds = ['already-kept'];
    const payload = file([record('keep', 'keep'), record('collect', 'collect'), record('delete', 'delete'), record('already-kept', 'delete')]);
    const visible = new Map(payload.records.map(row => [`photo:${row.id}`, asset(row.id)]));
    const { merged, preview } = planRestore(payload, current, visible, true);
    expect(merged.photoProcessedIds).toEqual(['already-kept', 'keep', 'collect', 'delete']);
    expect(merged.deleteQueue.map(row => row.id)).toEqual(['delete']);
    expect(merged.collectionQueue[0].uri).toBe('file:///current/collect');
    expect(preview).toEqual({ kept: 1, collected: 1, pendingDeletion: 1, existing: 1, skipped: 0 });
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
    { version: 1, platform: 'ios', records: [] },
    { version: 1, platform: 'android', records: [], uri: 'file:///secret' },
    file([record('a', 'keep'), record('a', 'delete')]),
    file([{ ...record('a', 'keep'), fingerprint: 'invalid' }]),
    file([{ ...record('a', 'keep'), decision: 'erase-now' } as any]),
])('rejects incompatible or malformed payloads', value => {
    expect(() => parseBackupPayload(value, 'android')).toThrow();
});
