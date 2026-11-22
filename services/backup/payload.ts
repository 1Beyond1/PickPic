import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Asset } from 'expo-media-library';
import { isAssetProtected } from '../protectedAlbumsCore';
import { BackupError } from './crypto';

export type Decision = 'keep' | 'collect' | 'delete';

export const CONTENT_FINGERPRINT_TIME_TOLERANCE_MS = 2000;

export interface BackupContentFingerprint {
    /** SHA-256 of [kind, filename, width, height, durationTenths, fileSize] */
    signature: string;
    /** SHA-256 of [kind, filename, width, height, durationTenths] without fileSize */
    baseSignature: string;
    /** Rounded creationTime (ms) used with tolerance window during cross-device rebinding */
    creationTime: number;
    /** Whether a positive integer fileSize was bound into `signature` */
    hasFileSize: boolean;
}

export interface BackupRecordV1 {
    id: string;
    kind: 'photo' | 'video';
    fingerprint: string;
    decision: Decision;
}

export interface BackupRecordV2 extends BackupRecordV1 {
    contentFingerprint: BackupContentFingerprint;
}

export type BackupRecord = BackupRecordV1 | BackupRecordV2;

export interface BackupProtectedAlbum {
    albumId: string;
    title: string;
    createdAt: number;
}

export interface BackupReviewIgnore {
    ignoreType: 'blur' | 'similar_group';
    targetKey: string;
    createdAt: number;
    contentFingerprint?: BackupContentFingerprint;
}

export interface BackupPayloadV1 {
    version: 1;
    platform: 'android' | 'ios';
    records: BackupRecordV1[];
}

export interface BackupPayloadV2 {
    version: 2;
    platform: 'android' | 'ios';
    records: BackupRecordV2[];
    protectedAlbums: BackupProtectedAlbum[];
    reviewIgnores: BackupReviewIgnore[];
}

export type BackupPayload = BackupPayloadV1 | BackupPayloadV2;

export interface RecordSnapshot {
    photoProcessedIds: string[];
    videoProcessedIds: string[];
    deleteQueue: Asset[];
    collectionQueue: Asset[];
    videoTrashBin: Asset[];
}

const MAX_RECORDS = 50000;
const MAX_PROTECTED_ALBUMS = 1000;
const MAX_REVIEW_IGNORES = 50000;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function exactKeys(object: object, keys: readonly string[]): boolean {
    return Object.keys(object).sort().join(',') === [...keys].sort().join(',');
}

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

/**
 * Privacy-preserving cross-device content fingerprint combining filename,
 * resolution (width x height), fileSize/duration, and creationTime tolerance.
 * Raw filenames are hashed so they never appear in cleartext JSON.
 */
export function buildContentFingerprint(asset: Asset, fileSize?: number | null): BackupContentFingerprint {
    if (
        !asset.filename
        || !['photo', 'video'].includes(asset.mediaType)
        || ![asset.creationTime, asset.width, asset.height, asset.duration].every(Number.isFinite)
    ) {
        throw new BackupError('invalid');
    }
    const normalizedFilename = asset.filename.trim();
    if (!normalizedFilename) throw new BackupError('invalid');
    const width = Math.round(asset.width);
    const height = Math.round(asset.height);
    const durationTenths = Math.round(Math.max(0, asset.duration) * 10);
    const creationTime = Math.max(0, Math.round(asset.creationTime));
    const validFileSize = typeof fileSize === 'number' && Number.isSafeInteger(fileSize) && fileSize > 0
        ? fileSize
        : null;

    const baseSignature = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
        'pickpic-content-base-v2',
        asset.mediaType,
        normalizedFilename,
        width,
        height,
        durationTenths,
    ]))));
    const signature = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
        'pickpic-content-v2',
        asset.mediaType,
        normalizedFilename,
        width,
        height,
        durationTenths,
        validFileSize,
    ]))));

    return {
        signature,
        baseSignature,
        creationTime,
        hasFileSize: validFileSize !== null,
    };
}

export function contentFingerprintsMatch(
    exported: BackupContentFingerprint,
    local: BackupContentFingerprint,
    toleranceMs: number = CONTENT_FINGERPRINT_TIME_TOLERANCE_MS,
): boolean {
    if (exported.baseSignature !== local.baseSignature) return false;
    if (exported.hasFileSize && local.hasFileSize && exported.signature !== local.signature) {
        return false;
    }
    return Math.abs(exported.creationTime - local.creationTime) <= toleranceMs;
}

