import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type MediaSizesResult = { status: 'ready' | 'unavailable' | 'failed' | 'stale'; sizes: Map<string, number | null> };
interface MediaIndexModule { readSizes(kind: 'photo' | 'video', ids: string[]): Promise<unknown> }

export function supportsIndexedMediaSizes(): boolean {
    try { return Platform.OS === 'android' && !!requireOptionalNativeModule<MediaIndexModule>('PickPicMediaIndex'); }
    catch { return false; }
}

/** Positive, exact indexed bytes only. Zero/missing is unknown, not a small
 * file. Do not use legacy getInfoAsync(content://): SDK 54 uses available(),
 * which measures immediately readable bytes, not a reliable file length. */
export function validMediaBytes(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Ephemeral batch lookup. Callers own fresh permission/scope checks and must
 * not persist these maps or assume a missing row means physical deletion. */
export async function readMediaSizes(kind: 'photo' | 'video', requestedIds: readonly string[],
    isCurrent: () => boolean = () => true): Promise<MediaSizesResult> {
    const empty = (status: MediaSizesResult['status']): MediaSizesResult => ({ status, sizes: new Map() });
    if (!isCurrent()) return empty('stale');
    if (Platform.OS !== 'android') return empty('unavailable');
    const ids = [...new Set(requestedIds)];
    if (!ids.every(id => /^[1-9][0-9]{0,18}$/.test(id))) return empty('failed');
    try {
        const module = requireOptionalNativeModule<MediaIndexModule>('PickPicMediaIndex');
        if (!module) return empty('unavailable');
        const sizes = new Map<string, number | null>(ids.map(id => [id, null]));
        for (let offset = 0; offset < ids.length; offset += 200) {
            const batch = ids.slice(offset, offset + 200), wanted = new Set(batch), seen = new Set<string>();
            const rows = await module.readSizes(kind, batch);
            if (!isCurrent()) return empty('stale');
            if (!Array.isArray(rows)) throw new Error('Invalid size index');
            for (const row of rows) {
                if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'bytes,id'
                    || typeof row.id !== 'string' || !wanted.has(row.id) || seen.has(row.id)) throw new Error('Invalid size index');
                seen.add(row.id); sizes.set(row.id, validMediaBytes(row.bytes));
            }
        }
        return isCurrent() ? { status: 'ready', sizes } : empty('stale');
    } catch { return empty(isCurrent() ? 'failed' : 'stale'); }
}
