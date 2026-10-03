import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

/** Folder-title shortcuts only, not proof of how any member was captured.
 * Do not infer screen content from filenames, aspect ratio, or AI labels. */
const titles = {
    photo: new Set(['screenshot', 'screenshots', 'screencapture', 'screencaptures', '截图', '屏幕截图', 'スクリーンショット']),
    video: new Set(['screenrecord', 'screenrecords', 'screenrecorder', 'screenrecording', 'screenrecordings', '录屏', '屏幕录制', '屏幕录屏', '录屏视频']),
};
export function matchesSourceAlbumTitle(kind: 'photo' | 'video', value: unknown): boolean {
    return typeof value === 'string' && titles[kind].has(value.normalize('NFKC').trim().toLowerCase().replace(/[ _-]/g, ''));
}
export type SourceAlbumsResult = {
    status: 'ready' | 'permission' | 'unavailable' | 'failed' | 'stale';
    albums: { id: string; title: string }[];
};
export async function readSourceAlbums(kind: 'photo' | 'video', isCurrent: () => boolean = () => true): Promise<SourceAlbumsResult> {
    const empty = (status: SourceAlbumsResult['status']): SourceAlbumsResult => ({ status, albums: [] });
    if (!isCurrent()) return empty('stale');
    try {
        const permission = await MediaLibrary.getPermissionsAsync(false, [kind]);
        if (!isCurrent()) return empty('stale');
        if (!permission.granted) return empty('permission');
        if (Platform.OS === 'ios' && permission.accessPrivileges !== 'all') return empty('unavailable');
        const enumerate = async () => {
            const available = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
            const seen = new Set<string>();
            return available.filter(album => {
                if (typeof album.id !== 'string' || !album.id || seen.has(album.id) || !matchesSourceAlbumTitle(kind, album.title)) return false;
                seen.add(album.id); return true;
            }).map(({ id, title }) => ({ id, title }));
        };
        let albums = await enumerate();
        if (!isCurrent()) return empty('stale');
        if (permission.accessPrivileges === 'limited') albums = await enumerate();
        const latest = await MediaLibrary.getPermissionsAsync(false, [kind]);
        if (!isCurrent()) return empty('stale');
        if (!latest.granted || latest.accessPrivileges !== permission.accessPrivileges) return empty('permission');
        return { status: 'ready', albums };
    } catch { return empty(isCurrent() ? 'failed' : 'stale'); }
}
