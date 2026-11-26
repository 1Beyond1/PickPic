jest.mock('expo-file-system', () => ({
    File: jest.fn(),
}));
jest.mock('expo-media-library', () => ({
    getPermissionsAsync: jest.fn(),
    getAssetsAsync: jest.fn(),
    getAssetInfoAsync: jest.fn(),
    deleteAssetsAsync: jest.fn(),
}));
jest.mock('../services/mediaSizes', () => ({
    supportsIndexedMediaSizes: jest.fn(() => false),
    readMediaSizes: jest.fn(),
}));
jest.mock('../services/readableMedia', () => ({
    getReadableMediaInfos: jest.fn(),
}));
jest.mock('../database', () => ({
    AssetRepository: {
        getCompletedAssetsSummary: jest.fn(),
    },
}));

import * as MediaLibrary from 'expo-media-library';
import { AssetRepository } from '../database';
import {
    DEFAULT_EXACT_DUPLICATE_INFLIGHT_BYTE_BUDGET,
    LARGE_EXACT_DUPLICATE_FILE_BYTES,
    MAX_EXACT_DUPLICATE_FILE_BYTES,
    detectExactDuplicates,
    parseFileSizeFromSignature,
    scanExactDuplicatesFromIndexedPhotos,
    selectExactDuplicateKeepIds,
    selectExactDuplicateQueueIds,
    type ExactDuplicateCandidate,
    type ExactDuplicateMember,
} from '../services/exactDuplicates';
import { readMediaSizes, supportsIndexedMediaSizes } from '../services/mediaSizes';
import { getReadableMediaInfos } from '../services/readableMedia';