function validateContentFingerprint(value: unknown): BackupContentFingerprint {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['signature', 'baseSignature', 'creationTime', 'hasFileSize'])) {
        throw new BackupError('invalid');
    }
    const fp = value as BackupContentFingerprint;
    if (
        typeof fp.signature !== 'string' || !SHA256_HEX.test(fp.signature)
        || typeof fp.baseSignature !== 'string' || !SHA256_HEX.test(fp.baseSignature)
        || typeof fp.creationTime !== 'number' || !Number.isSafeInteger(fp.creationTime) || fp.creationTime < 0
        || typeof fp.hasFileSize !== 'boolean'
    ) {
        throw new BackupError('invalid');
    }
    return fp;
}

function validateBaseRecord(record: unknown, requiredKeys: readonly string[]): BackupRecordV1 {
    if (!record || typeof record !== 'object' || Array.isArray(record) || !exactKeys(record, requiredKeys)) {
        throw new BackupError('invalid');
    }
    const row = record as BackupRecordV1;
    if (
        typeof row.id !== 'string' || row.id.length === 0 || row.id.length > 512
        || !['photo', 'video'].includes(row.kind)
        || !['keep', 'collect', 'delete'].includes(row.decision)
        || (row.kind === 'video' && row.decision === 'collect')
        || typeof row.fingerprint !== 'string' || !SHA256_HEX.test(row.fingerprint)
    ) {
        throw new BackupError('invalid');
    }
    return row;
}

export function parseBackupPayload(value: unknown, platform: string): BackupPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackupError('invalid');
    const raw = value as Record<string, unknown>;

    if (raw.version === 1) {
        if (!exactKeys(raw, ['version', 'platform', 'records'])) throw new BackupError('invalid');
        const payload = raw as unknown as BackupPayloadV1;
        if (!['android', 'ios'].includes(payload.platform) || payload.platform !== platform
            || !Array.isArray(payload.records) || payload.records.length > MAX_RECORDS) {
            throw new BackupError('invalid');
        }
        const seen = new Set<string>();
        for (const record of payload.records) {
            const valid = validateBaseRecord(record, ['id', 'kind', 'fingerprint', 'decision']);
            const key = `${valid.kind}:${valid.id}`;
            if (seen.has(key)) throw new BackupError('invalid');
            seen.add(key);
        }
        return payload;
    }

    if (raw.version === 2) {
        if (!exactKeys(raw, ['version', 'platform', 'records', 'protectedAlbums', 'reviewIgnores'])) {
            throw new BackupError('invalid');
        }
        const payload = raw as unknown as BackupPayloadV2;
        if (
            !['android', 'ios'].includes(payload.platform)
            || !Array.isArray(payload.records) || payload.records.length > MAX_RECORDS
            || !Array.isArray(payload.protectedAlbums) || payload.protectedAlbums.length > MAX_PROTECTED_ALBUMS
            || !Array.isArray(payload.reviewIgnores) || payload.reviewIgnores.length > MAX_REVIEW_IGNORES
        ) {
            throw new BackupError('invalid');
        }

        const seenRecords = new Set<string>();
        for (const record of payload.records) {
            const valid = validateBaseRecord(record, ['id', 'kind', 'fingerprint', 'decision', 'contentFingerprint']) as BackupRecordV2;
            validateContentFingerprint(valid.contentFingerprint);
            const key = `${valid.kind}:${valid.id}`;
            if (seenRecords.has(key)) throw new BackupError('invalid');
            seenRecords.add(key);
        }

        const seenAlbums = new Set<string>();
        for (const album of payload.protectedAlbums) {
            if (!album || typeof album !== 'object' || Array.isArray(album)
                || !exactKeys(album, ['albumId', 'title', 'createdAt'])
                || typeof album.albumId !== 'string' || album.albumId.length === 0 || album.albumId.length > 512
                || typeof album.title !== 'string' || album.title.length === 0 || album.title.length > 256
                || typeof album.createdAt !== 'number' || !Number.isSafeInteger(album.createdAt) || album.createdAt < 0
                || seenAlbums.has(album.albumId)) {
                throw new BackupError('invalid');
            }
            seenAlbums.add(album.albumId);
        }

        const seenIgnores = new Set<string>();
        for (const ignore of payload.reviewIgnores) {
            if (!ignore || typeof ignore !== 'object' || Array.isArray(ignore)) throw new BackupError('invalid');
            const hasFp = 'contentFingerprint' in ignore;
            const allowedKeys = hasFp
                ? ['ignoreType', 'targetKey', 'createdAt', 'contentFingerprint']
                : ['ignoreType', 'targetKey', 'createdAt'];
            if (
                !exactKeys(ignore, allowedKeys)
                || (ignore.ignoreType !== 'blur' && ignore.ignoreType !== 'similar_group')
                || typeof ignore.targetKey !== 'string' || ignore.targetKey.length === 0 || ignore.targetKey.length > 512
                || typeof ignore.createdAt !== 'number' || !Number.isSafeInteger(ignore.createdAt) || ignore.createdAt < 0
            ) {
                throw new BackupError('invalid');
            }
            if (hasFp) {
                if (ignore.ignoreType !== 'blur') throw new BackupError('invalid');
                validateContentFingerprint(ignore.contentFingerprint);
            }
            const key = `${ignore.ignoreType}:${ignore.targetKey}`;
            if (seenIgnores.has(key)) throw new BackupError('invalid');
            seenIgnores.add(key);
        }

        return payload;
    }

    throw new BackupError('invalid');
}

