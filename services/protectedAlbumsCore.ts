import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

const PROTECTED_ENUM_PAGE_SIZE = 200;

export interface ProtectedAlbumsSnapshot {
    assetIds: Set<string>;
    missingAlbumIds: string[];
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
 * media types, verifying album existence via `getAlbumsAsync` FIRST so iOS
 * never falls back to scanning the entire photo library when an album has been
 * deleted externally. Also returns `missingAlbumIds` (deleted on iOS or
 * deleted/renamed on Android) so UI can warn and allow individual removal.
 */
export async function fetchProtectedAlbumsSnapshot(
    albumIds: readonly string[],
    mediaTypes: readonly ('photo' | 'video')[] = ['photo', 'video'],
): Promise<ProtectedAlbumsSnapshot> {
    const uniqueAlbumIds = Array.from(new Set(albumIds.filter(id => typeof id === 'string' && id.length > 0)));
    const assetIds = new Set<string>();
    if (uniqueAlbumIds.length === 0) {
        return { assetIds, missingAlbumIds: [] };
    }

    const grantedMediaTypes: ('photo' | 'video')[] = [];
    for (const mediaType of mediaTypes) {
        const permission = await MediaLibrary.getPermissionsAsync(false, [mediaType]);
        if (!permission.granted) continue;
        if (Platform.OS === 'ios' && permission.accessPrivileges !== 'all') {
            throw new Error('Full photo-library access is required to verify protected albums on iOS');
        }
        grantedMediaTypes.push(mediaType);
    }

    if (grantedMediaTypes.length === 0) {
        return { assetIds, missingAlbumIds: [] };
    }

    const existingAlbums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    const existingAlbumIds = new Set(existingAlbums.map(album => album.id));
    const presentAlbumIds: string[] = [];
    const missingAlbumIds: string[] = [];
    for (const albumId of uniqueAlbumIds) {
        if (existingAlbumIds.has(albumId)) {
            presentAlbumIds.push(albumId);
        } else {
            missingAlbumIds.push(albumId);
        }
    }

    if (presentAlbumIds.length === 0) {
        return { assetIds, missingAlbumIds };
    }

    for (const mediaType of grantedMediaTypes) {
        for (const albumId of presentAlbumIds) {
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

    if (Platform.OS === 'ios') {
        // Guard against an album disappearing mid-enumeration on iOS, which
        // causes native getAssetsAsync to fall back to an unscoped library fetch.
        const postAlbums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
        const postAlbumIds = new Set(postAlbums.map(album => album.id));
        if (presentAlbumIds.some(albumId => !postAlbumIds.has(albumId))) {
            throw new Error('Protected album disappeared during iOS enumeration');
        }
    }

    return { assetIds, missingAlbumIds };
}

/**
 * Enumerate every asset ID inside the given protected albums for the specified
 * media types. Fails closed by throwing when enumeration fails or cursors loop.
 */
export async function fetchProtectedAssetIdsForAlbums(
    albumIds: readonly string[],
    mediaTypes: readonly ('photo' | 'video')[] = ['photo', 'video'],
): Promise<Set<string>> {
    const { assetIds } = await fetchProtectedAlbumsSnapshot(albumIds, mediaTypes);
    return assetIds;
}

/**
 * Layer-3 final defense directly before `MediaLibrary.deleteAssetsAsync`.
 * Performs a fresh authoritative check of every protected album's membership.
 * When live enumeration succeeds, uses the live result (so removing an album
 * or moving a photo out of a protected album is honored immediately without
 * being permanently locked by stale cache). If protected albums are configured
 * and live verification throws for any reason, fails closed by blocking all
 * remaining candidates (including any cached protected IDs).
 */
export async function resolveProtectedIdsBeforeDeletion(
    protectedAlbumIds: ReadonlySet<string>,
    cachedProtectedAssetIds: ReadonlySet<string>,
    candidates: readonly { id: string; albumId?: string }[],
    mediaType: 'photo' | 'video',
): Promise<Set<string>> {
    const blocked = new Set<string>();
    if (candidates.length === 0 || protectedAlbumIds.size === 0) {
        return blocked;
    }

    const remaining: { id: string; albumId?: string }[] = [];
    for (const candidate of candidates) {
        if (
            typeof candidate.albumId === 'string'
            && candidate.albumId.length > 0
            && protectedAlbumIds.has(candidate.albumId)
        ) {
            blocked.add(candidate.id);
        } else {
            remaining.push(candidate);
        }
    }

    if (remaining.length === 0) {
        return blocked;
    }

    try {
        const { assetIds: freshProtectedIds } = await fetchProtectedAlbumsSnapshot(
            Array.from(protectedAlbumIds),
            [mediaType],
        );
        for (const candidate of remaining) {
            if (freshProtectedIds.has(candidate.id)) {
                blocked.add(candidate.id);
            }
        }
    } catch {
        // Fail-closed: protected albums exist, but live verification failed.
        // Block remaining candidates (and any cached protected IDs) instead of deleting.
        for (const candidate of remaining) {
            if (cachedProtectedAssetIds.has(candidate.id) || protectedAlbumIds.size > 0) {
                blocked.add(candidate.id);
            }
        }
    }

    return blocked;
}
