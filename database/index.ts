/**
 * Database module exports
 */

export { closeDatabase, getDatabase, withTransaction } from './db';
export { AssetRepository } from './repositories/AssetRepository';
export type {
    AssetRecord,
    BlurryAsset,
    BlurryAssetsCursor,
    LibraryAssetSyncInput,
    LibraryMetadataSyncBatchOptions,
    LibraryMetadataSyncBatchResult,
    PendingAsset,
} from './repositories/AssetRepository';
export { DupGroupRepository } from './repositories/DupGroupRepository';
export type { DupGroup, DupGroupsCursor, DupMember } from './repositories/DupGroupRepository';
export { SimilarReviewRepository, isSimilarReviewCurrent } from './repositories/SimilarReviewRepository';
export type { SimilarGroupSnapshot, SimilarReview, SimilarReviewAsset } from './repositories/SimilarReviewRepository';
export { FaceRepository } from './repositories/FaceRepository';
export type { FaceGroup, FaceInstance } from './repositories/FaceRepository';
export {
    MediaProgressRepository,
    emptyMediaProgressCollections,
    mediaProgressCollectionsEqual,
    normalizeMediaProgressCollections,
} from './repositories/MediaProgressRepository';
export type {
    MediaProgressCollections,
    PendingQueueType,
    ProcessedMediaType,
} from './repositories/MediaProgressRepository';
export { MetaRepository } from './repositories/MetaRepository';
export type { ScanCursor } from './repositories/MetaRepository';
export { ReviewIgnoreRepository } from './repositories/ReviewIgnoreRepository';
export type { MediaReviewIgnore, ReviewIgnoreType } from './repositories/ReviewIgnoreRepository';
export { ProtectedAlbumRepository } from './repositories/ProtectedAlbumRepository';
export type { ProtectedAlbumRecord } from './repositories/ProtectedAlbumRepository';
export * from './schema';

