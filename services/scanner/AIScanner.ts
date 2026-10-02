/**
 * AIScanner - Main scanning engine for photo analysis
 * 
 * Features:
 * - Incremental scanning with cursor-based pagination
 * - Concurrency control using InteractionManager + setTimeout yield
 * - Blur detection, perceptual hashing, similarity matching
 * - Automatic duplicate group creation
 * - Error isolation (single photo failure doesn't stop scan)
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { InteractionManager, Platform } from 'react-native';

import {
    AssetRepository,
    AssetStatus,
    DupGroupRepository,
    GLOBAL_ALGO_VERSION,
    MetaRepository,
} from '../../database';
import { getImageOps, GrayImageRef } from '../imageOps';
import { hasFullPhotoLibraryAccess } from '../../stores/useMediaStore';
import { hasDocumentContext } from '../ml/LabelClassifier';
import { selectBestShot } from './BestShotSelector';
import { findSimilarPhotos } from './SimilarityMatcher';
import { AIAnalysisRepository } from '../../database/repositories/AIAnalysisRepository';
import { acquireRecordOperation, isRecordTransferActive } from '../recordOperationLock';

// ============================================================================
// Types
// ============================================================================

export interface ScanProgress {
    totalPending: number;
    totalDone: number;
    totalError: number;
    currentBatch: number;
    isRunning: boolean;
}

export interface ScanBatchOptions {
    mode: 'album' | 'count';
    albumIds?: string[];
    count?: number;
}

export interface ScannerCallbacks {
    onProgress?: (progress: ScanProgress) => void;
    onAssetScanned?: (assetId: string, success: boolean) => void;
    onBatchComplete?: (batchIndex: number) => void;
    onComplete?: () => void;
    onError?: (error: Error) => void;
}

// ============================================================================
// Scanner State
// ============================================================================

let isRunning = false;
let isFinalizing = false;
let shouldStop = false;
let currentBatch = 0;
let callbacks: ScannerCallbacks = {};
let mlFailureCount = 0;
let mlCircuitBreakerTripped = false;
let scannerRunGeneration = 0;

const BATCH_SIZE = 20;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Yield to main thread using setTimeout
 * Increased to 50ms to allow GC and Native Bridge to catch up
 */
function yieldToMainThread(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 50));
}

/**
 * Wait for interactions to complete before proceeding
 */
function waitForInteractions(): Promise<void> {
    return new Promise(resolve => {
        InteractionManager.runAfterInteractions(() => resolve());
    });
}

/**
 * Generate file signature (modification time + size)
 */
async function getFileSignature(uri: string): Promise<string | null> {
    try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && !info.isDirectory) {
            return `${info.modificationTime ?? 0}_${info.size ?? 0}`;
        }
    } catch {
        // Ignore errors
    }
    // Some platforms expose library-only URIs (for example ph:// on iOS)
    // that FileSystem cannot stat. Do not treat an unavailable signature as a
    // changed file or every scan would invalidate the same asset repeatedly.
    return null;
}

/**
 * Use media-library metadata when the platform URI is not file-system backed
 * (for example `ph://` on iOS). This keeps edited assets invalidatable even
 * when FileSystem.getInfoAsync cannot inspect their URI.
 */
function getMediaLibrarySignature(asset: MediaLibrary.Asset): string | null {
    if (!Number.isFinite(asset.modificationTime)
        || !Number.isFinite(asset.width)
        || !Number.isFinite(asset.height)) {
        return null;
    }

    return `library_${asset.modificationTime}_${asset.width}_${asset.height}`;
}

async function getAssetSignature(asset: MediaLibrary.Asset): Promise<string | null> {
    return await getFileSignature(asset.uri) ?? getMediaLibrarySignature(asset);
}

/** Android full-detail reads may demand location permission even though pixel
 * analysis does not use GPS. Fall back only for that known SDK error, never
 * request location or mask unrelated file failures. */
async function getReadableAssetInfo(assetId: string, takenAt: number | null): Promise<MediaLibrary.AssetInfo> {
    try { return await MediaLibrary.getAssetInfoAsync(assetId); }
    catch (error) {
        if (Platform.OS !== 'android' || !(error instanceof Error) || !error.message.includes('ACCESS_MEDIA_LOCATION')) throw error;
        const cursors = new Set<string>();
        let after: string | undefined;
        // Positive known timestamps narrow the native query to this instant.
        // Missing/zero times (including PNGs without DATE_TAKEN) need a full
        // paginated lookup; do not invent a date and silently skip the asset.
        const timeRange = takenAt !== null && Number.isFinite(takenAt) && takenAt > 0
            ? { createdAfter: takenAt - 1, createdBefore: takenAt + 1 } : {};
        do {
            const page = await MediaLibrary.getAssetsAsync({ mediaType: 'photo', first: 100,
                resolveWithFullInfo: false, ...timeRange, ...(after ? { after } : {}) });
            const asset = page.assets.find(item => item.id === assetId);
            if (asset) return { ...asset, localUri: asset.uri } as MediaLibrary.AssetInfo;
            if (!page.hasNextPage) throw new Error('Asset no longer available for analysis');
            if (!page.endCursor || cursors.has(page.endCursor)) throw new Error('Could not resolve analysis asset');
            cursors.add(page.endCursor); after = page.endCursor;
        } while (true);
    }
}

