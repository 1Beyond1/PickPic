import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

function missingLocation(error: unknown, type: 'photo' | 'video') {
    return Platform.OS === 'android' && type === 'photo' && error instanceof Error
        && error.message.includes('ACCESS_MEDIA_LOCATION');
}

async function readIndexed(ids: ReadonlySet<string>, type: 'photo' | 'video') {
    const found = new Map<string, MediaLibrary.AssetInfo>();
    const cursors = new Set<string>();
    let after: string | undefined;
    do {
        const page = await MediaLibrary.getAssetsAsync({ mediaType: type, first: 200,
            resolveWithFullInfo: false, ...(after ? { after } : {}) });
        for (const asset of page.assets) {
            if (ids.has(asset.id) && asset.mediaType === type) found.set(asset.id, { ...asset, localUri: asset.uri } as MediaLibrary.AssetInfo);
        }
        if (found.size === ids.size || !page.hasNextPage) return found;
        if (!page.endCursor || cursors.has(page.endCursor)) throw new Error('Media lookup is incomplete');
        cursors.add(page.endCursor);
        after = page.endCursor;
    } while (true);
}

/** SDK 54 Android full-info reads request original EXIF even when the App
 * does not have location access. Gallery decisions need pixels/indexed
 * metadata, not GPS. Only this known error permits a metadata-only lookup;
 * missing files, permission errors and other provider failures still fail. */
export async function getReadableMediaInfo(id: string, type: 'photo' | 'video' = 'photo',
    options?: MediaLibrary.MediaLibraryAssetInfoQueryOptions): Promise<MediaLibrary.AssetInfo> {
    try {
        return options ? await MediaLibrary.getAssetInfoAsync(id, options) : await MediaLibrary.getAssetInfoAsync(id);
    } catch (error) {
        if (!missingLocation(error, type)) throw error;
        const asset = (await readIndexed(new Set([id]), type)).get(id);
        if (!asset) throw new Error('Media is not accessible');
        return asset;
    }
}

/** The deletion preflight can contain thousands of IDs. A shared metadata
 * pass avoids rescanning the entire gallery separately for every EXIF error.
 * A missing result is not evidence of deletion; callers retain such items. */
export async function getReadableMediaInfos(ids: readonly string[], type: 'photo' | 'video',
    options: MediaLibrary.MediaLibraryAssetInfoQueryOptions = { shouldDownloadFromNetwork: false }) {
    const found = new Map<string, MediaLibrary.AssetInfo>();
    const fallback = new Set<string>();
    await Promise.all([...new Set(ids)].map(async id => {
        try {
            const asset = await MediaLibrary.getAssetInfoAsync(id, options);
            if (asset?.id === id) found.set(id, asset);
        } catch (error) { if (missingLocation(error, type)) fallback.add(id); }
    }));
    if (fallback.size) {
        try { for (const [id, asset] of await readIndexed(fallback, type)) found.set(id, asset); }
        catch { /* Keep failed lookups unresolved, never assume files deleted. */ }
    }
    return found;
}
