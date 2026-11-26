import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type * as MediaLibrary from 'expo-media-library';
import { buildContentFingerprint } from './backup/payload';

export interface SimilarGroupAssetDescriptor {
    id?: string;
    filename?: string;
    mediaType?: MediaLibrary.MediaTypeValue | string;
    width?: number;
    height?: number;
    creationTime?: number | null;
    duration?: number;
}

/**
 * Privacy-preserving, device-independent key for a similar photo group built
 * from the sorted unique member content base signatures (`filename + dimensions
 * + mediaType + durationTenths`, SHA-256 hashed). Because it omits device-local
 * asset IDs and group IDs, it matches identically across rescans AND across
 * Android/iOS v2 encrypted backup restores.
 */
export function buildSimilarGroupContentKey(
    assets: readonly SimilarGroupAssetDescriptor[],
): string | null {
    const signatures: string[] = [];
    for (const item of assets) {
        if (
            !item?.filename
            || typeof item.filename !== 'string'
            || !item.filename.trim()
            || typeof item.width !== 'number' || !Number.isFinite(item.width) || item.width <= 0
            || typeof item.height !== 'number' || !Number.isFinite(item.height) || item.height <= 0
        ) {
            continue;
        }
        try {
            const fp = buildContentFingerprint({
                id: item.id ?? '',
                filename: item.filename,
                uri: '',
                mediaType: (item.mediaType === 'video' ? 'video' : 'photo') as MediaLibrary.MediaTypeValue,
                width: item.width,
                height: item.height,
                creationTime: typeof item.creationTime === 'number' && Number.isFinite(item.creationTime) ? item.creationTime : 0,
                modificationTime: 0,
                duration: typeof item.duration === 'number' && Number.isFinite(item.duration) ? item.duration : 0,
            } as MediaLibrary.Asset, null);
            signatures.push(fp.baseSignature);
        } catch {
            // Skip incomplete metadata entries.
        }
    }
    const sorted = Array.from(new Set(signatures)).sort();
    if (sorted.length < 2) return null;
    const digest = bytesToHex(
        sha256(new TextEncoder().encode(JSON.stringify(['similar-group-content-v1', sorted]))),
    );
    return `sgc1:${digest}`;
}

/**
 * Fallback deterministic group key built from sorted unique asset IDs when
 * filenames/dimensions are unavailable.
 */
export function buildSimilarGroupIdKey(assetIds: readonly string[]): string | null {
    const sorted = Array.from(
        new Set(assetIds.filter(id => typeof id === 'string' && id.trim().length > 0)),
    ).sort();
    if (sorted.length < 2) return null;
    const digest = bytesToHex(
        sha256(new TextEncoder().encode(JSON.stringify(['similar-group-ids-v1', sorted]))),
    );
    return `sgi1:${digest}`;
}

export interface SimilarGroupKeyInput {
    snapshotKey?: string | null;
    assets?: readonly SimilarGroupAssetDescriptor[];
    assetIds?: readonly string[];
}

/**
 * Collect all stable keys that identify a similar group locally and across
 * devices:
 * - `snapshotKey`: device-local SQLCipher snapshot hash (backwards compatible)
 * - `sgc1:...`: cross-device content-fingerprint hash of sorted members
 * - `sgi1:...`: sorted-ID fallback when neither snapshotKey nor contentKey exists
 */
export function collectSimilarGroupIgnoreKeys(input: SimilarGroupKeyInput): string[] {
    const keys: string[] = [];
    const trimmedSnapshot = typeof input.snapshotKey === 'string' ? input.snapshotKey.trim() : '';
    if (trimmedSnapshot) {
        keys.push(trimmedSnapshot);
    }
    const contentKey = input.assets ? buildSimilarGroupContentKey(input.assets) : null;
    if (contentKey) {
        keys.push(contentKey);
    }
    if (keys.length === 0 && input.assetIds) {
        const idKey = buildSimilarGroupIdKey(input.assetIds);
        if (idKey) keys.push(idKey);
    }
    return Array.from(new Set(keys));
}

export function isSimilarGroupIgnored(
    ignoredKeys: ReadonlySet<string>,
    input: SimilarGroupKeyInput,
): boolean {
    if (ignoredKeys.size === 0) return false;
    const trimmedSnapshot = typeof input.snapshotKey === 'string' ? input.snapshotKey.trim() : '';
    if (trimmedSnapshot && ignoredKeys.has(trimmedSnapshot)) return true;
    const contentKey = input.assets ? buildSimilarGroupContentKey(input.assets) : null;
    if (contentKey && ignoredKeys.has(contentKey)) return true;
    const idKey = input.assetIds ? buildSimilarGroupIdKey(input.assetIds) : null;
    if (idKey && ignoredKeys.has(idKey)) return true;
    return false;
}
