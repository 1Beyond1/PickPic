/**
 * Database Connection Manager
 * Uses expo-sqlite async API with prepared statements
 */

import * as SQLite from 'expo-sqlite';
import { runMigrations } from './migrations';
import { DB_NAME } from './schema';

let dbInstance: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Get or initialize the database instance
 * Ensures migrations are run on first access
 */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
    if (dbInstance) {
        return dbInstance;
    }

    if (initPromise) {
        return initPromise;
    }

    initPromise = initializeDatabase();
    dbInstance = await initPromise;
    initPromise = null;

    return dbInstance;
}

/**
 * Initialize database and run migrations
 */
async function initializeDatabase(): Promise<SQLite.SQLiteDatabase> {
    console.log('[DB] Opening database...');

    const db = await SQLite.openDatabaseAsync(DB_NAME);

    // Enable WAL mode for better performance
    await db.execAsync('PRAGMA journal_mode = WAL;');

    // Run migrations
    await runMigrations(db);

    console.log('[DB] Database ready.');
    return db;
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
    if (dbInstance) {
        await dbInstance.closeAsync();
        dbInstance = null;
    }
}

/**
 * Execute a transaction with automatic rollback on error
 */
export async function withTransaction<T>(
    fn: (db: SQLite.SQLiteDatabase) => Promise<T>
): Promise<T> {
    const db = await getDatabase();

    await db.execAsync('BEGIN TRANSACTION;');
    try {
        const result = await fn(db);
        await db.execAsync('COMMIT;');
        return result;
    } catch (error) {
        await db.execAsync('ROLLBACK;');
        throw error;
    }
}
