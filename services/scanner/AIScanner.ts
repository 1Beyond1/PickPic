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

import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { InteractionManager } from 'react-native';

import {
    AssetRepository,
    AssetStatus,
    DupGroupRepository,
    GLOBAL_ALGO_VERSION,
    MetaRepository,
} from '../../database';
import { getImageOps, GrayImageRef } from '../imageOps';
import { selectBestShot } from './BestShotSelector';
import { findSimilarPhotos } from './SimilarityMatcher';

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
let shouldStop = false;
let currentBatch = 0;
let callbacks: ScannerCallbacks = {};

const BATCH_SIZE = 20;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Yield to main thread using setTimeout(0)
 */
function yieldToMainThread(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
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
async function getFileSignature(uri: string): Promise<string> {
    try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && !info.isDirectory) {
            return `${info.modificationTime ?? 0}_${info.size ?? 0}`;
        }
    } catch {
        // Ignore errors
    }
    return '';
}

/**
 * Generate unique group ID
 */
function generateGroupId(): string {
    return `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Sync Functions
// ============================================================================

/**
 * Sync media library assets to database
 */
async function syncAssetsToDatabase(): Promise<void> {
    console.log('[AIScanner] Syncing assets to database...');

    let hasMore = true;
    let cursor: string | undefined;
    let synced = 0;

    while (hasMore) {
        const result = await MediaLibrary.getAssetsAsync({
            mediaType: 'photo',
            first: 100,
            after: cursor,
            sortBy: [['creationTime', true]], // Ascending by creation time
        });

        for (const asset of result.assets) {
            // Check if asset exists and signature changed
            const signature = await getFileSignature(asset.uri);
            const existing = await AssetRepository.getById(asset.id);

            if (existing) {
                // Check for signature change
                await AssetRepository.resetIfSignatureChanged(asset.id, signature);
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
            }
        }

        hasMore = result.hasNextPage;
        cursor = result.endCursor;

        // Yield periodically
        if (synced % 500 === 0) {
            await yieldToMainThread();
        }
    }

    console.log(`[AIScanner] Synced ${synced} new assets.`);
}

/**
 * Reset outdated assets (algo_version mismatch)
 */
async function resetOutdatedAssets(): Promise<void> {
    const globalVersion = await MetaRepository.getGlobalAlgoVersion();
    const reset = await AssetRepository.resetOutdatedAssets(globalVersion);

    if (reset > 0) {
        console.log(`[AIScanner] Reset ${reset} outdated assets.`);
    }
}

// ============================================================================
// Scan Functions
// ============================================================================

/**
 * Process a single asset
 */
async function processAsset(assetId: string): Promise<boolean> {
    const imageOps = getImageOps();
    let gray: GrayImageRef | null = null;

    try {
        // Get asset info from media library
        const assetInfo = await MediaLibrary.getAssetInfoAsync(assetId);
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

        // Initialize global failure count if needed
        // @ts-ignore
        if (typeof global.mlFailureCount === 'undefined') {
            // @ts-ignore
            global.mlFailureCount = 0;
        }

        // ML Circuit Breaker
        // If ML features fail too many times, disable them for the rest of the session
        let mlEnabled = true;
        // @ts-ignore
        if (global.mlFailureCount > 3) {
            // @ts-ignore
            if (global.mlFailureCount === 4) {
                console.warn('[AIScanner] ML Circuit Breaker tripped. Disabling ML for this session.');
                // @ts-ignore
                global.mlFailureCount++; // Increment once more to avoid spamming logs
            }
            mlEnabled = false;
        }

        // Phase 2: Context-Aware ML Scanning (Merged Face & Object Detection)
        let labelsJson: string | null = null;
        let faceCount = 0;

        // Check if AI classification is enabled in settings (default: OFF)
        const { useSettingsStore } = await import('../../stores/useSettingsStore');
        const enableAIClassification = useSettingsStore.getState().enableAIClassification;

        // Only run ML if: enabled + circuit breaker not tripped
        if (mlEnabled && enableAIClassification) {
            try {
                const { MLKitService } = await import('../ml/MLKitService');
                if (MLKitService.isAvailable()) {
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
                    } catch (e) {
                        console.warn('[AIScanner] Crop failed, using original:', e);
                    }

                    const labels = await MLKitService.labelImage(labelingUri);

                    // Clean up temporary crop file
                    if (isCropped) {
                        FileSystem.deleteAsync(labelingUri, { idempotent: true }).catch(() => { });
                    }

                    if (labels.length > 0) {
                        labelsJson = JSON.stringify(labels);
                        console.log(`[AIScanner] Detected objects in ${assetId}:`, labels.map(l => l.text).join(', '));
                    }

                    // Phase 2b: Face Detection (Context-Aware)
                    const rawFaces = await MLKitService.detectFaces(uri);

                    // Filter 1: Size Filter (Ignore tiny faces like icons/ads)
                    const imgWidth = assetInfo.width || 1000;
                    const MIN_Face_RATIO = 0.1; // Face must be 10% of image width
                    let validFaces = rawFaces.filter(f => {
                        // Check bounding box width (ML Kit returns 'width')
                        return (f.boundingBox?.width || 0) > (imgWidth * MIN_Face_RATIO);
                    });

                    // Filter 2: Context Disqualifier (Ignore faces in Screenshots/Websites)
                    const DISQUALIFIERS = new Set(['web site', 'website', 'monitor', 'screen', 'computer screen', 'screenshot', 'comic book', 'menu', 'display']);
                    const topLabel = labels.length > 0 ? labels[0].text.toLowerCase() : '';
                    // Also check if ANY high-confidence label is a disqualifier
                    const isContextDisqualified = labels.some(l => l.confidence > 0.4 && DISQUALIFIERS.has(l.text.toLowerCase()));

                    if (isContextDisqualified) {
                        console.log(`[AIScanner] Context Disqualifier Triggered: ${topLabel}. Ignoring ${validFaces.length} faces.`);
                        faceCount = 0;
                    } else {
                        faceCount = validFaces.length;
                    }

                    if (faceCount > 0) {
                        console.log(`[AIScanner] Detected ${faceCount} Valid Face(s) (Raw: ${rawFaces.length})`);
                    }

                    // Reset failure count on success
                    // @ts-ignore
                    global.mlFailureCount = 0;
                }
            } catch (mlError) {
                console.warn(`[AIScanner] ML Kit object detection failed for ${assetId}:`, mlError);
                // @ts-ignore
                global.mlFailureCount = (global.mlFailureCount || 0) + 1;
            }
        }

        // Mark as done (with face count)
        await AssetRepository.markDone(assetId, blurScore, meanLuma, phash, GLOBAL_ALGO_VERSION);

        // Update face count and labels if detected
        const db = await import('../../database').then(m => m.getDatabase());
        if (faceCount > 0 || labelsJson) {
            await db.runAsync(
                'UPDATE assets SET face_count = ?, labels_json = ? WHERE asset_id = ?',
                [faceCount, labelsJson, assetId]
            );
        }

        // Find similar photos
        const asset = await AssetRepository.getById(assetId);
        if (asset && asset.taken_at) {
            const matches = await findSimilarPhotos(phash, asset.taken_at);

            if (matches.length > 0) {
                // Check if any match is already in a group
                let targetGroupId: string | null = null;

                for (const match of matches) {
                    const existingGroupId = await DupGroupRepository.findGroupByAssetId(match.assetId);
                    if (existingGroupId) {
                        targetGroupId = existingGroupId;
                        break;
                    }
                }

                if (!targetGroupId) {
                    // Create new group with first match as representative
                    targetGroupId = generateGroupId();
                    await DupGroupRepository.createGroup(targetGroupId, matches[0].assetId);
                    await DupGroupRepository.addMember(targetGroupId, matches[0].assetId, 0);
                }

                // Add current asset to group
                const closestMatch = matches[0];
                await DupGroupRepository.addMember(targetGroupId, assetId, closestMatch.distance);

                // Recalculate best shot
                await selectBestShot(targetGroupId);
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
        await AssetRepository.markError(assetId, errorMessage);

        console.warn(`[AIScanner] Failed to process asset ${assetId}:`, errorMessage);
        return false;
    }
}

/**
 * Process a batch of assets
 */
async function processBatch(): Promise<boolean> {
    // Get cursor
    const cursor = await MetaRepository.getScanCursor();

    // Get pending batch
    const batch = await AssetRepository.getPendingBatch(
        cursor.takenAt,
        cursor.assetId,
        BATCH_SIZE
    );

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

        // Process asset
        const success = await processAsset(asset.asset_id);

        // Yield after each asset
        await yieldToMainThread();

        // Notify progress
        callbacks.onAssetScanned?.(asset.asset_id, success);
        useScannerStore.getState().incrementProgress(success);

        // Update cursor
        if (asset.taken_at !== null) {
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
async function reportProgress(): Promise<void> {
    const counts = await AssetRepository.getStatusCounts();
    const progress = {
        totalPending: counts.pending,
        totalDone: counts.done,
        totalError: counts.error,
        currentBatch,
        isRunning,
    };
    callbacks.onProgress?.(progress);
    useScannerStore.getState().setProgress(progress);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the scanner
 */
export async function start(cbs?: ScannerCallbacks): Promise<void> {
    if (isRunning) {
        console.log('[AIScanner] Already running.');
        return;
    }

    console.log('[AIScanner] Starting scan...');
    isRunning = true;
    shouldStop = false;
    currentBatch = 0;
    callbacks = cbs ?? {};

    useScannerStore.getState().setIsRunning(true);

    try {
        // Sync assets from media library
        await syncAssetsToDatabase();

        // Reset outdated assets
        await resetOutdatedAssets();

        // Report initial progress
        await reportProgress();

        // Process batches until done or stopped
        while (!shouldStop) {
            const hasMore = await processBatch();
            await reportProgress();

            if (!hasMore) {
                break;
            }
        }

        console.log('[AIScanner] Scan complete.');
        callbacks.onComplete?.();
    } catch (error) {
        console.error('[AIScanner] Scan error:', error);
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        useScannerStore.getState().setLastError(error instanceof Error ? error : new Error(String(error)));
    } finally {
        isRunning = false;
        useScannerStore.getState().setIsRunning(false);
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
export async function resumeOnce(cbs?: ScannerCallbacks): Promise<void> {
    if (isRunning) {
        console.log('[AIScanner] Already running.');
        return;
    }

    console.log('[AIScanner] Resuming for one batch...');
    isRunning = true;
    shouldStop = false;
    callbacks = cbs ?? {};

    useScannerStore.getState().setIsRunning(true);

    try {
        // Reset outdated assets
        await resetOutdatedAssets();

        // Process one batch
        await processBatch();
        await reportProgress();

        console.log('[AIScanner] One batch complete.');
        callbacks.onComplete?.();
    } catch (error) {
        console.error('[AIScanner] Resume error:', error);
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        useScannerStore.getState().setLastError(error instanceof Error ? error : new Error(String(error)));
    } finally {
        isRunning = false;
        useScannerStore.getState().setIsRunning(false);
    }
}

/**
 * Get current scanner status
 */
export async function getStatus(): Promise<ScanProgress> {
    const counts = await AssetRepository.getStatusCounts();
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
    await MetaRepository.resetScanCursor();
    console.log('[AIScanner] Cursor reset.');
}

/**
 * Reset ALL progress (Cursor + Database Status)
 */
export async function resetAllProgress(): Promise<void> {
    if (isRunning) {
        stop();
        await yieldToMainThread();
    }
    await MetaRepository.resetScanCursor();
    await AssetRepository.resetAll();
    await DupGroupRepository.deleteAll();
    console.log('[AIScanner] Full progress reset.');
}

/**
 * Check if scanner is currently running
 */
export function isScanning(): boolean {
    return isRunning;
}
