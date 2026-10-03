import * as MediaLibrary from 'expo-media-library';

export type RecentMediaRead = { status: 'ready' | 'permission' | 'failed' | 'stale'; assets: Map<string, MediaLibrary.Asset> };
/** Read indexed metadata, not saved URIs or original EXIF. Missing results
 * mean unavailable, never permission to remove a record or restore a file. */
export async function readRecentDecisionMedia(kind: 'photo' | 'video', ids: readonly string[], isCurrent: () => boolean = () => true): Promise<RecentMediaRead> {
    const empty = (status: RecentMediaRead['status']): RecentMediaRead => ({ status, assets: new Map() });
    if (!ids.length) return empty('ready');
    const wanted = new Set(ids);
    const enumerate = async () => {
        const assets = new Map<string, MediaLibrary.Asset>();
        const cursors = new Set<string>();
        let after: string | undefined;
        do {
            const page = await MediaLibrary.getAssetsAsync({ mediaType: kind, first: 200, resolveWithFullInfo: false,
                ...(after ? { after } : {}) });
            if (!isCurrent()) return null;
            for (const asset of page.assets) if (wanted.has(asset.id) && asset.mediaType === kind && asset.uri) {
                // Deliberately keep no provider-specific EXIF/location fields.
                assets.set(asset.id, { id: asset.id, uri: asset.uri, filename: asset.filename, mediaType: asset.mediaType,
                    width: asset.width, height: asset.height, creationTime: asset.creationTime, modificationTime: asset.modificationTime,
                    duration: asset.duration, ...(asset.albumId ? { albumId: asset.albumId } : {}) });
            }
            if (assets.size === wanted.size || !page.hasNextPage) return assets;
            if (!page.endCursor || cursors.has(page.endCursor)) throw new Error('Incomplete media read');
            cursors.add(page.endCursor); after = page.endCursor;
        } while (true);
    };
    try {
        const permission = await MediaLibrary.getPermissionsAsync(false, [kind]);
        if (!isCurrent()) return empty('stale');
        if (!permission.granted) return empty('permission');
        let assets = await enumerate();
        if (!assets) return empty('stale');
        // A selected-media grant can change without changing the word
        // "limited". Re-read the actual visible IDs before returning them.
        if (permission.accessPrivileges === 'limited') {
            assets = await enumerate();
            if (!assets) return empty('stale');
        }
        const latest = await MediaLibrary.getPermissionsAsync(false, [kind]);
        if (!isCurrent()) return empty('stale');
        if (!latest.granted || latest.accessPrivileges !== permission.accessPrivileges) return empty('permission');
        return { status: 'ready', assets };
    } catch { return empty(isCurrent() ? 'failed' : 'stale'); }
}
