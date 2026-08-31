/**
 * Database Connection Manager
 * Uses expo-sqlite async API with prepared statements
 */

import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { runMigrations } from './migrations';
import { DB_NAME } from './schema';

let dbInstance: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let transactionQueue: Promise<void> = Promise.resolve();

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

    const pendingInitialization = initializeDatabase();
    initPromise = pendingInitialization;

    try {
        dbInstance = await pendingInitialization;
        return dbInstance;
    } finally {
        // Do not cache a rejected initialization forever. A later operation
        // should be able to retry after a transient open/migration failure.
        if (initPromise === pendingInitialization) {
            initPromise = null;
        }
    }
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
export function withTransaction<T>(
    fn: (db: SQLite.SQLiteDatabase) => Promise<T>
): Promise<T> {
    const operation = transactionQueue.then(async () => {
        const db = await getDatabase();

        // Expo's regular async transaction is not exclusive: unrelated async
        // queries can run between BEGIN and COMMIT. Native callers therefore
        // use an exclusive transaction so UI deletes and scanner writes cannot
        // be interleaved into the same unit of work. Web does not implement
        // the exclusive API, so retain the queued fallback there.
        if (Platform.OS !== 'web') {
            let result!: T;
            await db.withExclusiveTransactionAsync(async transactionDb => {
                result = await fn(transactionDb);
            });
            return result;
        }

        await db.execAsync('BEGIN TRANSACTION;');
        try {
            const result = await fn(db);
            await db.execAsync('COMMIT;');
            return result;
        } catch (error) {
            await db.execAsync('ROLLBACK;');
            throw error;
        }
    });

    // Keep the queue usable after a failed transaction while preserving the
    // original error for the caller of this operation.
    transactionQueue = operation.then(() => undefined, () => undefined);
    return operation;
}
