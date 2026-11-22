import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { mediaDateQuery, mediaMatchesDate } from './mediaMonth';
import type { MediaDateFilter } from './mediaMonth';
import { readMediaSizes, supportsIndexedMediaSizes } from './mediaSizes';

export interface OrganizingSizeStats { knownCount: number; unknownCount: number }
export class MediaSizeReadError extends Error {
    constructor(public readonly reason: 'unavailable' | 'permission' | 'failed' | 'stale') { super('Indexed media size unavailable'); }
}

/** Retain one page plus the requested batch of asset objects, with an ID set
 * for cross-album deduplication (not a full library of assets or file bytes).
 * Unknown sizes are not zero and cannot participate in a largest-first claim.
 * Neither this ranking nor its transient counts are persisted. */
export async function loadLargestMedia(
    kind: 'photo' | 'video',
    count: number,
    albumIds: readonly string[],
    excludedIds: ReadonlySet<string>,
    date?: MediaDateFilter,
    isCurrent: () => boolean = () => true,
    excludedAlbumIds?: ReadonlySet<string>,
) {
    if (!Number.isSafeInteger(count) || count <= 0 || count > 1000) throw new MediaSizeReadError('failed');
    if (!supportsIndexedMediaSizes()) throw new MediaSizeReadError('unavailable');
    const check = () => { if (!isCurrent()) throw new MediaSizeReadError('stale'); };
    const albums = [...new Set(albumIds)];
    const checkAlbums = async () => {
        if (!albums.length) return;
        const available = new Set((await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true })).map(album => album.id));
        check();
        if (albums.some(id => !available.has(id))) throw new MediaSizeReadError('unavailable');
    };
    const enumerate = async () => {
        const seen = new Set<string>();
        const selected: { asset: MediaLibrary.Asset; bytes: number }[] = [];
        let knownCount = 0, unknownCount = 0;
        for (const album of albums.length ? albums : [undefined]) {
            let after: string | undefined;
            const cursors = new Set<string>();
            do {
                check();
                const page = await MediaLibrary.getAssetsAsync({ mediaType: kind, first: 200, resolveWithFullInfo: false,
                    ...mediaDateQuery(date), ...(album ? { album } : {}), ...(after ? { after } : {}) });
                check();
                const eligible = page.assets.filter(asset => {
                    if (asset.mediaType !== kind || !asset.uri || seen.has(asset.id) || excludedIds.has(asset.id)
                        || (excludedAlbumIds && asset.albumId && excludedAlbumIds.has(asset.albumId))
                        || !mediaMatchesDate(asset.creationTime, date)) return false;
                    seen.add(asset.id); return true;
                });
                const result = await readMediaSizes(kind, eligible.map(asset => asset.id), isCurrent);
                check();
                if (result.status !== 'ready') throw new MediaSizeReadError(result.status);
                for (const asset of eligible) {
                    const bytes = result.sizes.get(asset.id);
                    if (bytes == null) { unknownCount++; continue; }
                    knownCount++; selected.push({ asset, bytes });
                }
                selected.sort((a, b) => b.bytes - a.bytes || a.asset.id.localeCompare(b.asset.id));
                selected.length = Math.min(selected.length, count);
                if (!page.hasNextPage) break;
                if (!page.endCursor || cursors.has(page.endCursor)) throw new MediaSizeReadError('failed');
                cursors.add(page.endCursor); after = page.endCursor;
            } while (true);
        }
        return { assets: selected.map(item => item.asset), totalCount: null, sizeStats: { knownCount, unknownCount } };
    };
    try {
        check();
        const permission = await MediaLibrary.getPermissionsAsync(false, [kind]);
        check();
        if (!permission.granted) throw new MediaSizeReadError('permission');
        if (albums.length && Platform.OS === 'ios' && permission.accessPrivileges !== 'all') throw new MediaSizeReadError('unavailable');
        await checkAlbums();
        let result = await enumerate();
        if (permission.accessPrivileges === 'limited') result = await enumerate();
        await checkAlbums();
        const latest = await MediaLibrary.getPermissionsAsync(false, [kind]);
        check();
        if (!latest.granted || latest.accessPrivileges !== permission.accessPrivileges) throw new MediaSizeReadError('permission');
        return result;
    } catch (error) {
        if (error instanceof MediaSizeReadError) throw error;
        throw new MediaSizeReadError(isCurrent() ? 'failed' : 'stale');
    }
}