export function snapshotRecords(state: RecordSnapshot): RecordSnapshot {
    return {
        photoProcessedIds: [...state.photoProcessedIds],
        videoProcessedIds: [...state.videoProcessedIds],
        deleteQueue: [...state.deleteQueue],
        collectionQueue: [...state.collectionQueue],
        videoTrashBin: [...state.videoTrashBin],
    };
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

export interface RestorePreview {
    kept: number;
    collected: number;
    pendingDeletion: number;
    skipped: number;
    existing: number;
    rebound: number;
    ambiguousSkipped: number;
    protectedAlbums: number;
    reviewIgnores: number;
    unmatchedProtectedAlbums?: number;
}

export interface PlanRestoreOptions {
    localSizes?: ReadonlyMap<string, number | null>;
    localAlbums?: readonly { id: string; title: string }[];
    existingProtectedAlbumIds?: ReadonlySet<string>;
    existingReviewIgnores?: ReadonlySet<string>;
    timeToleranceMs?: number;
    targetPlatform?: 'android' | 'ios';
    protectedAssetIds?: ReadonlySet<string>;
    blockPendingDeletions?: boolean;
}

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

/** Current decisions always win. Excluded pending deletions never become processed-only IDs.
 * Cross-device v2 rebinding succeeds ONLY on a strict 1-to-1 unique content-fingerprint match;
 * ambiguous (>1) matches are safely skipped and counted in `ambiguousSkipped`. */
export function planRestore(
    payload: BackupPayload,
    current: RecordSnapshot,
    visible: ReadonlyMap<string, Asset>,
    includePending: boolean,
    options: PlanRestoreOptions = {},
) {
    const merged = snapshotRecords(current);
    const existing = new Set(getDecisions(current).map(record => `${record.kind}:${record.id}`));
    const preview: RestorePreview = {
        kept: 0,
        collected: 0,
        pendingDeletion: 0,
        skipped: 0,
        existing: 0,
        rebound: 0,
        ambiguousSkipped: 0,
        protectedAlbums: 0,
        reviewIgnores: 0,
    };

    const toleranceMs = options.timeToleranceMs ?? CONTENT_FINGERPRINT_TIME_TOLERANCE_MS;
    const localSizes = options.localSizes;
    const samePlatform = !options.targetPlatform || payload.platform === options.targetPlatform;

    // Resolve v2 protected albums FIRST so pending deletion restoration below
    // enforces protection against both existing AND newly-restored protected albums.
    const protectedAlbumsToMerge: BackupProtectedAlbum[] = [];
    const reviewIgnoresToMerge: { ignoreType: 'blur' | 'similar_group'; targetKey: string; createdAt: number }[] = [];
    let unmatchedProtectedAlbumsCount = 0;

    if (payload.version === 2) {
        const existingProtected = new Set(options.existingProtectedAlbumIds ?? []);
        const localAlbums = options.localAlbums;
        const localById = new Map<string, { id: string; title: string }>();
        const localByTitle = new Map<string, { id: string; title: string }[]>();
        if (localAlbums) {
            for (const album of localAlbums) {
                localById.set(album.id, album);
                const key = album.title.trim();
                const list = localByTitle.get(key);
                if (list) list.push(album);
                else localByTitle.set(key, [album]);
            }
        }
        const plannedAlbumIds = new Set<string>();
        for (const album of payload.protectedAlbums) {
            let resolved: BackupProtectedAlbum | null = null;
            if (localAlbums) {
                const directAlbum = samePlatform ? localById.get(album.albumId) : undefined;
                if (directAlbum) {
                    resolved = { albumId: directAlbum.id, title: directAlbum.title || album.title, createdAt: album.createdAt };
                } else {
                    const titleMatches = localByTitle.get(album.title.trim()) ?? [];
                    if (titleMatches.length === 1) {
                        resolved = { albumId: titleMatches[0].id, title: titleMatches[0].title, createdAt: album.createdAt };
                    }
                }
            } else if (samePlatform) {
                resolved = { ...album };
            }
            if (!resolved) {
                unmatchedProtectedAlbumsCount++;
                continue;
            }
            if (existingProtected.has(resolved.albumId) || plannedAlbumIds.has(resolved.albumId)) {
                continue;
            }
            plannedAlbumIds.add(resolved.albumId);
            protectedAlbumsToMerge.push(resolved);
            preview.protectedAlbums++;
        }
    }

    if (unmatchedProtectedAlbumsCount > 0) {
        preview.unmatchedProtectedAlbums = unmatchedProtectedAlbumsCount;
    }

    const effectiveProtectedAlbumIds = new Set<string>([
        ...(options.existingProtectedAlbumIds ?? []),
        ...protectedAlbumsToMerge.map(album => album.albumId),
    ]);
    const effectiveProtectedAssetIds = options.protectedAssetIds ?? EMPTY_STRING_SET;

    // Index visible local assets by baseSignature for O(1) cross-device lookup when v2.
    const localByBaseSig = new Map<string, { asset: Asset; fp: BackupContentFingerprint }[]>();
    const localFpByKey = new Map<string, BackupContentFingerprint>();
    if (payload.version === 2) {
        for (const [key, asset] of visible) {
            try {
                const fp = buildContentFingerprint(asset, localSizes?.get(key) ?? null);
                localFpByKey.set(key, fp);
                const bucket = localByBaseSig.get(fp.baseSignature);
                if (bucket) bucket.push({ asset, fp });
                else localByBaseSig.set(fp.baseSignature, [{ asset, fp }]);
            } catch {
                // Skip local assets with incomplete metadata.
            }
        }
    }

    type Resolution =
        | { status: 'exact'; record: BackupRecord; asset: Asset }
        | { status: 'rebound'; record: BackupRecord; asset: Asset }
        | { status: 'ambiguous'; record: BackupRecord }
        | { status: 'unmatched'; record: BackupRecord };

    const resolutions: Resolution[] = [];
    const targetHitCount = new Map<string, number>();
    let missingDirectIdCount = 0;
    if (payload.version === 2) {
        for (const record of payload.records) {
            if (!visible.has(`${record.kind}:${record.id}`)) {
                missingDirectIdCount++;
            }
        }
    }

    for (const record of payload.records) {
        const directKey = `${record.kind}:${record.id}`;
        const direct = visible.get(directKey);
        if (direct && direct.mediaType === record.kind && mediaFingerprint(direct) === record.fingerprint) {
            resolutions.push({ status: 'exact', record, asset: direct });
            targetHitCount.set(directKey, (targetHitCount.get(directKey) ?? 0) + 1);
            continue;
        }

        if (payload.version === 2) {
            const v2Record = record as BackupRecordV2;
            const directFp = direct ? localFpByKey.get(directKey) : undefined;
            const directContentMatches = !!direct
                && direct.mediaType === v2Record.kind
                && !!directFp
                && contentFingerprintsMatch(v2Record.contentFingerprint, directFp, toleranceMs);

            // Treat a matching-ID, differing-modificationTime asset as a same-device
            // in-place edit ONLY when platform matches, verified fileSize isn't identical,
            // and we have same-device provenance (iOS globally-unique UUID, or same-Android
            // restore with no missing IDs and unchanged creationTime). Cross-device copies
            // that update mtime while preserving exact content metadata will still rebind.
            const bothHaveVerifiedFileSize = !!directFp
                && v2Record.contentFingerprint.hasFileSize
                && directFp.hasFileSize;
            const isSameDeviceInPlaceEdit = directContentMatches
                && samePlatform
                && !bothHaveVerifiedFileSize
                && (
                    payload.platform === 'ios'
                    || (missingDirectIdCount === 0 && direct!.creationTime === v2Record.contentFingerprint.creationTime)
                );

            if (isSameDeviceInPlaceEdit) {
                resolutions.push({ status: 'unmatched', record: v2Record });
                continue;
            }

            const candidates = (localByBaseSig.get(v2Record.contentFingerprint.baseSignature) ?? []).filter(
                entry => entry.asset.mediaType === v2Record.kind
                    && contentFingerprintsMatch(v2Record.contentFingerprint, entry.fp, toleranceMs),
            );
            if (candidates.length === 1) {
                const matched = candidates[0].asset;
                const matchedKey = `${v2Record.kind}:${matched.id}`;
                resolutions.push({ status: 'rebound', record: v2Record, asset: matched });
                targetHitCount.set(matchedKey, (targetHitCount.get(matchedKey) ?? 0) + 1);
            } else if (candidates.length > 1) {
                resolutions.push({ status: 'ambiguous', record: v2Record });
            } else {
                resolutions.push({ status: 'unmatched', record: v2Record });
            }
        } else {
            resolutions.push({ status: 'unmatched', record });
        }
    }

    // Apply resolutions, rejecting any many-to-one rebound collision as ambiguous
    // and blocking protected-album assets from entering pending deletion queues.
    for (const item of resolutions) {
        if (item.status === 'unmatched') {
            preview.skipped++;
            continue;
        }
        if (item.status === 'ambiguous') {
            preview.ambiguousSkipped++;
            preview.skipped++;
            continue;
        }
        const targetKey = `${item.record.kind}:${item.asset.id}`;
        if (item.status === 'rebound' && (targetHitCount.get(targetKey) ?? 0) > 1) {
            preview.ambiguousSkipped++;
            preview.skipped++;
            continue;
        }
        if (existing.has(targetKey)) {
            preview.existing++;
            continue;
        }
        if (item.record.decision === 'delete') {
            if (
                options.blockPendingDeletions
                || isAssetProtected(item.asset, effectiveProtectedAlbumIds, effectiveProtectedAssetIds)
            ) {
                preview.skipped++;
                continue;
            }
            existing.add(targetKey);
            if (item.status === 'rebound') {
                preview.rebound++;
            }
            preview.pendingDeletion++;
            if (!includePending) continue;
            (item.record.kind === 'photo' ? merged.deleteQueue : merged.videoTrashBin).push(item.asset);
        } else {
            existing.add(targetKey);
            if (item.status === 'rebound') {
                preview.rebound++;
            }
            if (item.record.decision === 'collect') {
                preview.collected++;
                merged.collectionQueue.push(item.asset);
            } else {
                preview.kept++;
            }
        }
        (item.record.kind === 'photo' ? merged.photoProcessedIds : merged.videoProcessedIds).push(item.asset.id);
    }

    // V2 review ignores planning (blur ignores MUST verify contentFingerprint
    // when available so Android small-integer _ID collisions never mis-bind).
    if (payload.version === 2) {
        const existingIgnores = new Set(options.existingReviewIgnores ?? []);
        const plannedIgnores = new Set<string>();
        for (const ignore of payload.reviewIgnores) {
            let resolvedTargetKey: string | null = null;
            if (ignore.ignoreType === 'similar_group') {
                resolvedTargetKey = ignore.targetKey;
            } else {
                const directPhotoKey = `photo:${ignore.targetKey}`;
                const directPhoto = visible.get(directPhotoKey);
                if (ignore.contentFingerprint) {
                    const directFp = localFpByKey.get(directPhotoKey);
                    if (
                        directPhoto
                        && directPhoto.mediaType === 'photo'
                        && directFp
                        && contentFingerprintsMatch(ignore.contentFingerprint, directFp, toleranceMs)
                    ) {
                        resolvedTargetKey = ignore.targetKey;
                    } else {
                        const matches = (localByBaseSig.get(ignore.contentFingerprint.baseSignature) ?? []).filter(
                            entry => entry.asset.mediaType === 'photo'
                                && contentFingerprintsMatch(ignore.contentFingerprint!, entry.fp, toleranceMs),
                        );
                        if (matches.length === 1) {
                            resolvedTargetKey = matches[0].asset.id;
                        }
                    }
                } else if (directPhoto && directPhoto.mediaType === 'photo' && samePlatform) {
                    resolvedTargetKey = ignore.targetKey;
                }
            }
            if (!resolvedTargetKey) continue;
            const ignoreComposite = `${ignore.ignoreType}:${resolvedTargetKey}`;
            if (existingIgnores.has(ignoreComposite) || plannedIgnores.has(ignoreComposite)) {
                continue;
            }
            plannedIgnores.add(ignoreComposite);
            reviewIgnoresToMerge.push({
                ignoreType: ignore.ignoreType,
                targetKey: resolvedTargetKey,
                createdAt: ignore.createdAt,
            });
            preview.reviewIgnores++;
        }
    }

    return { merged, preview, protectedAlbumsToMerge, reviewIgnoresToMerge };
}
