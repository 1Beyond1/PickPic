import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { File } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { AssetRepository } from '../database';
import { readMediaSizes, supportsIndexedMediaSizes } from './mediaSizes';
import { isAssetProtected } from './protectedAlbumsCore';
import { getReadableMediaInfos } from './readableMedia';

/**
 * Byte-for-byte exact duplicate detector (independent of perceptual dHash
 * visual similarity).
 *
 * Strategy:
 * 1. Bucket scanned photos by positive, exact integer `fileSize`.
 * 2. Hash ONLY buckets with >= 2 candidates using bounded concurrency and
 *    SHA-256 (`@noble/hashes/sha2.js`), enforcing a per-file size cap and
 *    explicitly reporting unknown-size, oversized, and unreadable/inaccessible
 *    items so callers never present an incomplete check as complete.
 * 3. Enforce protected-album rules: protected members are always marked
 *    protected, defaulted to keep, and excluded from batch deletion queues.
 */

export const MAX_EXACT_DUPLICATE_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_EXACT_DUPLICATE_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const LIMITED_SCOPE_PAGE_SIZE = 200;

export type ExactDuplicateKeepStrategy = 'protected_and_earliest' | 'earliest';

export interface ExactDuplicateCandidate {
    assetId: string;
    uri?: string | null;
    filename?: string;
    fileSize: number | null;
    creationTime?: number | null;
    albumId?: string;
    width?: number;
    height?: number;
}

export interface ExactDuplicateMember {
    assetId: string;
    uri: string;
    filename?: string;
    fileSize: number;
    creationTime: number | null;
    albumId?: string;
    width: number;
    height: number;
    isProtected: boolean;
}

export interface ExactDuplicateGroup {
    sha256: string;
    fileSize: number;
    members: ExactDuplicateMember[];
    recommendedKeepIds: string[];
    /** Estimated redundant bytes (not yet freed; requires pending-deletion confirmation). */
    reclaimableBytes: number;
}

export interface ExactDuplicateProgress {
    phase: 'bucketing' | 'hashing' | 'done';
    totalCandidates: number;
    hashedCount: number;
    skippedUnreadableCount: number;
}

export interface ExactDuplicateScanResult {
    status: 'ready' | 'cancelled' | 'permission';
    groups: ExactDuplicateGroup[];
    totalEvaluated: number;
    sizeBucketCandidateCount: number;
    hashedCount: number;
    skippedUnknownSizeCount: number;
    skippedUnreadableCount: number;
    skippedOversizedCount: number;
    permissionLimited: boolean;
}

export type ExactDuplicateByteReader = (
    candidate: ExactDuplicateCandidate,
    maxFileBytes: number,
) => Promise<Uint8Array | null>;

export interface DetectExactDuplicatesOptions {
    readBytes?: ExactDuplicateByteReader;
    protectedAlbumIds?: ReadonlySet<string>;
    protectedAssetIds?: ReadonlySet<string>;
    concurrency?: number;
    maxFileBytes?: number;
    isCancelled?: () => boolean;
    onProgress?: (progress: ExactDuplicateProgress) => void;
    permissionLimited?: boolean;
    /** Pre-counted unknown-size or oversized items excluded before calling detectExactDuplicates. */
    priorTotalEvaluated?: number;
    priorSkippedUnknownSizeCount?: number;
    priorSkippedOversizedCount?: number;
}

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

