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

const CURRENT_SCHEMA_VERSION = 2;

/**
 * Run all migrations to bring database to current version
 */
export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
    // Get current schema version
    const schemaVersion = await getSchemaVersion(db);

    if (schemaVersion < 1) {
        await migrateToV1(db);
    }

    if (schemaVersion < 2) {
        await migrateToV2(db);
    }
}

/**
 * Get current schema version from meta table
 */
async function getSchemaVersion(db: SQLite.SQLiteDatabase): Promise<number> {
    try {
        // Check if meta table exists
        const tableCheck = await db.getFirstAsync<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`
        );

        if (!tableCheck) {
            return 0;
        }

        const result = await db.getFirstAsync<{ value: string }>(
            `SELECT value FROM meta WHERE key = ?`,
            ['schema_version']
        );

        return result ? parseInt(result.value, 10) : 0;
    } catch {
        return 0;
    }
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

    // Add face_count column to assets table
    try {
        await db.execAsync('ALTER TABLE assets ADD COLUMN face_count INTEGER DEFAULT 0;');
    } catch (error) {
        // Column may already exist, ignore error
        console.log('[Migrations] face_count column may already exist');
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