describe('exactDuplicates pure byte-level detection engine', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('parses file size only from positive file-backed signatures and ignores library signatures', () => {
        expect(parseFileSizeFromSignature('1700000000_2450123')).toBe(2450123);
        expect(parseFileSizeFromSignature('1700000000.5_4096')).toBe(4096);
        expect(parseFileSizeFromSignature('1700000000_0')).toBeNull();
        expect(parseFileSizeFromSignature('library_1700000000_4000_3000')).toBeNull();
        expect(parseFileSizeFromSignature(null)).toBeNull();
    });

    it('buckets by exact fileSize first and hashes ONLY same-size buckets with SHA-256', async () => {
        const bytesMap = new Map<string, Uint8Array>([
            ['dup-a', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
            ['dup-b', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
            ['same-size-diff-a', new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])],
            ['same-size-diff-b', new Uint8Array([9, 9, 9, 9, 9, 9, 9, 8])],
            ['unique-1', new Uint8Array([42, 43, 44])],
            ['unique-2', new Uint8Array([50, 51, 52, 53])],
        ]);
        const readCalls: string[] = [];
        const candidates: ExactDuplicateCandidate[] = [
            { assetId: 'dup-b', uri: 'file:///dup-b.jpg', fileSize: 8, creationTime: 2000, width: 100, height: 100 },
            { assetId: 'dup-a', uri: 'file:///dup-a.jpg', fileSize: 8, creationTime: 1000, width: 100, height: 100 },
            { assetId: 'same-size-diff-a', uri: 'file:///diff-a.jpg', fileSize: 8, creationTime: 3000 },
            { assetId: 'same-size-diff-b', uri: 'file:///diff-b.jpg', fileSize: 8, creationTime: 4000 },
            { assetId: 'unique-1', uri: 'file:///unique-1.jpg', fileSize: 3, creationTime: 5000 },
            { assetId: 'unique-2', uri: 'file:///unique-2.jpg', fileSize: 4, creationTime: 6000 },
        ];

        const result = await detectExactDuplicates(candidates, {
            readBytes: async candidate => {
                readCalls.push(candidate.assetId);
                return bytesMap.get(candidate.assetId) ?? null;
            },
        });

        expect(result.status).toBe('ready');
        // Singleton sizes (3 and 4 bytes) must NEVER be read or hashed!
        expect(readCalls).not.toContain('unique-1');
        expect(readCalls).not.toContain('unique-2');
        expect(readCalls.sort()).toEqual(['dup-a', 'dup-b', 'same-size-diff-a', 'same-size-diff-b']);
        expect(result.sizeBucketCandidateCount).toBe(4);
        expect(result.hashedCount).toBe(4);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].fileSize).toBe(8);
        // Chronologically sorted (earliest first) and earliest recommended to keep.
        expect(result.groups[0].members.map(m => m.assetId)).toEqual(['dup-a', 'dup-b']);
        expect(result.groups[0].recommendedKeepIds).toEqual(['dup-a']);
        expect(result.groups[0].reclaimableBytes).toBe(8);
        expect(result.groups[0].sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    });

    it('enforces bounded concurrency and supports mid-run cancellation cleanly', async () => {
        const candidates: ExactDuplicateCandidate[] = Array.from({ length: 8 }, (_, index) => ({
            assetId: `p-${index}`,
            uri: `file:///p-${index}.jpg`,
            fileSize: 16,
            creationTime: 1000 + index,
        }));

        let active = 0;
        let peakActive = 0;
        const result = await detectExactDuplicates(candidates, {
            concurrency: 2,
            readBytes: async () => {
                active++;
                peakActive = Math.max(peakActive, active);
                await new Promise(resolve => setTimeout(resolve, 10));
                active--;
                return new Uint8Array(16).fill(7);
            },
        });
        expect(result.status).toBe('ready');
        expect(peakActive).toBeLessThanOrEqual(2);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].members).toHaveLength(8);

        // Now verify mid-run cancellation stops hashing promptly and returns cancelled.
        let calls = 0;
        let cancelled = false;
        const cancelledResult = await detectExactDuplicates(candidates, {
            concurrency: 1,
            isCancelled: () => cancelled,
            readBytes: async () => {
                calls++;
                if (calls === 2) cancelled = true;
                return new Uint8Array(16).fill(7);
            },
        });
        expect(cancelledResult.status).toBe('cancelled');
        expect(cancelledResult.groups).toEqual([]);
        expect(calls).toBeLessThan(candidates.length);
    });

    it('explicitly tracks unknown-size, oversized, unreadable, and stale-size skipped items without false grouping', async () => {
        const candidates: ExactDuplicateCandidate[] = [
            { assetId: 'unknown-null', uri: 'file:///u1.jpg', fileSize: null },
            { assetId: 'unknown-zero', uri: 'file:///u2.jpg', fileSize: 0 },
            { assetId: 'oversized-1', uri: 'file:///o1.jpg', fileSize: 5000 },
            { assetId: 'oversized-2', uri: 'file:///o2.jpg', fileSize: 5000 },
            { assetId: 'unreadable-no-uri', uri: null, fileSize: 10 },
            { assetId: 'unreadable-throw', uri: 'file:///err.jpg', fileSize: 10 },
            { assetId: 'stale-size', uri: 'file:///stale.jpg', fileSize: 10 },
            { assetId: 'valid-only', uri: 'file:///valid.jpg', fileSize: 10 },
        ];
        const readIds: string[] = [];

        const result = await detectExactDuplicates(candidates, {
            maxFileBytes: 1024,
            readBytes: async candidate => {
                readIds.push(candidate.assetId);
                if (candidate.assetId === 'unreadable-throw') throw new Error('Permission revoked');
                if (candidate.assetId === 'stale-size') return new Uint8Array(12).fill(1); // Mismatch with fileSize=10
                return new Uint8Array(10).fill(1);
            },
        });

        expect(result.status).toBe('ready');
        expect(readIds).not.toContain('oversized-1');
        expect(readIds).not.toContain('oversized-2');
        expect(result.skippedUnknownSizeCount).toBe(2);
        expect(result.skippedOversizedCount).toBe(2);
        expect(result.skippedUnreadableCount).toBe(3); // no-uri + throw + stale-size
        expect(result.hashedCount).toBe(1);
        expect(result.groups).toEqual([]);
    });

    it('protects protected-album members unconditionally and supports protected-first & earliest-first strategies', async () => {
        const sharedBytes = new Uint8Array([10, 20, 30, 40]);
        const candidates: ExactDuplicateCandidate[] = [
            { assetId: 'earliest-normal', uri: 'file:///1.jpg', fileSize: 4, creationTime: 1000, albumId: 'alb-cam' },
            { assetId: 'later-protected-album', uri: 'file:///2.jpg', fileSize: 4, creationTime: 2000, albumId: 'alb-docs' },
            { assetId: 'latest-protected-asset', uri: 'file:///3.jpg', fileSize: 4, creationTime: 3000, albumId: 'alb-other' },
            { assetId: 'latest-normal', uri: 'file:///4.jpg', fileSize: 4, creationTime: 4000, albumId: 'alb-cam' },
        ];

        const result = await detectExactDuplicates(candidates, {
            protectedAlbumIds: new Set(['alb-docs']),
            protectedAssetIds: new Set(['latest-protected-asset']),
            readBytes: async () => sharedBytes,
        });

        expect(result.groups).toHaveLength(1);
        const group = result.groups[0];

        // Protected members are automatically flagged and defaulted to keep.
        const byId = new Map(group.members.map(m => [m.assetId, m]));
        expect(byId.get('earliest-normal')?.isProtected).toBe(false);
        expect(byId.get('later-protected-album')?.isProtected).toBe(true);
        expect(byId.get('latest-protected-asset')?.isProtected).toBe(true);
        expect(byId.get('latest-normal')?.isProtected).toBe(false);

        // Default 'protected_and_earliest' keeps ALL protected copies.
        expect(group.recommendedKeepIds).toEqual(['later-protected-album', 'latest-protected-asset']);
        expect(selectExactDuplicateQueueIds(group)).toEqual(['earliest-normal', 'latest-normal']);

        // 'earliest' strategy keeps earliest + ALL protected copies.
        const earliestKeep = selectExactDuplicateKeepIds(group.members, 'earliest');
        expect(earliestKeep).toEqual(['earliest-normal', 'later-protected-album', 'latest-protected-asset']);
        expect(selectExactDuplicateQueueIds(group, new Set(earliestKeep))).toEqual(['latest-normal']);

        // Even if caller passes an explicit keep set trying to delete protected copies,
        // protected copies are NEVER returned as queueable!
        expect(selectExactDuplicateQueueIds(group, new Set(['latest-normal']))).toEqual(['earliest-normal']);

        // Safety invariant: when no member is protected and explicitKeepIds is empty, keep at least 1!
        const unprotectedMembers: ExactDuplicateMember[] = [
            { assetId: 'u1', uri: 'file:///u1.jpg', fileSize: 4, creationTime: 100, width: 10, height: 10, isProtected: false },
            { assetId: 'u2', uri: 'file:///u2.jpg', fileSize: 4, creationTime: 200, width: 10, height: 10, isProtected: false },
        ];
        expect(selectExactDuplicateQueueIds(
            { members: unprotectedMembers, recommendedKeepIds: ['u1'] },
            new Set(),
        )).toEqual(['u2']);
    });

    it('scanExactDuplicatesFromIndexedPhotos pre-buckets using MediaStore sizes / signatures and queries URIs only for same-size peers', async () => {
        jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({
            granted: true,
            accessPrivileges: 'all',
        } as any);
        jest.mocked(supportsIndexedMediaSizes).mockReturnValue(true);
        jest.mocked(AssetRepository.getCompletedAssetsSummary).mockResolvedValue([
            { asset_id: '101', taken_at: 1000, width: 100, height: 100, file_signature: '1000_500' },
            { asset_id: '102', taken_at: 2000, width: 100, height: 100, file_signature: '2000_500' },
            { asset_id: '103', taken_at: 3000, width: 100, height: 100, file_signature: '3000_999' },
            { asset_id: '104', taken_at: 4000, width: 100, height: 100, file_signature: 'library_4000_100_100' },
        ]);
        jest.mocked(readMediaSizes).mockResolvedValue({
            status: 'ready',
            sizes: new Map<string, number | null>([
                ['101', 500],
                ['102', 500],
                ['103', 999],
                ['104', null],
            ]),
        });
        jest.mocked(getReadableMediaInfos).mockResolvedValue(new Map([
            ['101', { id: '101', uri: 'file:///101.jpg', localUri: 'file:///101.jpg', mediaType: 'photo', width: 100, height: 100, creationTime: 1000 } as any],
            ['102', { id: '102', uri: 'file:///102.jpg', localUri: 'file:///102.jpg', mediaType: 'photo', width: 100, height: 100, creationTime: 2000 } as any],
        ]));

        const payload = new Uint8Array(500).fill(0xab);
        const result = await scanExactDuplicatesFromIndexedPhotos({
            readBytes: async () => payload,
        });

        expect(result.status).toBe('ready');
        // Only same-size candidates (101, 102) had URIs fetched!
        expect(getReadableMediaInfos).toHaveBeenCalledWith(['101', '102'], 'photo', { shouldDownloadFromNetwork: false });
        expect(result.totalEvaluated).toBe(4);
        expect(result.skippedUnknownSizeCount).toBe(1); // asset 104
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].members.map(m => m.assetId)).toEqual(['101', '102']);
    });

    it('returns permission status cleanly when photo access is denied', async () => {
        jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({
            granted: false,
            accessPrivileges: 'none',
        } as any);
        const result = await scanExactDuplicatesFromIndexedPhotos();
        expect(result.status).toBe('permission');
        expect(AssetRepository.getCompletedAssetsSummary).not.toHaveBeenCalled();
    });

    it('enforces safe default memory caps, global in-flight byte budget, and serial degradation for large files (P1-2)', async () => {
        expect(MAX_EXACT_DUPLICATE_FILE_BYTES).toBe(32 * 1024 * 1024);
        expect(DEFAULT_EXACT_DUPLICATE_INFLIGHT_BYTE_BUDGET).toBe(16 * 1024 * 1024);
        expect(LARGE_EXACT_DUPLICATE_FILE_BYTES).toBe(8 * 1024 * 1024);

        // Files above default 32 MiB cap are skipped as oversized BEFORE any byte read.
        const oversizedRead = jest.fn();
        const oversizedResult = await detectExactDuplicates([
            { assetId: 'huge-1', uri: 'file:///huge-1.dng', fileSize: 33 * 1024 * 1024 },
            { assetId: 'huge-2', uri: 'file:///huge-2.dng', fileSize: 33 * 1024 * 1024 },
        ], { readBytes: oversizedRead });
        expect(oversizedRead).not.toHaveBeenCalled();
        expect(oversizedResult.skippedOversizedCount).toBe(2);
        expect(oversizedResult.groups).toEqual([]);

        // Verify BOTH:
        // 1) Medium files (60 B each with 160 B budget, concurrency 4) never exceed 2 concurrent (120 B <= 160 B).
        // 2) Large files (>= 80 B threshold, e.g. 120 B) degrade strictly to concurrency=1 with zero overlap.
        const candidates: ExactDuplicateCandidate[] = [
            { assetId: 'med-1', uri: 'file:///med-1.jpg', fileSize: 60, creationTime: 1 },
            { assetId: 'med-2', uri: 'file:///med-2.jpg', fileSize: 60, creationTime: 2 },
            { assetId: 'med-3', uri: 'file:///med-3.jpg', fileSize: 60, creationTime: 3 },
            { assetId: 'med-4', uri: 'file:///med-4.jpg', fileSize: 60, creationTime: 4 },
            { assetId: 'big-1', uri: 'file:///big-1.png', fileSize: 120, creationTime: 5 },
            { assetId: 'big-2', uri: 'file:///big-2.png', fileSize: 120, creationTime: 6 },
            { assetId: 'big-3', uri: 'file:///big-3.png', fileSize: 120, creationTime: 7 },
        ];

        let activeCount = 0;
        let activeBytes = 0;
        let peakMediumBytes = 0;
        let peakMediumConcurrency = 0;
        let peakConcurrencyDuringLarge = 0;

        const result = await detectExactDuplicates(candidates, {
            concurrency: 4,
            maxFileBytes: 320,
            maxInFlightBytes: 160,
            serialFileThresholdBytes: 80,
            readBytes: async candidate => {
                const size = candidate.fileSize!;
                const isLarge = size >= 80;
                activeCount++;
                activeBytes += size;
                if (isLarge) {
                    peakConcurrencyDuringLarge = Math.max(peakConcurrencyDuringLarge, activeCount);
                } else {
                    peakMediumBytes = Math.max(peakMediumBytes, activeBytes);
                    peakMediumConcurrency = Math.max(peakMediumConcurrency, activeCount);
                }
                await new Promise(resolve => setTimeout(resolve, 12));
                if (isLarge) {
                    peakConcurrencyDuringLarge = Math.max(peakConcurrencyDuringLarge, activeCount);
                }
                activeBytes -= size;
                activeCount--;
                return new Uint8Array(size).fill(isLarge ? 0x22 : 0x11);
            },
        });

        expect(result.status).toBe('ready');
        expect(result.groups).toHaveLength(2);
        // Medium files stayed strictly inside 160 B budget (max 2 * 60 B = 120 B).
        expect(peakMediumBytes).toBeLessThanOrEqual(160);
        expect(peakMediumConcurrency).toBeLessThanOrEqual(2);
        // Large files (>= threshold) ran strictly serially (concurrency = 1, zero overlap).
        expect(peakConcurrencyDuringLarge).toBe(1);
    });
});