export function isValidPositiveByteSize(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Extract a positive byte size from a file-backed scanner signature
 * (`<modTime>_<size>`). Library-only signatures (`library_<mtime>_<w>_<h>`)
 * do not carry file size and return null.
 */
export function parseFileSizeFromSignature(fileSignature: string | null | undefined): number | null {
    if (typeof fileSignature !== 'string') return null;
    const match = /^\d+(?:\.\d+)?_(\d+)$/.exec(fileSignature);
    if (!match) return null;
    const parsed = Number(match[1]);
    return isValidPositiveByteSize(parsed) ? parsed : null;
}

function validCreationTime(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function compareMembersChronologically(left: ExactDuplicateMember, right: ExactDuplicateMember): number {
    if (left.creationTime !== null && right.creationTime === null) return -1;
    if (left.creationTime === null && right.creationTime !== null) return 1;
    if (left.creationTime !== null && right.creationTime !== null && left.creationTime !== right.creationTime) {
        return left.creationTime - right.creationTime;
    }
    return left.assetId.localeCompare(right.assetId);
}

/**
 * Determine which members in an exact duplicate group should be kept by default.
 * Protected-album members are ALWAYS kept and can never be auto-selected for
 * deletion. At least one member is always preserved.
 */
export function selectExactDuplicateKeepIds(
    members: readonly ExactDuplicateMember[],
    strategy: ExactDuplicateKeepStrategy = 'protected_and_earliest',
): string[] {
    if (members.length === 0) return [];
    const sorted = [...members].sort(compareMembersChronologically);
    const keepIds = new Set<string>();

    for (const member of sorted) {
        if (member.isProtected) {
            keepIds.add(member.assetId);
        }
    }

    if (strategy === 'earliest') {
        keepIds.add(sorted[0].assetId);
    } else if (keepIds.size === 0) {
        // 'protected_and_earliest': if at least one protected copy exists, keep all
        // protected copies; otherwise keep the earliest captured copy.
        keepIds.add(sorted[0].assetId);
    }

    return sorted.filter(member => keepIds.has(member.assetId)).map(member => member.assetId);
}

/**
 * Compute the exact list of redundant member IDs eligible to enter the unified
 * pending-deletion queue for a group. Protected members are NEVER returned,
 * and at least one member in the group is always kept.
 */
export function selectExactDuplicateQueueIds(
    group: Pick<ExactDuplicateGroup, 'members' | 'recommendedKeepIds'>,
    explicitKeepIds?: ReadonlySet<string>,
): string[] {
    if (group.members.length < 2) return [];
    const sorted = [...group.members].sort(compareMembersChronologically);
    const effectiveKeep = new Set<string>();

    if (explicitKeepIds) {
        for (const member of sorted) {
            if (explicitKeepIds.has(member.assetId)) {
                effectiveKeep.add(member.assetId);
            }
        }
    } else {
        for (const id of group.recommendedKeepIds) {
            effectiveKeep.add(id);
        }
    }

    // Iron guard: every protected member stays kept regardless of caller selection.
    for (const member of sorted) {
        if (member.isProtected) {
            effectiveKeep.add(member.assetId);
        }
    }

    // Safety guard: never allow queueing every single copy in a group.
    if (effectiveKeep.size === 0) {
        effectiveKeep.add(sorted[0].assetId);
    }

    return sorted
        .filter(member => !member.isProtected && !effectiveKeep.has(member.assetId))
        .map(member => member.assetId);
}

/**
 * Default Expo FileSystem byte reader for exact SHA-256 verification.
 * Checks existence and single-file byte limit before reading into memory.
 */
export async function readCandidateFileBytes(
    candidate: ExactDuplicateCandidate,
    maxFileBytes: number = MAX_EXACT_DUPLICATE_FILE_BYTES,
): Promise<Uint8Array | null> {
    if (!candidate.uri) return null;
    try {
        const file = new File(candidate.uri);
        if (!file.exists) return null;
        if (typeof file.size === 'number' && file.size > maxFileBytes) return null;
        const bytes = await file.bytes();
        if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > maxFileBytes) {
            return null;
        }
        return bytes;
    } catch {
        return null;
    }
}

/**
 * Pure core byte-for-byte duplicate detector.
 * Buckets candidates by exact `fileSize` (> 0), hashes only same-size buckets
 * (count >= 2) with bounded concurrency via SHA-256, and returns sorted groups
 * annotated with protected-album retention defaults and explicit skip stats.
 */
export async function detectExactDuplicates(
    candidates: readonly ExactDuplicateCandidate[],
    options: DetectExactDuplicatesOptions = {},
): Promise<ExactDuplicateScanResult> {
    const readBytes = options.readBytes ?? readCandidateFileBytes;
    const protectedAlbumIds = options.protectedAlbumIds ?? EMPTY_STRING_SET;
    const protectedAssetIds = options.protectedAssetIds ?? EMPTY_STRING_SET;
    const concurrency = Math.max(
        1,
        Math.min(MAX_CONCURRENCY, Math.floor(options.concurrency ?? DEFAULT_EXACT_DUPLICATE_CONCURRENCY)),
    );
    const maxFileBytes = isValidPositiveByteSize(options.maxFileBytes)
        ? options.maxFileBytes
        : MAX_EXACT_DUPLICATE_FILE_BYTES;
    const isCancelled = options.isCancelled;
    const onProgress = options.onProgress;
    const permissionLimited = !!options.permissionLimited;

    const deduped = new Map<string, ExactDuplicateCandidate>();
    for (const candidate of candidates) {
        if (!candidate?.assetId) continue;
        if (!deduped.has(candidate.assetId)) {
            deduped.set(candidate.assetId, candidate);
        }
    }

    const totalEvaluated = options.priorTotalEvaluated ?? deduped.size;
    let skippedUnknownSizeCount = options.priorSkippedUnknownSizeCount ?? 0;
    let skippedOversizedCount = options.priorSkippedOversizedCount ?? 0;
    let skippedUnreadableCount = 0;

    if (isCancelled?.()) {
        return {
            status: 'cancelled',
            groups: [],
            totalEvaluated,
            sizeBucketCandidateCount: 0,
            hashedCount: 0,
            skippedUnknownSizeCount,
            skippedUnreadableCount,
            skippedOversizedCount,
            permissionLimited,
        };
    }

    onProgress?.({
        phase: 'bucketing',
        totalCandidates: 0,
        hashedCount: 0,
        skippedUnreadableCount: 0,
    });

    // Stage 1: Exact byte-size bucketing (> 0 and <= maxFileBytes).
    const bucketsBySize = new Map<number, ExactDuplicateCandidate[]>();
    for (const candidate of deduped.values()) {
        if (!isValidPositiveByteSize(candidate.fileSize)) {
            skippedUnknownSizeCount++;
            continue;
        }
        if (candidate.fileSize > maxFileBytes) {
            skippedOversizedCount++;
            continue;
        }
        const bucket = bucketsBySize.get(candidate.fileSize);
        if (bucket) bucket.push(candidate);
        else bucketsBySize.set(candidate.fileSize, [candidate]);
    }

    const candidatesToHash: ExactDuplicateCandidate[] = [];
    for (const bucket of bucketsBySize.values()) {
        if (bucket.length >= 2) {
            candidatesToHash.push(...bucket);
        }
    }

    const sizeBucketCandidateCount = candidatesToHash.length;
    if (sizeBucketCandidateCount === 0) {
        onProgress?.({
            phase: 'done',
            totalCandidates: 0,
            hashedCount: 0,
            skippedUnreadableCount,
        });
        return {
            status: 'ready',
            groups: [],
            totalEvaluated,
            sizeBucketCandidateCount: 0,
            hashedCount: 0,
            skippedUnknownSizeCount,
            skippedUnreadableCount,
            skippedOversizedCount,
            permissionLimited,
        };
    }

    onProgress?.({
        phase: 'hashing',
        totalCandidates: sizeBucketCandidateCount,
        hashedCount: 0,
        skippedUnreadableCount: 0,
    });

    // Stage 2: Bounded-concurrency SHA-256 content hashing on candidate buckets only.
    const groupsByHashKey = new Map<string, { sha256: string; fileSize: number; members: ExactDuplicateMember[] }>();
    let nextIndex = 0;
    let hashedCount = 0;
    let cancelled = false;

    const workerCount = Math.min(concurrency, candidatesToHash.length);
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (nextIndex < candidatesToHash.length) {
                if (isCancelled?.()) {
                    cancelled = true;
                    return;
                }
                const candidate = candidatesToHash[nextIndex++];
                const expectedSize = candidate.fileSize!;

                if (!candidate.uri) {
                    skippedUnreadableCount++;
                    onProgress?.({
                        phase: 'hashing',
                        totalCandidates: sizeBucketCandidateCount,
                        hashedCount,
                        skippedUnreadableCount,
                    });
                    continue;
                }

                let bytes: Uint8Array | null = null;
                try {
                    bytes = await readBytes(candidate, maxFileBytes);
                } catch {
                    bytes = null;
                }

                if (isCancelled?.()) {
                    cancelled = true;
                    return;
                }

                if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
                    skippedUnreadableCount++;
                    onProgress?.({
                        phase: 'hashing',
                        totalCandidates: sizeBucketCandidateCount,
                        hashedCount,
                        skippedUnreadableCount,
                    });
                    continue;
                }

                if (bytes.length > maxFileBytes) {
                    skippedOversizedCount++;
                    onProgress?.({
                        phase: 'hashing',
                        totalCandidates: sizeBucketCandidateCount,
                        hashedCount,
                        skippedUnreadableCount,
                    });
                    continue;
                }

                // If actual file bytes no longer match indexed fileSize, the file
                // changed concurrently or metadata was stale; do not risk false grouping.
                if (bytes.length !== expectedSize) {
                    skippedUnreadableCount++;
                    onProgress?.({
                        phase: 'hashing',
                        totalCandidates: sizeBucketCandidateCount,
                        hashedCount,
                        skippedUnreadableCount,
                    });
                    continue;
                }

                const digest = bytesToHex(sha256(bytes));
                const member: ExactDuplicateMember = {
                    assetId: candidate.assetId,
                    uri: candidate.uri,
                    ...(candidate.filename ? { filename: candidate.filename } : {}),
                    fileSize: expectedSize,
                    creationTime: validCreationTime(candidate.creationTime),
                    ...(candidate.albumId ? { albumId: candidate.albumId } : {}),
                    width: typeof candidate.width === 'number' && Number.isFinite(candidate.width) && candidate.width > 0 ? candidate.width : 0,
                    height: typeof candidate.height === 'number' && Number.isFinite(candidate.height) && candidate.height > 0 ? candidate.height : 0,
                    isProtected: isAssetProtected(
                        { id: candidate.assetId, albumId: candidate.albumId },
                        protectedAlbumIds,
                        protectedAssetIds,
                    ),
                };

                const bucketKey = `${expectedSize}:${digest}`;
                const existing = groupsByHashKey.get(bucketKey);
                if (existing) {
                    existing.members.push(member);
                } else {
                    groupsByHashKey.set(bucketKey, { sha256: digest, fileSize: expectedSize, members: [member] });
                }

                hashedCount++;
                onProgress?.({
                    phase: 'hashing',
                    totalCandidates: sizeBucketCandidateCount,
                    hashedCount,
                    skippedUnreadableCount,
                });
            }
        }),
    );

    if (cancelled || isCancelled?.()) {
        return {
            status: 'cancelled',
            groups: [],
            totalEvaluated,
            sizeBucketCandidateCount,
            hashedCount,
            skippedUnknownSizeCount,
            skippedUnreadableCount,
            skippedOversizedCount,
            permissionLimited,
        };
    }

    const groups: ExactDuplicateGroup[] = [];
    for (const entry of groupsByHashKey.values()) {
        if (entry.members.length < 2) continue;
        const members = [...entry.members].sort(compareMembersChronologically);
        const recommendedKeepIds = selectExactDuplicateKeepIds(members, 'protected_and_earliest');
        const redundantCount = Math.max(0, members.length - recommendedKeepIds.length);
        groups.push({
            sha256: entry.sha256,
            fileSize: entry.fileSize,
            members,
            recommendedKeepIds,
            reclaimableBytes: entry.fileSize * redundantCount,
        });
    }

    groups.sort((left, right) => (
        right.reclaimableBytes - left.reclaimableBytes
        || right.fileSize - left.fileSize
        || left.sha256.localeCompare(right.sha256)
    ));

    onProgress?.({
        phase: 'done',
        totalCandidates: sizeBucketCandidateCount,
        hashedCount,
        skippedUnreadableCount,
    });

    return {
        status: 'ready',
        groups,
        totalEvaluated,
        sizeBucketCandidateCount,
        hashedCount,
        skippedUnknownSizeCount,
        skippedUnreadableCount,
        skippedOversizedCount,
        permissionLimited,
    };
}

