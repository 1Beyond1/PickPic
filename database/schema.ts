/**
 * Database Schema Constants for AI Scanner Engine
 * Schema migrations are versioned independently from image analysis.
 */

export const DB_NAME = 'pickpic_scanner.db';

export const GLOBAL_ALGO_VERSION = 4;
export const AI_ALGO_VERSION = 1;

// Explicit similar-group decisions live inside the keyed scanner database,
// not in a second plaintext preference store. Membership, not group ID,
// identifies a review: the scanner can recreate group IDs on a rescan.
export const SQL_CREATE_SIMILAR_REVIEWS = `
  CREATE TABLE IF NOT EXISTS similar_reviews (
    snapshot_key TEXT PRIMARY KEY,
    kept_ids_json TEXT NOT NULL,
    pending_ids_json TEXT NOT NULL,
    reviewed_at INTEGER NOT NULL
  );
`;

// AI completion is independent from the base analysis / duplicate groups.
export const SQL_CREATE_AI_ANALYSIS = `
  CREATE TABLE IF NOT EXISTS ai_analysis (
    asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status INTEGER NOT NULL,
    source_updated_at INTEGER,
    source_signature TEXT,
    source_phash TEXT,
    error_message TEXT,
    updated_at INTEGER NOT NULL
  );
`;

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
  MEDIA_PROGRESS_SQLITE_MIGRATED: 'media_progress_sqlite_migrated',
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
    needs_duplicate_recovery INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
  );
`;

export const SQL_INDEX_ASSETS_STATUS_BLUR =
  'CREATE INDEX IF NOT EXISTS idx_assets_status_blur ON assets(status, blur_score, asset_id);';

export const SQL_CREATE_ASSETS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);',
  'CREATE INDEX IF NOT EXISTS idx_assets_taken_at ON assets(taken_at);',
  'CREATE INDEX IF NOT EXISTS idx_assets_algo_version ON assets(algo_version);',
  'CREATE INDEX IF NOT EXISTS idx_assets_status_taken_at ON assets(status, taken_at, asset_id);',
  SQL_INDEX_ASSETS_STATUS_BLUR,
];

export const SQL_CREATE_DUP_GROUPS = `
  CREATE TABLE IF NOT EXISTS dup_groups (
    group_id TEXT PRIMARY KEY,
    representative_asset_id TEXT,
    best_asset_id TEXT,
    created_at INTEGER
  );
`;

export const SQL_INDEX_DUP_GROUPS_CREATED =
  'CREATE INDEX IF NOT EXISTS idx_dup_groups_created ON dup_groups(created_at DESC, group_id ASC);';

export const SQL_CREATE_DUP_GROUPS_INDEXES = [
  SQL_INDEX_DUP_GROUPS_CREATED,
];

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

// Row-level encrypted storage for unbounded organizing progress and pending
// deletion queues. Keeping one row per asset avoids Android AsyncStorage's
// 2 MB single-row CursorWindow limit while preserving exact insertion order.
export const SQL_CREATE_MEDIA_PROCESSED_RECORDS = `
  CREATE TABLE IF NOT EXISTS media_processed_records (
    media_type TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (media_type, asset_id)
  );
`;

export const SQL_CREATE_MEDIA_PROCESSED_RECORDS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_media_processed_order ON media_processed_records(media_type, seq);',
];

export const SQL_CREATE_MEDIA_PENDING_QUEUE = `
  CREATE TABLE IF NOT EXISTS media_pending_queue (
    queue_type TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    asset_json TEXT NOT NULL,
    source TEXT,
    added_at INTEGER,
    PRIMARY KEY (queue_type, asset_id)
  );
`;

export const SQL_CREATE_MEDIA_PENDING_QUEUE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_media_pending_queue_order ON media_pending_queue(queue_type, seq);',
];
