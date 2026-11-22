import {
    ProtectedAlbumRepository,
    type ProtectedAlbumRecord,
} from '../database/repositories/ProtectedAlbumRepository';
import { recordBackupChanges } from './backup/changeTracker';

export type { ProtectedAlbumRecord };
export {
    fetchProtectedAssetIdsForAlbums,
    isAssetProtected,
    resolveProtectedIdsBeforeDeletion,
} from './protectedAlbumsCore';

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
