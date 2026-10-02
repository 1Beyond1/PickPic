import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Asset } from 'expo-media-library';
import { BackupError } from './crypto';

export type Decision = 'keep' | 'collect' | 'delete';
export interface BackupRecord { id: string; kind: 'photo' | 'video'; fingerprint: string; decision: Decision }
export interface BackupPayload { version: 1; platform: 'android' | 'ios'; records: BackupRecord[] }
export interface RecordSnapshot {
    photoProcessedIds: string[]; videoProcessedIds: string[];
    deleteQueue: Asset[]; collectionQueue: Asset[]; videoTrashBin: Asset[];
}
const MAX_RECORDS = 50000;

/** Identifies the same entry in the same library; not a cross-device content hash. */
export function mediaFingerprint(asset: Asset): string {
    if (!asset.id || !asset.filename || !['photo', 'video'].includes(asset.mediaType)
        || ![asset.creationTime, asset.modificationTime, asset.width, asset.height, asset.duration].every(Number.isFinite)) {
        throw new BackupError('invalid');
    }
    return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
        asset.id, asset.filename, asset.mediaType, asset.creationTime, asset.modificationTime,
        asset.width, asset.height, asset.duration,
    ]))));
}

export function parseBackupPayload(value: unknown, platform: string): BackupPayload {
    const exactKeys = (object: object, keys: string[]) => Object.keys(object).sort().join(',') === keys.sort().join(',');
    if (!value || typeof value !== 'object' || !exactKeys(value, ['version', 'platform', 'records'])) throw new BackupError('invalid');
    const payload = value as BackupPayload;
    if (payload.version !== 1 || !['android', 'ios'].includes(payload.platform) || payload.platform !== platform
        || !Array.isArray(payload.records) || payload.records.length > MAX_RECORDS) throw new BackupError('invalid');
    const seen = new Set<string>();
    for (const record of payload.records) {
        if (!record || typeof record !== 'object' || !exactKeys(record, ['id', 'kind', 'fingerprint', 'decision'])
            || typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 512
            || !['photo', 'video'].includes(record.kind) || !['keep', 'collect', 'delete'].includes(record.decision)
            || (record.kind === 'video' && record.decision === 'collect')
            || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint)) throw new BackupError('invalid');
        const key = `${record.kind}:${record.id}`;
        if (seen.has(key)) throw new BackupError('invalid');
        seen.add(key);
    }
    return payload;
}

export function snapshotRecords(state: RecordSnapshot): RecordSnapshot {
    return { photoProcessedIds: [...state.photoProcessedIds], videoProcessedIds: [...state.videoProcessedIds],
        deleteQueue: [...state.deleteQueue], collectionQueue: [...state.collectionQueue], videoTrashBin: [...state.videoTrashBin] };
}

export function getDecisions(state: RecordSnapshot) {
    const rows = new Map<string, { id: string; kind: 'photo' | 'video'; decision: Decision }>();
    const add = (id: string, kind: 'photo' | 'video', decision: Decision) => rows.set(`${kind}:${id}`, { id, kind, decision });
    state.photoProcessedIds.forEach(id => add(id, 'photo', 'keep'));
    state.videoProcessedIds.forEach(id => add(id, 'video', 'keep'));
    state.collectionQueue.forEach(asset => add(asset.id, 'photo', 'collect'));
    state.deleteQueue.forEach(asset => add(asset.id, 'photo', 'delete'));
    state.videoTrashBin.forEach(asset => add(asset.id, 'video', 'delete'));
    if (rows.size > MAX_RECORDS) throw new BackupError('size');
    return [...rows.values()];
}

export interface RestorePreview { kept: number; collected: number; pendingDeletion: number; skipped: number; existing: number }
/** Current decisions always win. Excluded pending deletions never become processed-only IDs. */
export function planRestore(payload: BackupPayload, current: RecordSnapshot, visible: ReadonlyMap<string, Asset>, includePending: boolean) {
    const merged = snapshotRecords(current);
    const existing = new Set(getDecisions(current).map(record => `${record.kind}:${record.id}`));
    const preview: RestorePreview = { kept: 0, collected: 0, pendingDeletion: 0, skipped: 0, existing: 0 };
    for (const record of payload.records) {
        const key = `${record.kind}:${record.id}`;
        const asset = visible.get(key);
        if (!asset || asset.mediaType !== record.kind || mediaFingerprint(asset) !== record.fingerprint) { preview.skipped++; continue; }
        if (existing.has(key)) { preview.existing++; continue; }
        if (record.decision === 'delete') {
            preview.pendingDeletion++;
            if (!includePending) continue;
            (record.kind === 'photo' ? merged.deleteQueue : merged.videoTrashBin).push(asset);
        } else if (record.decision === 'collect') { preview.collected++; merged.collectionQueue.push(asset); }
        else preview.kept++;
        (record.kind === 'photo' ? merged.photoProcessedIds : merged.videoProcessedIds).push(record.id);
    }
    return { merged, preview };
}
