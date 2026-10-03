import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import type { OrganizingSession } from './organizingSession';

export interface SessionRecoveryResult {
    status: 'ready' | 'review' | 'complete' | 'permission' | 'unavailable' | 'failed' | 'stale' | 'busy';
    assets: MediaLibrary.Asset[];
    unavailableCount: number;
    position: number;
}

/** Recover the saved scope/order from fresh indexed metadata, not stored URIs.
 * This read never changes progress/session data or removes inaccessible IDs.
 * A caller generation guard also detects limited-selection changes where the
 * privilege string alone remains unchanged. */
export async function recoverOrganizingSession(session: OrganizingSession, processedIds: ReadonlySet<string>,
    isCurrent: () => boolean = () => true, pendingIds: ReadonlySet<string> = new Set()): Promise<SessionRecoveryResult> {
    const deferred = new Set(session.deferredIds);
    const wanted = (session.kind === 'video' ? session.assetIds : session.assetIds.slice(session.position))
        .filter(id => (session.kind === 'video' || !processedIds.has(id)) && !deferred.has(id) && !pendingIds.has(id));
    const result = (status: SessionRecoveryResult['status'], assets: MediaLibrary.Asset[] = []): SessionRecoveryResult => {
        const found = new Set(assets.map(asset => asset.id));
        const nextId = session.assetIds.slice(session.position).find(id => found.has(id));
        const nextPosition = nextId ? assets.findIndex(asset => asset.id === nextId) : Math.max(0, assets.length - 1);
        return { status, assets, unavailableCount: Math.max(0, wanted.length - assets.length), position: session.kind === 'video' ? nextPosition : 0 };
    };
    try {
        const permission = await MediaLibrary.getPermissionsAsync(false, [session.kind]);
        if (!permission.granted) return result('permission');
        if (!isCurrent()) return result('stale');
        if (session.phase === 'review') return result('review');
        if (session.phase === 'complete') return result('complete');
        if (!wanted.length) return result('review');
        if (session.scope.albumIds.length) {
            if (Platform.OS === 'ios' && permission.accessPrivileges !== 'all') return result('unavailable');
            const albums = await MediaLibrary.getAlbumsAsync();
            const currentAlbums = new Set(albums.map(album => album.id));
            if (session.scope.albumIds.some(id => !currentAlbums.has(id))) return result('unavailable');
        }
        const wantedIds = new Set(wanted);
        const found = new Map<string, MediaLibrary.Asset>();
        for (const album of session.scope.albumIds.length ? session.scope.albumIds : [undefined]) {
            const cursors = new Set<string>();
            let after: string | undefined;
            do {
                const page = await MediaLibrary.getAssetsAsync({ mediaType: session.kind, first: 200, resolveWithFullInfo: false,
                    ...(album ? { album } : {}), ...(after ? { after } : {}) });
                if (!isCurrent()) return result('stale');
                for (const asset of page.assets) {
                    if (wantedIds.has(asset.id) && asset.mediaType === session.kind && asset.uri) found.set(asset.id, asset);
                }
                if (found.size === wantedIds.size || !page.hasNextPage) break;
                if (!page.endCursor || cursors.has(page.endCursor)) throw new Error('Incomplete media enumeration');
                cursors.add(page.endCursor); after = page.endCursor;
            } while (true);
            if (found.size === wantedIds.size) break;
        }
        // An album may disappear during paging. Never publish an iOS provider
        // fallback that silently widened a captured album scope.
        if (session.scope.albumIds.length) {
            const albums = new Set((await MediaLibrary.getAlbumsAsync()).map(album => album.id));
            if (session.scope.albumIds.some(id => !albums.has(id))) return result('unavailable');
        }
        const latestPermission = await MediaLibrary.getPermissionsAsync(false, [session.kind]);
        if (!isCurrent()) return result('stale');
        if (!latestPermission.granted || latestPermission.accessPrivileges !== permission.accessPrivileges) return result('permission');
        const assets = wanted.flatMap(id => { const asset = found.get(id); return asset ? [asset] : []; });
        return result(assets.length ? 'ready' : 'unavailable', assets);
    } catch { return result(isCurrent() ? 'failed' : 'stale'); }
}