async function resolveVisiblePhotoIds(isCancelled?: () => boolean): Promise<{
    granted: boolean;
    limited: boolean;
    visibleIds?: string[];
}> {
    const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    if (!permission.granted) {
        return { granted: false, limited: false };
    }
    if (permission.accessPrivileges !== 'limited') {
        return { granted: true, limited: false, visibleIds: undefined };
    }

    const visibleIds = new Set<string>();
    const cursors = new Set<string>();
    let after: string | undefined;
    while (true) {
        if (isCancelled?.()) {
            return { granted: true, limited: true, visibleIds: [] };
        }
        const page = await MediaLibrary.getAssetsAsync({
            mediaType: 'photo',
            first: LIMITED_SCOPE_PAGE_SIZE,
            ...(after ? { after } : {}),
        });
        for (const asset of page.assets) {
            if (asset?.id) visibleIds.add(asset.id);
        }
        if (!page.hasNextPage) break;
        if (!page.endCursor || cursors.has(page.endCursor)) {
            throw new Error('Invalid pagination cursor while reading visible photos for exact duplicate check');
        }
        cursors.add(page.endCursor);
        after = page.endCursor;
    }

    return { granted: true, limited: true, visibleIds: Array.from(visibleIds) };
}

export interface ScanIndexedExactDuplicatesOptions {
    protectedAlbumIds?: ReadonlySet<string>;
    protectedAssetIds?: ReadonlySet<string>;
    concurrency?: number;
    maxFileBytes?: number;
    isCancelled?: () => boolean;
    onProgress?: (progress: ExactDuplicateProgress) => void;
    readBytes?: ExactDuplicateByteReader;
}

