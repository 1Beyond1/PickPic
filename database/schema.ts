/**
 * Database Schema Constants for AI Scanner Engine
 * Version: 3 (global_algo_version)
 */

export const DB_NAME = 'pickpic_scanner.db';

export const GLOBAL_ALGO_VERSION = 3;

// Asset status enum
export const AssetStatus = {
  PENDING: 0,
  DONE: 1,
  ERROR: 2,
} as const;

export type AssetStatusType = typeof AssetStatus[keyof typeof AssetStatus];

// Meta keys
export const MetaKeys = {
  GLOBAL_ALGO_VERSION: 'global_algo_version',
  SCAN_CURSOR_TAKEN_AT: 'scan_cursor_taken_at',
  SCAN_CURSOR_ASSET_ID: 'scan_cursor_asset_id',
} as const;

// Table creation SQL
export const SQL_CREATE_META = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

export const SQL_CREATE_ASSETS = `
  CREATE TABLE IF NOT EXISTS assets (
    asset_id TEXT PRIMARY KEY,
    taken_at INTEGER,
    width INTEGER,
    height INTEGER,
    file_signature TEXT,
    algo_version INTEGER,
    blur_score REAL,
    mean_luma REAL,
    phash TEXT,
    labels_json TEXT,
    status INTEGER DEFAULT 0,
    error_message TEXT,
    updated_at INTEGER
  );
`;

export const SQL_CREATE_ASSETS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);',
  'CREATE INDEX IF NOT EXISTS idx_assets_taken_at ON assets(taken_at);',
  'CREATE INDEX IF NOT EXISTS idx_assets_algo_version ON assets(algo_version);',
  'CREATE INDEX IF NOT EXISTS idx_assets_status_taken_at ON assets(status, taken_at, asset_id);',
];

export const SQL_CREATE_DUP_GROUPS = `
  CREATE TABLE IF NOT EXISTS dup_groups (
    group_id TEXT PRIMARY KEY,
    representative_asset_id TEXT,
    best_asset_id TEXT,
    created_at INTEGER
  );
`;

export const SQL_CREATE_DUP_MEMBERS = `
  CREATE TABLE IF NOT EXISTS dup_members (
    group_id TEXT,
    asset_id TEXT,
    distance INTEGER,
    PRIMARY KEY (group_id, asset_id)
  );
`;

export const SQL_CREATE_DUP_MEMBERS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_dup_members_asset ON dup_members(asset_id);',
];

// Phase 2: Face detection tables
export const SQL_CREATE_FACE_GROUPS = `
  CREATE TABLE IF NOT EXISTS face_groups (
    face_id TEXT PRIMARY KEY,
    cluster_id INTEGER,
    first_seen_asset_id TEXT,
    representative_uri TEXT,
    photo_count INTEGER DEFAULT 1,
    created_at INTEGER
  );
`;

export const SQL_CREATE_FACE_INSTANCES = `
  CREATE TABLE IF NOT EXISTS face_instances (
    instance_id TEXT PRIMARY KEY,
    face_id TEXT,
    asset_id TEXT,
    bounding_box TEXT,
    confidence REAL,
    FOREIGN KEY (face_id) REFERENCES face_groups(face_id)
  );
`;

export const SQL_CREATE_FACE_INSTANCES_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_face_instances_asset ON face_instances(asset_id);',
  'CREATE INDEX IF NOT EXISTS idx_face_instances_face ON face_instances(face_id);',
];
