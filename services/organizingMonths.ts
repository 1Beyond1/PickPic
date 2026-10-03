import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { groupMediaByMonth } from './mediaMonth';
import type { MediaMonth } from './mediaMonth';

export type OrganizingMonthsResult = {
    status: 'ready' | 'permission' | 'unavailable' | 'failed' | 'stale';
    months: (MediaMonth & { count: number })[];
    unknownDateCount: number;
    limited: boolean;
};
/** Ephemeral counts only. Album selections must not fall back to all media,
 * and an unavailable month index is not an empty or completed library. */
export async function readOrganizingMonths(kind: 'photo' | 'video', albumIds: readonly string[], excludedIds: ReadonlySet<string>,
    isCurrent: () => boolean = () => true): Promise<OrganizingMonthsResult> {
    const selectedAlbums = [...new Set(albumIds)];
    const empty = (status: OrganizingMonthsResult['status']): OrganizingMonthsResult => ({ status, months: [], unknownDateCount: 0, limited: false });
    const availableAlbums = async () => {
        if (!selectedAlbums.length) return true;
        const available = new Set((await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true })).map(album => album.id));
        return selectedAlbums.every(id => available.has(id));
    };
    const enumerate = async () => {
        const seen = new Set<string>(), months = new Map<string, MediaMonth & { count: number }>();
        let unknownDateCount = 0;
        for (const album of selectedAlbums.length ? selectedAlbums : [undefined]) {
            let after: string | undefined;
            const cursors = new Set<string>();
            do {
                const page = await MediaLibrary.getAssetsAsync({ mediaType: kind, first: 200, resolveWithFullInfo: false,
                    ...(album ? { album } : {}), ...(after ? { after } : {}) });
                if (!isCurrent()) return null;
                const dates: { creationTime: number }[] = [];
                for (const asset of page.assets) {
                    if (asset.mediaType !== kind || !asset.uri || seen.has(asset.id) || excludedIds.has(asset.id)) continue;
                    seen.add(asset.id); dates.push({ creationTime: asset.creationTime });
                }
                const grouped = groupMediaByMonth(dates);
                unknownDateCount += grouped.unknownDateCount;
                for (const month of grouped.months) {
                    const key = `${month.year}-${month.month}`, existing = months.get(key);
                    if (existing) existing.count += month.count; else months.set(key, month);
                }
                if (!page.hasNextPage) break;
                if (!page.endCursor || cursors.has(page.endCursor)) throw new Error('Incomplete month index');
                cursors.add(page.endCursor); after = page.endCursor;
            } while (true);
        }
        return { months: [...months.values()].sort((a, b) => b.year - a.year || b.month - a.month), unknownDateCount };
    };
    try {
        const permission = await MediaLibrary.getPermissionsAsync(false, [kind]);
        if (!isCurrent()) return empty('stale');
        if (!permission.granted) return empty('permission');
        if (selectedAlbums.length && Platform.OS === 'ios' && permission.accessPrivileges !== 'all') return empty('unavailable');
        if (!await availableAlbums()) return empty('unavailable');
        let result = await enumerate();
        if (!result) return empty('stale');
        // Selection can change while its privilege still reads "limited".
        if (permission.accessPrivileges === 'limited') result = await enumerate();
        if (!result || !isCurrent()) return empty('stale');
        if (!await availableAlbums()) return empty('unavailable');
        const latest = await MediaLibrary.getPermissionsAsync(false, [kind]);
        if (!isCurrent()) return empty('stale');
        if (!latest.granted || latest.accessPrivileges !== permission.accessPrivileges) return empty('permission');
        return { status: 'ready', ...result, limited: latest.accessPrivileges === 'limited' };
    } catch { return empty(isCurrent() ? 'failed' : 'stale'); }
}
