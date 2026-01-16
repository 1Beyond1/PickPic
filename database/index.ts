/**
 * Database module exports
 */

export { closeDatabase, getDatabase, withTransaction } from './db';
export { AssetRepository } from './repositories/AssetRepository';
export type { AssetRecord, PendingAsset } from './repositories/AssetRepository';
export { DupGroupRepository } from './repositories/DupGroupRepository';
export type { DupGroup, DupMember } from './repositories/DupGroupRepository';
export { FaceRepository } from './repositories/FaceRepository';
export type { FaceGroup, FaceInstance } from './repositories/FaceRepository';
export { MetaRepository } from './repositories/MetaRepository';
export type { ScanCursor } from './repositories/MetaRepository';
export * from './schema';

