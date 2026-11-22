/**
 * Database Connection Manager
 * Uses expo-sqlite async API with prepared statements
 */

import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { runMigrations } from './migrations';
import { openEncryptedDatabase, withEncryptedTransaction } from './encryptedDatabase';
import { LocalPrivacyError, usePrivacyStore } from '../stores/usePrivacyStore';

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

    let db: SQLite.SQLiteDatabase | null = null;
    try {
        // Web has no device SecureStore/SQLCipher in this integration. Keep
        // existing browser data untouched instead of silently using plaintext.
        if (Platform.OS === 'web') throw new LocalPrivacyError('keystore_unavailable');
        db = await openEncryptedDatabase();

        try {
            // Enable WAL mode for better performance
            await db.execAsync('PRAGMA journal_mode = WAL;');

            // Run migrations
            await runMigrations(db);
        } catch (migrationError) {
            throw migrationError instanceof LocalPrivacyError
                ? migrationError
                : new LocalPrivacyError('schema_corrupt');
        }
        usePrivacyStore.getState().clear('scanner');

        console.log('[DB] Database ready.');
        return db;
    } catch (error) {
        // Opening succeeds before PRAGMA/migrations run. If either step fails,
        // close that handle before allowing a retry so a transient failure
        // cannot accumulate open connections or leave a lock behind.
        if (db) {
            await db.closeAsync().catch(() => undefined);
        }
        const reason = error instanceof LocalPrivacyError ? error.reason : 'cipher_decrypt_failed';
        usePrivacyStore.getState().block('scanner', 'read', reason);
        throw new LocalPrivacyError(reason);
    }
}

/**
 * Close the database connection after waiting for any in-flight
 * initialization or queued transactions to settle.
 */
export async function closeDatabase(): Promise<void> {
    while (true) {
        const pendingInit = initPromise;
        const pendingTx = transactionQueue;
        if (pendingInit) {
            await pendingInit.catch(() => undefined);
        }
        await pendingTx.catch(() => undefined);
        if (initPromise === null && transactionQueue === pendingTx) {
            break;
        }
    }

    const current = dbInstance;
    dbInstance = null;
    if (current) {
        await current.closeAsync();
    }
}

/**
 * Execute a transaction with automatic rollback on error
 */
export function withTransaction<T>(
    fn: (db: SQLite.SQLiteDatabase) => Promise<T>
): Promise<T> {
    const operation = transactionQueue.then(async () => {
        await getDatabase();

        // Expo's regular async transaction is not exclusive: unrelated async
        // queries can run between BEGIN and COMMIT. Use a separately keyed
        // connection so UI deletes and scanner writes cannot interleave.
        return withEncryptedTransaction(fn);
    });

    // Keep the queue usable after a failed transaction while preserving the
    // original error for the caller of this operation.
    transactionQueue = operation.then(() => undefined, () => undefined);
    return operation;
}
