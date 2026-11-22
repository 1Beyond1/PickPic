import * as MediaLibrary from 'expo-media-library';
import {
    ProtectedAlbumRepository,
    type ProtectedAlbumRecord,
} from '../database/repositories/ProtectedAlbumRepository';
import { recordBackupChanges } from './backup/changeTracker';

export type { ProtectedAlbumRecord };

const PROTECTED_ENUM_PAGE_SIZE = 200;

export function loadProtectedAlbums(): Promise<ProtectedAlbumRecord[]> {
    return ProtectedAlbumRepository.getAll();
}

export async function saveProtectedAlbums(
    albums: readonly { albumId: string; title: string; createdAt?: number }[],
): Promise<ProtectedAlbumRecord[]> {
    const saved = await ProtectedAlbumRepository.replaceAll(albums);
    void recordBackupChanges(1);
    return saved;
}

export function mergeProtectedAlbums(
    albums: readonly { albumId: string; title: string; createdAt?: number }[],
): Promise<number> {
    return ProtectedAlbumRepository.mergeAlbums(albums);
}

export function isAssetProtected(
    asset: { id: string; albumId?: string } | null | undefined,
    protectedAlbumIds: ReadonlySet<string>,
    protectedAssetIds: ReadonlySet<string>,
): boolean {
    if (!asset || !asset.id) return false;
    if (protectedAssetIds.has(asset.id)) return true;
    if (typeof asset.albumId === 'string' && asset.albumId.length > 0 && protectedAlbumIds.has(asset.albumId)) {
        return true;
    }
    return false;
}

/**
 * Enumerate every asset ID inside the given protected albums for the specified
 * media types. Fails closed by throwing when enumeration fails or cursors loop.
 */
export async function fetchProtectedAssetIdsForAlbums(
    albumIds: readonly string[],
    mediaTypes: readonly ('photo' | 'video')[] = ['photo', 'video'],
): Promise<Set<string>> {
    const uniqueAlbumIds = Array.from(new Set(albumIds.filter(id => typeof id === 'string' && id.length > 0)));
    const assetIds = new Set<string>();
    if (uniqueAlbumIds.length === 0) return assetIds;

    for (const mediaType of mediaTypes) {
        const permission = await MediaLibrary.getPermissionsAsync(false, [mediaType]);
        if (!permission.granted) continue;

        for (const albumId of uniqueAlbumIds) {
            const seenCursors = new Set<string>();
            let after: string | undefined;
            while (true) {
                const page = await MediaLibrary.getAssetsAsync({
                    album: albumId,
                    mediaType,
                    first: PROTECTED_ENUM_PAGE_SIZE,
                    ...(after ? { after } : {}),
                });
                for (const asset of page.assets) {
                    if (asset?.id) assetIds.add(asset.id);
                }
                if (!page.hasNextPage) break;
                if (!page.endCursor || seenCursors.has(page.endCursor)) {
                    throw new Error('Invalid pagination cursor while reading protected album');
                }
                seenCursors.add(page.endCursor);
                after = page.endCursor;
            }
        }
    }

    return assetIds;
}

/**
 * Layer-3 final defense directly before `MediaLibrary.deleteAssetsAsync`.
 * Performs a fresh authoritative check of every protected album's membership.
 * If protected albums are configured and verification fails for any reason,
 * fails closed by blocking all remaining candidates so no protected original
 * can ever be deleted.
 */
export async function resolveProtectedIdsBeforeDeletion(
    protectedAlbumIds: ReadonlySet<string>,
    cachedProtectedAssetIds: ReadonlySet<string>,
    candidates: readonly { id: string; albumId?: string }[],
    mediaType: 'photo' | 'video',
): Promise<Set<string>> {
    const blocked = new Set<string>();
    if (candidates.length === 0) return blocked;
    if (protectedAlbumIds.size === 0 && cachedProtectedAssetIds.size === 0) {
        return blocked;
    }

    const remaining: { id: string; albumId?: string }[] = [];
    for (const candidate of candidates) {
        if (isAssetProtected(candidate, protectedAlbumIds, cachedProtectedAssetIds)) {
            blocked.add(candidate.id);
        } else {
            remaining.push(candidate);
        }
    }

    if (remaining.length === 0 || protectedAlbumIds.size === 0) {
        return blocked;
    }

    try {
        const freshProtectedIds = await fetchProtectedAssetIdsForAlbums(
            Array.from(protectedAlbumIds),
            [mediaType],
        );
        for (const candidate of remaining) {
            if (freshProtectedIds.has(candidate.id)) {
                blocked.add(candidate.id);
            }
        }
    } catch {
        // Fail-closed: protected albums exist, but we could not verify whether
        // remaining candidates belong to them. Block them instead of deleting.
        for (const candidate of remaining) {
            blocked.add(candidate.id);
        }
    }

    return blocked;
}
