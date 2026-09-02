/**
 * Database Migrations for AI Scanner Engine
 * Supports versioned schema upgrades
 */

import * as SQLite from 'expo-sqlite';
import {
    GLOBAL_ALGO_VERSION,
    MetaKeys,
    SQL_CREATE_ASSETS,
    SQL_CREATE_ASSETS_INDEXES,
    SQL_CREATE_DUP_GROUPS,
    SQL_CREATE_DUP_MEMBERS,
    SQL_CREATE_DUP_MEMBERS_INDEXES,
    SQL_CREATE_FACE_GROUPS,
    SQL_CREATE_FACE_INSTANCES,
    SQL_CREATE_FACE_INSTANCES_INDEXES,
    SQL_CREATE_META,
} from './schema';

const CURRENT_SCHEMA_VERSION = 3;

/**
 * Run all migrations to bring database to current version
 */
export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
    // Get current schema version
    const schemaVersion = await getSchemaVersion(db);

    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error(
            `[Migrations] Database schema version ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`
        );
    }

    if (schemaVersion < 1) {
        await migrateToV1(db);
    }

    if (schemaVersion < 2) {
        await migrateToV2(db);
    }

    if (schemaVersion < 3) {
        await migrateToV3(db);
    }
}

/**
 * Get current schema version from meta table
 */
async function getSchemaVersion(db: SQLite.SQLiteDatabase): Promise<number> {
    // A missing table is the only valid "version 0" case. Other database
    // errors must surface instead of being mistaken for a fresh install.
    const tableCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`
    );

    if (!tableCheck) {
        return 0;
    }

    const result = await db.getFirstAsync<{ value: string | null }>(
        `SELECT value FROM meta WHERE key = ?`,
        ['schema_version']
    );

    if (!result) {
        return 0;
    }

    const rawVersion = result.value?.trim() ?? '';
    if (!/^\d+$/.test(rawVersion)) {
        throw new Error(`[Migrations] Invalid schema version: ${String(result.value)}`);
    }

    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 0) {
        throw new Error(`[Migrations] Invalid schema version: ${String(result.value)}`);
    }

    return version;
}

/**
 * Set schema version in meta table
 */
async function setSchemaVersion(db: SQLite.SQLiteDatabase, version: number): Promise<void> {
    await db.runAsync(
        `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
        ['schema_version', version.toString()]
    );
}

/**
 * Migration to V1: Initial schema
 */
async function migrateToV1(db: SQLite.SQLiteDatabase): Promise<void> {
    console.log('[Migrations] Running migration to V1...');

    // Create tables
    await db.execAsync(SQL_CREATE_META);
    await db.execAsync(SQL_CREATE_ASSETS);
    await db.execAsync(SQL_CREATE_DUP_GROUPS);
    await db.execAsync(SQL_CREATE_DUP_MEMBERS);

    // Create indexes
    for (const indexSql of SQL_CREATE_ASSETS_INDEXES) {
        await db.execAsync(indexSql);
    }
    for (const indexSql of SQL_CREATE_DUP_MEMBERS_INDEXES) {
        await db.execAsync(indexSql);
    }

    // Initialize meta values
    await db.runAsync(
        `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
        [MetaKeys.GLOBAL_ALGO_VERSION, GLOBAL_ALGO_VERSION.toString()]
    );

    // Set schema version
    await setSchemaVersion(db, 1);

    console.log('[Migrations] Migration to V1 complete.');
}

/**
 * Migration to V2: Phase 2 AI Classification
 * Adds face detection and image labeling support
 */
async function migrateToV2(db: SQLite.SQLiteDatabase): Promise<void> {
    console.log('[Migrations] Running migration to V2...');

    // Check the schema explicitly. Catching every ALTER TABLE error would
    // also hide real failures such as a locked or corrupted database.
    const assetColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(assets)');
    const hasFaceCount = assetColumns.some(column => column.name === 'face_count');
    if (!hasFaceCount) {
        await db.execAsync('ALTER TABLE assets ADD COLUMN face_count INTEGER DEFAULT 0;');
    }

    // Create face detection tables
    await db.execAsync(SQL_CREATE_FACE_GROUPS);
    await db.execAsync(SQL_CREATE_FACE_INSTANCES);

    // Create indexes
    for (const indexSql of SQL_CREATE_FACE_INSTANCES_INDEXES) {
        await db.execAsync(indexSql);
    }

    // Set schema version
    await setSchemaVersion(db, 2);

    console.log('[Migrations] Migration to V2 complete.');
}

/**
 * Migration to V3: Track assets that need a wider duplicate-scan retry.
 * Scoped/limited scans can invalidate an asset's old group membership while
 * being unable to compare it with every local asset. Keep that fact separate
 * from the analysis status so a later full scan can revisit only those rows.
 */
async function migrateToV3(db: SQLite.SQLiteDatabase): Promise<void> {
    console.log('[Migrations] Running migration to V3...');

    const assetColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(assets)');
    const hasDuplicateRecoveryFlag = assetColumns.some(
        column => column.name === 'needs_duplicate_recovery'
    );
    if (!hasDuplicateRecoveryFlag) {
        await db.execAsync(
            'ALTER TABLE assets ADD COLUMN needs_duplicate_recovery INTEGER NOT NULL DEFAULT 0;'
        );
    }

    await setSchemaVersion(db, 3);

    console.log('[Migrations] Migration to V3 complete.');
}
