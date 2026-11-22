import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { getDeviceKeyHex } from '../services/privacy/deviceKey';
import { LocalPrivacyError, usePrivacyStore } from '../stores/usePrivacyStore';
import { DB_NAME } from './schema';

export const ENCRYPTED_DB_NAME = 'pickpic_scanner.encrypted-v1.db';
const marker = 'privacy_migration_complete';
function uri(name: string): string {
    const directory = SQLite.defaultDatabaseDirectory;
    if (!directory) throw new LocalPrivacyError();
    return `${directory.startsWith('file://') ? directory : `file://${directory}`}/${name}`;
}
async function exists(name: string): Promise<boolean> { return (await FileSystem.getInfoAsync(uri(name))).exists; }
async function removeSidecars(name: string): Promise<void> {
    // Expo's deleteDatabaseAsync removes the main file only. These exact
    // owned SQLite companions may otherwise retain plaintext pages.
    for (const suffix of ['-wal', '-shm', '-journal']) {
        await FileSystem.deleteAsync(uri(name + suffix), { idempotent: true });
    }
}
async function unlock(db: SQLite.SQLiteDatabase, key: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new LocalPrivacyError('keystore_unavailable');
    try {
        await db.execAsync(`PRAGMA key = "x'${key}'"; PRAGMA cipher_memory_security = ON; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 5000;`);
        const capability = await db.getFirstAsync<Record<string, string>>('PRAGMA cipher_version;');
        if (!capability || !Object.values(capability).some(value => typeof value === 'string' && /^\d+\./.test(value))) {
            throw new LocalPrivacyError('cipher_decrypt_failed');
        }
        await db.getFirstAsync('SELECT count(*) FROM sqlite_master'); // Wrong keys fail here.
    } catch (error) {
        throw error instanceof LocalPrivacyError ? error : new LocalPrivacyError('cipher_decrypt_failed');
    }
}
async function verifyIntegrity(db: SQLite.SQLiteDatabase): Promise<void> {
    const rows = await db.getAllAsync<Record<string, unknown>>('PRAGMA integrity_check;');
    if (rows.length !== 1 || !Object.values(rows[0]).includes('ok')) throw new LocalPrivacyError('schema_corrupt');
    if ((await db.getAllAsync('PRAGMA cipher_integrity_check;')).length !== 0) throw new LocalPrivacyError('cipher_decrypt_failed');
}
async function isComplete(db: SQLite.SQLiteDatabase): Promise<boolean> {
    const meta = await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
    if (!meta) return false;
    return (await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [marker]))?.value === '1';
}

/** Verify all migrated row values in bounded memory before deleting the old
 * database. sqlcipher_export preserves the schema, including future tables. */
async function compareRows(source: SQLite.SQLiteDatabase, target: SQLite.SQLiteDatabase): Promise<void> {
    const tables = await source.getAllAsync<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    for (const table of tables) {
        const quoted = `"${table.name.replace(/"/g, '""')}"`;
        const where = table.name === 'meta' ? ` WHERE key <> '${marker}'` : '';
        const columns = await source.getAllAsync<{ name: string; pk: number }>(`PRAGMA table_info(${quoted})`);
        const primary = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
        const order = primary.length ? primary.map(column => `"${column.name.replace(/"/g, '""')}"`).join(', ') : 'rowid';
        const query = `SELECT * FROM ${quoted}${where} ORDER BY ${order}`;
        // Streaming is bounded-memory and avoids OFFSET's quadratic work on
        // large libraries. Primary keys also support WITHOUT ROWID tables.
        const original = source.getEachAsync(query)[Symbol.asyncIterator]();
        const migrated = target.getEachAsync(query)[Symbol.asyncIterator]();
        try {
            while (true) {
                const [a, b] = await Promise.all([original.next(), migrated.next()]);
                if (a.done !== b.done || JSON.stringify(a.value) !== JSON.stringify(b.value)) throw new LocalPrivacyError();
                if (a.done) break;
            }
        } finally {
            await original.return?.();
            await migrated.return?.();
        }
    }
}