/**
 * Scan currently accessible, already-indexed (DONE) photos for byte-identical
 * duplicates. Pre-buckets by exact file size BEFORE inspecting URIs or reading
 * file bytes so non-duplicate sizes incur zero file I/O.
 */
export async function scanExactDuplicatesFromIndexedPhotos(
    options: ScanIndexedExactDuplicatesOptions = {},
): Promise<ExactDuplicateScanResult> {
    const isCancelled = options.isCancelled;
    const maxFileBytes = isValidPositiveByteSize(options.maxFileBytes)
        ? options.maxFileBytes
        : MAX_EXACT_DUPLICATE_FILE_BYTES;

    const access = await resolveVisiblePhotoIds(isCancelled);
    if (isCancelled?.()) {
        return {
            status: 'cancelled',
            groups: [],
            totalEvaluated: 0,
            sizeBucketCandidateCount: 0,
            hashedCount: 0,
            skippedUnknownSizeCount: 0,
            skippedUnreadableCount: 0,
            skippedOversizedCount: 0,
            permissionLimited: access.limited,
        };
    }
    if (!access.granted) {
        return {
            status: 'permission',
            groups: [],
            totalEvaluated: 0,
            sizeBucketCandidateCount: 0,
            hashedCount: 0,
            skippedUnknownSizeCount: 0,
            skippedUnreadableCount: 0,
            skippedOversizedCount: 0,
            permissionLimited: false,
        };
    }

    options.onProgress?.({
        phase: 'bucketing',
        totalCandidates: 0,
        hashedCount: 0,
        skippedUnreadableCount: 0,
    });

    const scannedAssets = await AssetRepository.getCompletedAssetsSummary(access.visibleIds);
    if (isCancelled?.()) {
        return {
            status: 'cancelled',
            groups: [],
            totalEvaluated: scannedAssets.length,
            sizeBucketCandidateCount: 0,
            hashedCount: 0,
            skippedUnknownSizeCount: 0,
            skippedUnreadableCount: 0,
            skippedOversizedCount: 0,
            permissionLimited: access.limited,
        };
    }

    // Prefer Android MediaStore exact _SIZE when available; fall back to
    // file-backed scanner signatures (<modTime>_<size>).
    const indexedSizes = new Map<string, number>();
    if (supportsIndexedMediaSizes()) {
        const numericIds = scannedAssets
            .map(row => row.asset_id)
            .filter(id => /^[1-9][0-9]{0,18}$/.test(id));
        if (numericIds.length > 0) {
            const sizeResult = await readMediaSizes('photo', numericIds, () => !isCancelled?.());
            if (isCancelled?.()) {
                return {
                    status: 'cancelled',
                    groups: [],
                    totalEvaluated: scannedAssets.length,
                    sizeBucketCandidateCount: 0,
                    hashedCount: 0,
                    skippedUnknownSizeCount: 0,
                    skippedUnreadableCount: 0,
                    skippedOversizedCount: 0,
                    permissionLimited: access.limited,
                };
            }
            if (sizeResult.status === 'ready') {
                for (const [id, bytes] of sizeResult.sizes) {
                    if (isValidPositiveByteSize(bytes)) {
                        indexedSizes.set(id, bytes);
                    }
                }
            }
        }
    }

    // Pre-bucket scanned assets by exact fileSize so we only fetch readable URIs
    // for the subset of photos that actually share a byte size with >= 1 peer.
    let priorSkippedUnknownSizeCount = 0;
    let priorSkippedOversizedCount = 0;
    const preBuckets = new Map<number, typeof scannedAssets>();
    for (const row of scannedAssets) {
        const size = indexedSizes.get(row.asset_id) ?? parseFileSizeFromSignature(row.file_signature);
        if (!isValidPositiveByteSize(size)) {
            priorSkippedUnknownSizeCount++;
            continue;
        }
        if (size > maxFileBytes) {
            priorSkippedOversizedCount++;
            continue;
        }
        const bucket = preBuckets.get(size);
        if (bucket) bucket.push(row);
        else preBuckets.set(size, [row]);
    }

    const bucketedRows: { row: (typeof scannedAssets)[number]; fileSize: number }[] = [];
    for (const [size, rows] of preBuckets) {
        if (rows.length >= 2) {
            for (const row of rows) {
                bucketedRows.push({ row, fileSize: size });
            }
        }
    }

    if (bucketedRows.length === 0) {
        options.onProgress?.({
            phase: 'done',
            totalCandidates: 0,
            hashedCount: 0,
            skippedUnreadableCount: 0,
        });
        return {
            status: 'ready',
            groups: [],
            totalEvaluated: scannedAssets.length,
            sizeBucketCandidateCount: 0,
            hashedCount: 0,
            skippedUnknownSizeCount: priorSkippedUnknownSizeCount,
            skippedUnreadableCount: 0,
            skippedOversizedCount: priorSkippedOversizedCount,
            permissionLimited: access.limited,
        };
    }

    const readableInfos = await getReadableMediaInfos(
        bucketedRows.map(item => item.row.asset_id),
        'photo',
        { shouldDownloadFromNetwork: false },
    );
    if (isCancelled?.()) {
        return {
            status: 'cancelled',
            groups: [],
            totalEvaluated: scannedAssets.length,
            sizeBucketCandidateCount: bucketedRows.length,
            hashedCount: 0,
            skippedUnknownSizeCount: priorSkippedUnknownSizeCount,
            skippedUnreadableCount: 0,
            skippedOversizedCount: priorSkippedOversizedCount,
            permissionLimited: access.limited,
        };
    }

    const candidates: ExactDuplicateCandidate[] = bucketedRows.map(({ row, fileSize }) => {
        const info = readableInfos.get(row.asset_id);
        const uri = info?.localUri || info?.uri || null;
        return {
            assetId: row.asset_id,
            uri,
            filename: info?.filename,
            fileSize,
            creationTime: info?.creationTime ?? row.taken_at,
            albumId: info?.albumId,
            width: info?.width ?? row.width ?? 0,
            height: info?.height ?? row.height ?? 0,
        };
    });

    return detectExactDuplicates(candidates, {
        readBytes: options.readBytes,
        protectedAlbumIds: options.protectedAlbumIds,
        protectedAssetIds: options.protectedAssetIds,
        concurrency: options.concurrency,
        maxFileBytes,
        isCancelled,
        onProgress: options.onProgress,
        permissionLimited: access.limited,
        priorTotalEvaluated: scannedAssets.length,
        priorSkippedUnknownSizeCount,
        priorSkippedOversizedCount,
    });
}