const STATUS_MEDIA_PAGE_SIZE = 100;

/**
 * Resolve the photo IDs currently visible to a limited-permission user.
 * A null result means full access, while an empty set means no access.
 */
async function getVisiblePhotoIdsForStatus(): Promise<ReadonlySet<string> | null> {
    const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    if (!permission.granted) return new Set();
    if (permission.accessPrivileges !== 'limited') return null;

    const visibleIds = new Set<string>();
    let after: string | undefined;

    while (true) {
        const result = await MediaLibrary.getAssetsAsync({
            mediaType: 'photo',
            first: STATUS_MEDIA_PAGE_SIZE,
            ...(after ? { after } : {}),
        });

        for (const asset of result.assets) {
            visibleIds.add(asset.id);
        }

        if (!result.hasNextPage) break;
        if (!result.endCursor || result.endCursor === after) {
            throw new Error('Media library returned an invalid pagination cursor while reading scan status');
        }
        after = result.endCursor;
    }

    return visibleIds;
}

/**
 * Generate unique group ID
 */
function generateGroupId(): string {
    return `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function resetMLFailureState(): void {
    mlFailureCount = 0;
    mlCircuitBreakerTripped = false;
}

function recordMLFailure(error: unknown): Error {
    mlFailureCount += 1;

    if (mlFailureCount > 3 && !mlCircuitBreakerTripped) {
        console.warn('[AIScanner] ML Circuit Breaker tripped. Pausing AI classification for this scan.');
        mlCircuitBreakerTripped = true;
    }

    return error instanceof Error ? error : new Error(String(error));
}

// ============================================================================
// Sync Functions
// ============================================================================

/**
 * Sync media library assets to database
 */
async function syncAssetsToDatabase(): Promise<ReadonlySet<string> | null> {
    console.log('[AIScanner] Syncing assets to database...');

    const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    if (!permission.granted) {
        throw new Error('Photo library permission is required before scanning');
    }
    // With limited access, getAssetsAsync intentionally omits media the user
    // did not grant. Those assets are inaccessible, not deleted; removing
    // them from the local index would lose their previous scan results.
    const startedWithLimitedPhotoAccess = permission.accessPrivileges === 'limited';

    let hasMore = true;
    let cursor: string | undefined;
    let synced = 0;
    let shouldResetCursor = false;
    const seenAssetIds = new Set<string>();

    while (hasMore) {
        if (shouldStop) return null;

        const result = await MediaLibrary.getAssetsAsync({
            mediaType: 'photo',
            first: 100,
            after: cursor,
            sortBy: [['creationTime', true]], // Ascending by creation time
        });

        for (const asset of result.assets) {
            if (shouldStop) return null;
            seenAssetIds.add(asset.id);

            // Check if asset exists and signature changed
            const signature = await getAssetSignature(asset);
            const existing = await AssetRepository.getById(asset.id);

            if (existing) {
                // Refresh library metadata and check for signature changes.
                // taken_at is also the incremental scan's sort key. If it
                // moves across the persisted cursor, restart from the
                // beginning so a still-pending asset cannot be skipped.
                const scanOrderChanged = existing.taken_at !== asset.creationTime;
                const signatureChanged = await AssetRepository.refreshLibraryMetadata(asset.id, {
                    takenAt: asset.creationTime,
                    width: asset.width,
                    height: asset.height,
                    fileSignature: signature,
                });
                if (scanOrderChanged || signatureChanged) {
                    // A changed asset may be older than the persisted cursor.
                    // Rewind so resetting it to PENDING cannot make it
                    // permanently unreachable in the next incremental pass.
                    shouldResetCursor = true;
                }
                if (scanOrderChanged || signatureChanged) {
                    // Similarity matching is constrained by taken_at. Remove
                    // the old membership whenever the scan-order metadata
                    // changes, then reprocess the asset so it can join groups
                    // in its new time window.
                    await DupGroupRepository.removeAssetFromGroups(
                        asset.id,
                        startedWithLimitedPhotoAccess,
                        startedWithLimitedPhotoAccess
                    );
                }
            } else {
                // Insert new asset
                await AssetRepository.upsert({
                    asset_id: asset.id,
                    taken_at: asset.creationTime,
                    width: asset.width,
                    height: asset.height,
                    file_signature: signature,
                    status: AssetStatus.PENDING,
                });
                synced++;
                shouldResetCursor = true;
            }
        }

        const nextCursor = result.endCursor;
        hasMore = result.hasNextPage;
        if (hasMore) {
            // A full sync is allowed to remove records only after every page
            // has been read. Treat a broken/repeated cursor as an incomplete
            // sync instead of silently reconciling against a partial set.
            if (!nextCursor || nextCursor === cursor) {
                throw new Error('Media library returned an invalid pagination cursor during sync');
            }
            cursor = nextCursor;
        }

        // Yield periodically
        if (synced > 0 && synced % 500 === 0) {
            await yieldToMainThread();
        }
    }

    if (shouldStop) return null;

    // Permission scope can change while the app is backgrounded. Never treat
    // a partial snapshot as a complete library sync, or records outside the
    // current selection could be removed from the local index.
    const finalPermission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    if (shouldStop) return null;
    if (!finalPermission.granted) {
        throw new Error('Photo library permission changed during scanning');
    }

    const endedWithLimitedPhotoAccess = finalPermission.accessPrivileges === 'limited';
    if (endedWithLimitedPhotoAccess !== startedWithLimitedPhotoAccess) {
        throw new Error('Photo library access changed during scanning; please retry');
    }

    if (startedWithLimitedPhotoAccess) {
        // A limited-to-limited permission edit keeps the same coarse
        // privilege value. Re-read the actual visible set before treating
        // this sync as a stable snapshot; otherwise a pagination pass that
        // straddled the edit could process assets from both selections.
        const finalVisiblePhotoIds = await getVisiblePhotoIdsForStatus();
        if (shouldStop) return null;
        if (
            finalVisiblePhotoIds === null
            || finalVisiblePhotoIds.size !== seenAssetIds.size
            || Array.from(finalVisiblePhotoIds).some(assetId => !seenAssetIds.has(assetId))
        ) {
            throw new Error('Photo selection changed during scanning; please retry');
        }
    }

    const hasFullPhotoAccess = !startedWithLimitedPhotoAccess;

    if (hasFullPhotoAccess) {
        const removed = await AssetRepository.removeMissingAssets(seenAssetIds);
        if (removed.length > 0) {
            console.log(`[AIScanner] Removed ${removed.length} missing assets from the local index.`);
        }
    } else {
        console.log('[AIScanner] Limited photo access: preserving assets outside the granted selection.');
    }

    if (shouldResetCursor) {
        // New/changed assets can sort before the persisted cursor. Pending
        // status makes restarting from the beginning cheap for already-done
        // assets and prevents silently skipping these records.
        await MetaRepository.resetScanCursor();
    }

    console.log(`[AIScanner] Synced ${synced} new assets.`);

    // A limited-permission sync intentionally preserves older records that
    // are outside the current grant. Return the visible IDs so callers can
    // avoid trying to process those inaccessible records as pending work.
    return hasFullPhotoAccess ? null : seenAssetIds;
}

/**
 * Resolve the current photo IDs for selected albums. The scan itself uses
 * database records, but the album membership is owned by MediaLibrary and
 * must be read fresh for each album scan.
 */
async function getPhotoAssetIdsForAlbums(albumIds: readonly string[]): Promise<string[]> {
    const assetIds = new Set<string>();
    const requestedAlbumIds = Array.from(new Set(albumIds));
    if (requestedAlbumIds.length === 0) {
        throw new Error('At least one album must be selected for an album scan');
    }

    if (!(await hasFullPhotoLibraryAccess())) {
        throw new Error('Full photo-library access is required for album scans on iOS');
    }

    // Album IDs can become stale when the user deletes or renames an album
    // outside the app. iOS treats an unknown album as an unscoped query, so
    // validate the scope before requesting any assets.
    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    const availableAlbumIds = new Set(albums.map(album => album.id));
    const validAlbumIds = requestedAlbumIds.filter(albumId => availableAlbumIds.has(albumId));

    if (shouldStop) return [];
    if (validAlbumIds.length !== requestedAlbumIds.length) {
        throw new Error('One or more selected albums are no longer available');
    }

    for (const albumId of validAlbumIds) {
        let hasMore = true;
        let cursor: string | undefined;

        while (hasMore) {
            if (shouldStop) return Array.from(assetIds);

            const result = await MediaLibrary.getAssetsAsync({
                mediaType: 'photo',
                first: 100,
                album: albumId,
                ...(cursor ? { after: cursor } : {}),
            });

            for (const asset of result.assets) {
                assetIds.add(asset.id);
            }

            const nextCursor = result.endCursor;
            hasMore = result.hasNextPage;
            if (hasMore) {
                if (!nextCursor || nextCursor === cursor) {
                    throw new Error(`Media library returned an invalid pagination cursor for album ${albumId}`);
                }
                cursor = nextCursor;
            }
        }
    }

    if (shouldStop) return Array.from(assetIds);

    // iOS falls back to an unscoped query if an album disappears while a
    // page is being fetched. Discard the accumulated IDs instead of scanning
    // a result that may have come from the whole library.
    if (!(await hasFullPhotoLibraryAccess())) {
        throw new Error('Full photo-library access is required for album scans on iOS');
    }
    const currentAlbums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    const currentAlbumIds = new Set(currentAlbums.map(album => album.id));
    if (validAlbumIds.some(albumId => !currentAlbumIds.has(albumId))) {
        throw new Error('One or more selected albums are no longer available');
    }

    return Array.from(assetIds);
}

/**
 * Reset outdated assets (algo_version mismatch)
 */
async function resetOutdatedAssets(
    assetIds?: readonly string[],
    markForWiderDuplicateScan = false
): Promise<void> {
    const globalVersion = await MetaRepository.getGlobalAlgoVersion();
    const resetAssetIds = await AssetRepository.resetOutdatedAssets(globalVersion, assetIds);

    if (resetAssetIds.length > 0) {
        // Only outdated assets need to be rescanned. Remove their stale
        // memberships, but do not discard unaffected or out-of-scope group
        // members while preparing this scan.
        await DupGroupRepository.removeAssetsFromGroups(
            resetAssetIds,
            assetIds !== undefined,
            markForWiderDuplicateScan
        );
        await MetaRepository.resetScanCursor();
        console.log(`[AIScanner] Reset ${resetAssetIds.length} outdated assets.`);
    }
}

/**
 * Recover an incremental scan whose process ended after an asset was reset
 * to PENDING but before the matching cursor rewind was persisted.
 */
async function rewindCursorForPendingAssets(): Promise<void> {
    const cursor = await MetaRepository.getScanCursor();
    if (cursor.takenAt === null || cursor.assetId === null) return;

    if (await AssetRepository.hasPendingAtOrBeforeCursor(cursor.takenAt, cursor.assetId)) {
        await MetaRepository.resetScanCursor();
        console.log('[AIScanner] Rewound cursor for pending asset recovery.');
    }
}

// ============================================================================
// Scan Functions
// ============================================================================

/**
 * Process a single asset
 */
async function analyzeAIPhoto(assetInfo: MediaLibrary.AssetInfo, uri: string) {
    const imageOps = getImageOps();
    let labelsJson: string | null = null;
    let faceCount = 0;
    const { MLKitService } = await import('../ml/MLKitService');
    if (!(await MLKitService.waitUntilAvailable())) {
        throw new Error('AI classification model is not ready; please retry the scan');
    }

    if (!MLKitService.isAvailable()) {
        throw new Error('AI classification model is unavailable; please retry the scan');
    }

    // Phase 2a: Label Image (Object Detection) FIRST
    let labelingUri = uri;
    let isCropped = false;

    // PREPROCESS: Center crop to square to avoid aspect ratio distortion
    // EfficientNet-Lite4 expects 300x300 square input.
    try {
        if (imageOps.centerCropSquare && assetInfo.width && assetInfo.height) {
            // EfficientNet-Lite4 uses 300x300
            labelingUri = await imageOps.centerCropSquare(uri, assetInfo.width, assetInfo.height, 300);
            isCropped = (labelingUri !== uri);
        }
    } catch {
        console.warn('[AIScanner] Crop failed, using original.');
    }

    const labels = await (async () => {
        try {
            return await MLKitService.labelImage(labelingUri);
        } finally {
            // Always clean up the temporary crop, including
            // when classification times out or throws.
            if (isCropped) {
                await FileSystem.deleteAsync(labelingUri, { idempotent: true }).catch(() => { });
            }
        }
    })();

    // Yield to allow GC after heavy image op
    await yieldToMainThread();

    if (labels.length > 0) {
        labelsJson = JSON.stringify(labels);
    }

    // Phase 2b: Face Detection (Context-Aware)
    const rawFaces = await MLKitService.detectFaces(uri);

    // Filter 1: Size Filter (Ignore tiny faces like icons/ads)
    const imgWidth = assetInfo.width || 1000;
    const MIN_Face_RATIO = 0.1; // Face must be 10% of image width
    const validFaces = rawFaces.filter(f => {
        // Check bounding box width (ML Kit returns 'width')
        return (f.boundingBox?.width || 0) > (imgWidth * MIN_Face_RATIO);
    });

    // Filter 2: Context Disqualifier (Ignore faces in Screenshots/Websites)
    // Use the same grouped evidence as the category screen.
    // A weaker document candidate or a photographed monitor
    // must not override an actual face detection.
    const isContextDisqualified = hasDocumentContext(labels);

    if (isContextDisqualified) {
        console.log('[AIScanner] Ignored face candidates in a document context.');
        faceCount = 0;
    } else {
        faceCount = validFaces.length;
    }

    if (faceCount > 0) {
        console.log('[AIScanner] Face analysis completed');
    }

    // Reset failure count on a complete ML success.
    mlFailureCount = 0;
    mlCircuitBreakerTripped = false;

    return { labelsJson: labelsJson ?? '[]', faceCount };
}

async function processAIForAsset(assetId: string): Promise<boolean> {
    const source = await AssetRepository.getById(assetId);
    if (!source || source.status !== AssetStatus.DONE || source.algo_version !== GLOBAL_ALGO_VERSION) return false;
    const isVisible = async () => {
        const scope = await getVisiblePhotoIdsForStatus();
        return scope === null || scope.has(assetId);
    };
    const matchesSource = async (info: MediaLibrary.AssetInfo) => {
        const signature = await getAssetSignature(info);
        return info.width === source.width && info.height === source.height && info.creationTime === source.taken_at
            && (source.file_signature === null || signature === source.file_signature);
    };
    try {
        if (!await isVisible() || shouldStop) return false;
        const info = await getReadableAssetInfo(assetId, source.taken_at);
        if (!info.localUri || !await matchesSource(info)) return false;
        const result = await analyzeAIPhoto(info, info.localUri);
        if (!await isVisible()) return false;
        const latest = await getReadableAssetInfo(assetId, source.taken_at);
        if (!await matchesSource(latest) || latest.modificationTime !== info.modificationTime) return false;
        return await AIAnalysisRepository.save(source, result);
    } catch (error) {
        // AI errors must never clear completed base results or group membership.
        recordMLFailure(error);
        if (await isVisible()) await AIAnalysisRepository.save(source, null);
        return false;
    }
}

async function processAsset(
    assetId: string,
    similarityCandidateAssetIds: readonly string[] | undefined,
    preserveSingletonGroups: boolean,
    markForWiderDuplicateScan: boolean
): Promise<boolean> {
    const imageOps = getImageOps();
    let gray: GrayImageRef | null = null;

    try {
        // Get asset info from media library
        const indexed = await AssetRepository.getById(assetId);
        const assetInfo = await getReadableAssetInfo(assetId, indexed?.taken_at ?? null);
        if (!assetInfo || !assetInfo.localUri) {
            throw new Error('Asset not found or no local URI');
        }

        const uri = assetInfo.localUri;

        // Resize and analyze
        gray = await imageOps.resizeToGray256(uri);

        const blurScore = imageOps.computeLaplacianVar(gray);
        const meanLuma = imageOps.computeMeanLuma(gray);
        const phash = imageOps.computeDHash64(gray);

        // Release gray before DB operations
        imageOps.dispose(gray);
        gray = null;

        // Persist the base result before optional AI work.

        // Compute candidates before publishing the new result. The database
        // method below then commits the base result and the group mutation in
        // one transaction, closing the DONE-without-membership crash window.
        const asset = await AssetRepository.getById(assetId);
        const matches = asset && asset.taken_at !== null
            ? await findSimilarPhotos(
                phash,
                asset.taken_at,
                assetId,
                undefined,
                similarityCandidateAssetIds
            )
            : [];

        const targetGroupId = await AssetRepository.markDoneWithDuplicateGroups(
            assetId,
            blurScore,
            meanLuma,
            phash,
            GLOBAL_ALGO_VERSION,
            0,
            null,
            matches,
            generateGroupId(),
            preserveSingletonGroups,
            markForWiderDuplicateScan
        );

        const { useSettingsStore } = await import('../../stores/useSettingsStore');
        if (useSettingsStore.getState().enableAIClassification && !shouldStop) {
            try { await processAIForAsset(assetId); }
            catch {
                useScannerStore.getState().setLastError(new Error('AI result could not be saved; base analysis was preserved'));
            }
        }

        if (targetGroupId) {
            // Best-shot metadata is recoverable and must not turn an
            // otherwise complete scan/group transaction into ERROR.
            try {
                await selectBestShot(targetGroupId);
            } catch {
                console.warn('[AIScanner] Failed to update a suggested keep item.');
            }
        }

        return true;
    } catch (error) {
        // Release gray if allocated
        if (gray) {
            imageOps.dispose(gray);
        }

        // Mark as error
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await AssetRepository.markError(
            assetId,
            errorMessage,
            preserveSingletonGroups,
            markForWiderDuplicateScan
        );

        // Native decoder/ML errors may include media URIs. Keep diagnostics
        // generic; the detailed retry state belongs in the encrypted index.
        console.warn('[AIScanner] Failed to process a media item.');
        return false;
    }
}

/**
 * Process a batch of assets
 */
async function processBatch(
    batchSize: number = BATCH_SIZE,
    assetIds?: readonly string[],
    similarityCandidateAssetIds?: readonly string[],
    preserveSingletonGroups = false,
    markForWiderDuplicateScan = preserveSingletonGroups
): Promise<boolean> {
    const batch = assetIds
        ? await AssetRepository.getPendingBatchForAssetIds(assetIds, batchSize)
        : await (async () => {
            const cursor = await MetaRepository.getScanCursor();
            return AssetRepository.getPendingBatch(cursor.takenAt, cursor.assetId, batchSize);
        })();

    if (batch.length === 0) {
        return false; // No more pending assets
    }

    currentBatch++;

    for (const asset of batch) {
        if (shouldStop) {
            return false;
        }

        // Wait for interactions
        await waitForInteractions();

        // stop() may be called while waiting for animations/interactions. Do
        // not start another asset once the stop request has arrived.
        if (shouldStop) {
            return false;
        }

        // Process asset
        const success = await processAsset(
            asset.asset_id,
            similarityCandidateAssetIds,
            preserveSingletonGroups,
            markForWiderDuplicateScan
        );

        // Yield after each asset
        await yieldToMainThread();

        // Notify progress
        callbacks.onAssetScanned?.(asset.asset_id, success);
        useScannerStore.getState().incrementProgress(success);

        if (mlCircuitBreakerTripped) {
            const circuitBreakerError = new Error(
                'AI classification paused after repeated failures; please check the model and retry the scan'
            );
            shouldStop = true;
            useScannerStore.getState().setLastError(circuitBreakerError);
            callbacks.onError?.(circuitBreakerError);
            return false;
        }

        // Update cursor
        if (!assetIds && success && asset.taken_at !== null) {
            await MetaRepository.setScanCursor(asset.taken_at, asset.asset_id);
        }
    }

    // Notify batch complete
    callbacks.onBatchComplete?.(currentBatch);

    return true; // More batches may be available
}

import { useScannerStore } from '../../stores/useScannerStore';

// ...

/**
 * Report current progress
 */
async function reportProgress(assetIds?: readonly string[]): Promise<void> {
    const counts = await AssetRepository.getStatusCounts(assetIds);
    const progress = {
        totalPending: counts.pending,
        totalDone: counts.done,
        totalError: counts.error,
        currentBatch,
        isRunning,
    };
    useScannerStore.getState().setProgress(progress);
    callbacks.onProgress?.(progress);
}

/**
 * Publish a permission-aware snapshot after cancellation or a fatal scan
 * failure. Setup can already have synced or reset database rows before
 * shouldStop is observed, and a fatal setup/database error can otherwise
 * leave the settings screen showing the previous progress snapshot.
 */
async function reportCurrentStatus(
    isRunningSnapshot = isRunning,
    expectedRunGeneration?: number,
    runCallbacks = callbacks
): Promise<void> {
    try {
        const progress = await getStatus();
        // A terminal status read can yield while a re-entrant caller starts a
        // new scan. Do not let this old run publish its snapshot or callback
        // into the new run's state.
        if (expectedRunGeneration !== undefined && scannerRunGeneration !== expectedRunGeneration) {
            return;
        }
        const finalProgress = {
            ...progress,
            isRunning: isRunningSnapshot,
        };
        useScannerStore.getState().setProgress(finalProgress);
        runCallbacks.onProgress?.(finalProgress);
    } catch {
        // The original scan error/cancellation should still be surfaced even
        // if this best-effort status refresh is blocked by a simultaneous
        // permission or database change.
        console.warn('[AIScanner] Failed to publish current status.');
    }
}

/**
 * Publish the terminal state only after the scanner's running flag has been
 * cleared. This keeps callbacks and the Zustand snapshot consistent, while
 * avoiding a stale final status if an onProgress callback starts another run.
 */
async function finalizeScannerRun(
    runGeneration: number,
    runCallbacks: ScannerCallbacks
): Promise<void> {
    isFinalizing = true;
    useScannerStore.getState().setIsFinalizing(true);
    isRunning = false;
    useScannerStore.getState().setIsRunning(false);
    try {
        await reportCurrentStatus(false, runGeneration, runCallbacks);
    } finally {
        isFinalizing = false;
        useScannerStore.getState().setIsFinalizing(false);
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the scanner
 */
export async function start(cbs?: ScannerCallbacks): Promise<void> {
    if (isRunning || isFinalizing) {
        console.log('[AIScanner] Already running.');
        return;
    }

    const releaseOperation = acquireRecordOperation('scanner');
    if (!releaseOperation) return;
    useScannerStore.getState().setTask('scan');
    console.log('[AIScanner] Starting scan...');
    isRunning = true;
    shouldStop = false;
    currentBatch = 0;
    const runCallbacks = cbs ?? {};
    callbacks = runCallbacks;
    const runGeneration = ++scannerRunGeneration;
    resetMLFailureState();
    let completed = false;

    useScannerStore.getState().setIsFinalizing(false);
    useScannerStore.getState().setIsRunning(true);

    try {
        // Sync assets from media library
        const accessibleAssetIds = await syncAssetsToDatabase();
        if (shouldStop) return;

        if (accessibleAssetIds === null) {
            // A previous limited scan may have left duplicate recovery assets
            // and singleton seeds whose comparisons were outside its
            // permission scope. A complete sync is the first point at which
            // those rows are safe to revisit and reconnect.
            const recoveryAssets = await AssetRepository.resetDuplicateRecoveryAssets();
            if (recoveryAssets.length > 0) {
                console.log(`[AIScanner] Requeued ${recoveryAssets.length} duplicate recovery assets.`);
            }
        }

        const scanAssetIds = accessibleAssetIds ? Array.from(accessibleAssetIds) : undefined;

        // Reset outdated assets
        await resetOutdatedAssets(scanAssetIds, accessibleAssetIds !== null);
        if (shouldStop) return;

        // A previous run can be interrupted after marking an asset PENDING
        // but before persisting the rewind requested by the sync. Only the
        // unscoped incremental path uses the cursor; bounded scans choose an
        // explicit work set and therefore do not need this query.
        if (scanAssetIds === undefined) {
            await rewindCursorForPendingAssets();
            if (shouldStop) return;
        }

        // Report initial progress
        await reportProgress(scanAssetIds);

        // Process batches until done or stopped
        while (!shouldStop) {
            const hasMore = await processBatch(
                BATCH_SIZE,
                scanAssetIds,
                scanAssetIds,
                scanAssetIds !== undefined,
                accessibleAssetIds !== null
            );
            await reportProgress(scanAssetIds);

            if (!hasMore) {
                break;
            }
        }

        if (shouldStop) {
            console.log('[AIScanner] Scan stopped.');
        } else {
            console.log('[AIScanner] Scan complete.');
            completed = true;
        }
    } catch (error) {
        console.error('[AIScanner] Scan failed.');
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        useScannerStore.getState().setLastError(error instanceof Error ? error : new Error(String(error)));
        if (!shouldStop) {
            await reportCurrentStatus();
        }
    } finally {
        try { await finalizeScannerRun(runGeneration, runCallbacks); }
        finally { releaseOperation(); }
    }

    if (completed) {
        try {
            runCallbacks.onComplete?.();
        } catch (error) {
            const completionError = error instanceof Error ? error : new Error(String(error));
            console.error('[AIScanner] Completion callback failed.');
            runCallbacks.onError?.(completionError);
            if (scannerRunGeneration === runGeneration) {
                useScannerStore.getState().setLastError(completionError);
            }
        }
    }
}

/**
 * Stop the scanner
 */
export function stop(): void {
    console.log('[AIScanner] Stopping...');
    shouldStop = true;
}

/**
 * Resume scanning for one batch only
 */
export async function resumeOnce(
    options?: ScanBatchOptions,
    cbs?: ScannerCallbacks
): Promise<void> {
    if (isRunning || isFinalizing) {
        console.log('[AIScanner] Already running.');
        return;
    }

    const releaseOperation = acquireRecordOperation('scanner');
    if (!releaseOperation) return;
    useScannerStore.getState().setTask('scan');
    console.log('[AIScanner] Resuming for one batch...');
    isRunning = true;
    shouldStop = false;
    currentBatch = 0;
    const runCallbacks = cbs ?? {};
    callbacks = runCallbacks;
    const runGeneration = ++scannerRunGeneration;
    resetMLFailureState();
    let completed = false;

    useScannerStore.getState().setIsFinalizing(false);
    useScannerStore.getState().setIsRunning(true);

    try {
        // Refresh the local index so a batch scan sees newly added photos and
        // removes records for assets deleted outside the app.
        const accessibleAssetIds = await syncAssetsToDatabase();
        if (shouldStop) return;

        const visiblePhotoIds = accessibleAssetIds
            ? Array.from(accessibleAssetIds)
            : undefined;

        let assetIds: string[] | undefined;
        if (options?.mode === 'album') {
            assetIds = await getPhotoAssetIdsForAlbums(options.albumIds ?? []);
            if (shouldStop) return;
        }

        if (accessibleAssetIds) {
            if (assetIds) {
                assetIds = assetIds.filter(assetId => accessibleAssetIds.has(assetId));
            } else {
                assetIds = Array.from(accessibleAssetIds);
            }
        }

        const requestedCount = options?.mode === 'count' ? options.count ?? BATCH_SIZE : BATCH_SIZE;
        const batchSize = Math.max(1, Math.min(Math.floor(requestedCount), 1000));

        // resumeOnce is always bounded to one batch. Choose that exact work
        // set before resetting errors/outdated results; otherwise a scoped
        // album (or the default batch) could invalidate every matching result
        // while only the first batch is processed.
        const currentAlgoVersion = await MetaRepository.getGlobalAlgoVersion();
        const candidates = await AssetRepository.getScanCandidateBatch(
            currentAlgoVersion,
            batchSize,
            assetIds,
            accessibleAssetIds === null
        );
        assetIds = candidates.map(asset => asset.asset_id);

        const retried = await AssetRepository.resetErrors(assetIds);
        if (retried > 0) {
            // Failed assets may be older than the persisted cursor. Rewind so
            // the explicit retry action cannot skip them.
            await MetaRepository.resetScanCursor();
            console.log(`[AIScanner] Retrying ${retried} previously failed assets.`);
        }

        // Reset outdated assets
        await resetOutdatedAssets(assetIds, accessibleAssetIds !== null);
        if (shouldStop) return;

        if (accessibleAssetIds === null) {
            // Only a full-permission retry may widen the media scope. The
            // candidate query includes current DONE recovery rows so this
            // reset stays bounded to the exact one-batch work set.
            const recoveryAssets = await AssetRepository.resetDuplicateRecoveryAssets(assetIds);
            if (recoveryAssets.length > 0) {
                console.log(`[AIScanner] Requeued ${recoveryAssets.length} duplicate recovery assets.`);
            }
        }

        // Process one batch
        await processBatch(
            batchSize,
            assetIds,
            visiblePhotoIds,
            true,
            accessibleAssetIds !== null
        );
        await reportProgress(visiblePhotoIds);

        if (shouldStop) {
            console.log('[AIScanner] One batch stopped.');
        } else {
            console.log('[AIScanner] One batch complete.');
            completed = true;
        }
    } catch (error) {
        console.error('[AIScanner] Resume failed.');
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        useScannerStore.getState().setLastError(error instanceof Error ? error : new Error(String(error)));
        if (!shouldStop) {
            await reportCurrentStatus();
        }
    } finally {
        try { await finalizeScannerRun(runGeneration, runCallbacks); }
        finally { releaseOperation(); }
    }

    if (completed) {
        try {
            runCallbacks.onComplete?.();
        } catch (error) {
            const completionError = error instanceof Error ? error : new Error(String(error));
            console.error('[AIScanner] Completion callback failed.');
            runCallbacks.onError?.(completionError);
            if (scannerRunGeneration === runGeneration) {
                useScannerStore.getState().setLastError(completionError);
            }
        }
    }
}

/**
 * Get current scanner status
 */
export async function getStatus(): Promise<ScanProgress> {
    const visiblePhotoIds = await getVisiblePhotoIdsForStatus();
    const counts = await AssetRepository.getStatusCounts(
        visiblePhotoIds ? Array.from(visiblePhotoIds) : undefined
    );
    return {
        totalPending: counts.pending,
        totalDone: counts.done,
        totalError: counts.error,
        currentBatch,
        isRunning,
    };
}

/**
 * Reset scan cursor to start from beginning
 */
export async function resetCursor(): Promise<void> {
    if (isRecordTransferActive()) throw new Error('Record transfer is in progress');
    await MetaRepository.resetScanCursor();
    console.log('[AIScanner] Cursor reset.');
}

/**
 * Reset ALL progress (Cursor + Database Status)
 */
export async function resetAllProgress(): Promise<void> {
    if (isRecordTransferActive()) throw new Error('Record transfer is in progress');
    if (isRunning || isFinalizing) {
        stop();
        const deadline = Date.now() + 30000;
        while ((isRunning || isFinalizing) && Date.now() < deadline) {
            await yieldToMainThread();
        }

        if (isRunning || isFinalizing) {
            throw new Error('Scanner did not stop in time; progress was not reset.');
        }
    }
    const release = acquireRecordOperation('scanner');
    if (!release) throw new Error('Another record operation is in progress');
    try {
        await AssetRepository.resetAll();
        useScannerStore.getState().setClassificationProgress({ pending: 0, done: 0, error: 0 });
        currentBatch = 0;
    } finally { release(); }
    console.log('[AIScanner] Full progress reset.');
}

/**
 * Check if scanner is currently running
 */
export function isScanning(): boolean {
    return isRunning || isFinalizing;
}

export async function getClassificationStatus() {
    const visible = await getVisiblePhotoIdsForStatus();
    const { useSettingsStore } = await import('../../stores/useSettingsStore');
    const albums = useSettingsStore.getState().selectedAlbumIds ?? [];
    let scope = albums.length ? await getPhotoAssetIdsForAlbums(albums) : undefined;
    if (visible) scope = (scope ?? [...visible]).filter(id => visible.has(id));
    return AIAnalysisRepository.getCounts(scope);
}

/** Explicit AI backfill/retry, never an automatic side effect of enabling AI. */
export async function startClassification(errorsOnly = false): Promise<void> {
    if (isRunning || isFinalizing) return;
    const { useSettingsStore } = await import('../../stores/useSettingsStore');
    if (!useSettingsStore.getState().enableAIClassification) return;
    const releaseOperation = acquireRecordOperation('scanner');
    if (!releaseOperation) return;
    const store = useScannerStore.getState();
    isRunning = true; shouldStop = false; currentBatch = 0;
    callbacks = {};
    const generation = ++scannerRunGeneration;
    resetMLFailureState();
    store.setTask('classification'); store.setLastError(null); store.setIsRunning(true);
    try {
        const visible = await syncAssetsToDatabase();
        if (shouldStop) return;
        const albums = useSettingsStore.getState().selectedAlbumIds ?? [];
        let scope = albums.length ? await getPhotoAssetIdsForAlbums(albums) : undefined;
        if (visible) scope = (scope ?? [...visible]).filter(id => visible.has(id));
        // Snapshot the work set once: errors are retried on user request,
        // not immediately requeued into an endless failure loop.
        const ids = await AIAnalysisRepository.getCandidates(scope, errorsOnly);
        store.setClassificationProgress(await getClassificationStatus());
        for (const id of ids) {
            await waitForInteractions();
            if (shouldStop) break;
            const before = await AIAnalysisRepository.getCounts([id]);
            await processAIForAsset(id);
            const after = await AIAnalysisRepository.getCounts([id]);
            const progress = useScannerStore.getState().classificationProgress;
            store.setClassificationProgress({
                pending: Math.max(0, progress.pending + after.pending - before.pending),
                done: Math.max(0, progress.done + after.done - before.done),
                error: Math.max(0, progress.error + after.error - before.error),
            });
            await yieldToMainThread();
            if (mlCircuitBreakerTripped) {
                store.setLastError(new Error('AI analysis paused after repeated failures; base results were preserved'));
                break;
            }
        }
    } catch {
        store.setLastError(new Error('AI backfill could not finish; existing results were preserved'));
    } finally {
        try {
            // Reconcile changes outside this work set only once at completion.
            try { store.setClassificationProgress(await getClassificationStatus()); } catch { /* Keep the last known progress. */ }
            await finalizeScannerRun(generation, {});
        }
        finally { releaseOperation(); }
    }
}