/** Caller runs application schema migrations only after encrypted opening. */
export async function openEncryptedDatabase(): Promise<SQLite.SQLiteDatabase> {
    let target: SQLite.SQLiteDatabase | null = null;
    let source: SQLite.SQLiteDatabase | null = null;
    try {
        const hadTarget = await exists(ENCRYPTED_DB_NAME);
        const key = await getDeviceKeyHex('scanner', hadTarget);
        target = await SQLite.openDatabaseAsync(ENCRYPTED_DB_NAME, { useNewConnection: true });
        await unlock(target, key);
        const hasLegacy = await exists(DB_NAME);
        if (hasLegacy) {
            source = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
            await source.getFirstAsync('SELECT count(*) FROM sqlite_master');
            if (!await isComplete(target)) {
                // A prior interrupted export may have produced partial tables.
                // Keep its readable source until the replacement is verified.
                await target.closeAsync(); target = null;
                await SQLite.deleteDatabaseAsync(ENCRYPTED_DB_NAME);
                await removeSidecars(ENCRYPTED_DB_NAME);
                await source.runAsync(`ATTACH DATABASE ? AS encrypted KEY "x'${key}'"`, [uri(ENCRYPTED_DB_NAME).replace(/^file:\/\//, '')]);
                const exporting = source;
                try {
                    await exporting.withTransactionAsync(async () => {
                        await exporting.getFirstAsync("SELECT sqlcipher_export('encrypted')");
                        await exporting.execAsync('CREATE TABLE IF NOT EXISTS encrypted.meta (key TEXT PRIMARY KEY, value TEXT)');
                        await exporting.runAsync('INSERT OR REPLACE INTO encrypted.meta (key, value) VALUES (?, ?)', [marker, '1']);
                    });
                } finally { await source.execAsync('DETACH DATABASE encrypted'); }
                target = await SQLite.openDatabaseAsync(ENCRYPTED_DB_NAME, { useNewConnection: true });
                await unlock(target, key);
            }
            await verifyIntegrity(target);
            await compareRows(source, target);
            const checkpoint = await source.getFirstAsync<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE);');
            if (checkpoint?.busy) throw new LocalPrivacyError();
            await source.closeAsync(); source = null;
            // Successfully authenticated and verified; the legacy DB is no
            // longer authoritative. SQLite handles only this exact filename.
            await SQLite.deleteDatabaseAsync(DB_NAME);
        }
        // Also retry cleanup if an earlier verified migration removed the
        // main file but was interrupted before sidecar cleanup completed.
        await removeSidecars(DB_NAME);
        await target.execAsync('PRAGMA journal_mode = WAL;');
        return target;
    } catch (error) {
        await source?.closeAsync().catch(() => undefined);
        await target?.closeAsync().catch(() => undefined);
        const reason = error instanceof LocalPrivacyError ? error.reason : 'cipher_decrypt_failed';
        usePrivacyStore.getState().block('scanner', 'read', reason);
        throw new LocalPrivacyError(reason);
    }
}

/** Explicit user-confirmed self-rescue only: removes PickPic's own local SQLite
 * database files and sidecars so a fresh encrypted index can be created.
 * Never touches user media library files. */
export async function resetEncryptedDatabaseFiles(): Promise<void> {
    for (const name of [ENCRYPTED_DB_NAME, DB_NAME]) {
        try {
            if (await exists(name)) {
                await SQLite.deleteDatabaseAsync(name);
            }
        } catch {
            // Fall back to direct file deletion for the owned database file only.
            await FileSystem.deleteAsync(uri(name), { idempotent: true });
        }
        await removeSidecars(name);
    }
}

/** Expo's exclusive helper opens an unkeyed connection and runs BEGIN before
 * its callback. Open and key our own isolated connection before BEGIN IMMEDIATE. */
export async function withEncryptedTransaction<T>(
    fn: (db: SQLite.SQLiteDatabase) => Promise<T>,
    options: { blockOnFailure?: boolean } = {},
): Promise<T> {
    let connection: SQLite.SQLiteDatabase | null = null;
    let begun = false;
    let phase: 'open' | 'callback' | 'commit' = 'open';
    try {
        const key = await getDeviceKeyHex('scanner', true);
        connection = await SQLite.openDatabaseAsync(ENCRYPTED_DB_NAME, { useNewConnection: true });
        await unlock(connection, key);
        await connection.execAsync('BEGIN IMMEDIATE;'); begun = true;
        phase = 'callback';
        const result = await fn(connection);
        phase = 'commit';
        await connection.execAsync('COMMIT;'); begun = false;
        return result;
    } catch (error) {
        if (begun) await connection?.execAsync('ROLLBACK;').catch(() => undefined);
        if (phase === 'callback') throw error; // A cancelled application action is not a lost key.
        const reason = error instanceof LocalPrivacyError ? error.reason : 'storage_io';
        if (options.blockOnFailure !== false) {
            usePrivacyStore.getState().block('scanner', 'write', reason);
        }
        throw new LocalPrivacyError(reason);
    } finally { await connection?.closeAsync().catch(() => undefined); }
}
