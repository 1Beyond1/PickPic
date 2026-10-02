jest.mock('expo-sqlite', () => ({ defaultDatabaseDirectory: '/isolated/SQLite', openDatabaseAsync: jest.fn(), deleteDatabaseAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('../../services/privacy/deviceKey', () => ({ getDeviceKeyHex: jest.fn() }));
import { DatabaseSync } from 'node:sqlite';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { getDeviceKeyHex } from '../../services/privacy/deviceKey';
import { ENCRYPTED_DB_NAME, openEncryptedDatabase, withEncryptedTransaction } from '../../database/encryptedDatabase';
import { DB_NAME } from '../../database/schema';
import { usePrivacyStore } from '../../stores/usePrivacyStore';

// Real SQLite validates queries, row comparisons and rollback. SQLCipher-only
// commands are a contract boundary; ciphertext itself must be verified natively.
const key = 'ab'.repeat(32);
let files: Set<string>, databases: Map<string, DatabaseSync>, allDatabases: DatabaseSync[], events: string[];
let cipherAvailable: boolean, tamperExport: boolean, busy: boolean, failCommit: boolean;
const fileName = (path: string) => path.split('/').pop()!;
function raw(name: string) {
    let db = databases.get(name);
    if (!db) { db = new DatabaseSync(':memory:'); databases.set(name, db); allDatabases.push(db); }
    return db;
}
function adapter(name: string): SQLite.SQLiteDatabase {
    const db = raw(name);
    return {
        execAsync: async (sql: string) => {
            events.push(`${name}:${sql}`);
            if (sql.startsWith('PRAGMA key')) return;
            if (sql.startsWith('DETACH')) return;
            if (sql === 'COMMIT;' && failCommit) throw new Error('commit unavailable');
            const destination = sql.includes('encrypted.') ? raw(ENCRYPTED_DB_NAME) : db;
            destination.exec(sql.replace('encrypted.', ''));
        },
        runAsync: async (sql: string, params: any[] = []) => {
            if (sql.startsWith('ATTACH')) {
                raw(ENCRYPTED_DB_NAME); files.add(ENCRYPTED_DB_NAME);
                return { changes: 0, lastInsertRowId: 0 };
            }
            const destination = sql.includes('encrypted.') ? raw(ENCRYPTED_DB_NAME) : db;
            const result = destination.prepare(sql.replace('encrypted.', '')).run(...params);
            return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
        },
        getFirstAsync: async (sql: string, params: any[] = []) => {
            if (sql === 'PRAGMA cipher_version;') return cipherAvailable ? { cipher_version: '4.6.1' } : null;
            if (sql.startsWith('PRAGMA wal_checkpoint')) return { busy: busy ? 1 : 0 };
            if (sql.includes('sqlcipher_export')) {
                const target = raw(ENCRYPTED_DB_NAME);
                const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
                for (const table of tables) {
                    target.exec(String(table.sql));
                    const quoted = `"${String(table.name).replace(/"/g, '""')}"`;
                    const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
                    for (const row of rows) target.prepare(`INSERT INTO ${quoted} VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
                }
                if (tamperExport) target.exec("UPDATE assets SET label='wrong' WHERE id='photo-1'");
                return { sqlcipher_export: null };
            }
            return db.prepare(sql).get(...params) ?? null;
        },
        getAllAsync: async (sql: string, params: any[] = []) => {
            if (sql === 'PRAGMA cipher_integrity_check;') return [];
            return db.prepare(sql).all(...params);
        },
        getEachAsync: async function* (sql: string) {
            events.push(`${name}:compare`);
            for (const row of db.prepare(sql).iterate()) yield row;
        },
        withTransactionAsync: async (callback: () => Promise<void>) => {
            db.exec('BEGIN');
            try { await callback(); db.exec('COMMIT'); }
            catch (error) { db.exec('ROLLBACK'); throw error; }
        },
        closeAsync: async () => { events.push(`${name}:close`); },
    } as unknown as SQLite.SQLiteDatabase;
}
beforeEach(() => {
    files = new Set(); databases = new Map(); allDatabases = []; events = [];
    cipherAvailable = true; tamperExport = false; busy = false; failCommit = false;
    usePrivacyStore.setState({ failures: {} });
    jest.mocked(getDeviceKeyHex).mockResolvedValue(key);
    jest.mocked(FileSystem.getInfoAsync).mockImplementation(async path => ({ exists: files.has(fileName(path)) } as any));
    jest.mocked(FileSystem.deleteAsync).mockImplementation(async path => { events.push(`delete:${fileName(path)}`); files.delete(fileName(path)); });
    jest.mocked(SQLite.openDatabaseAsync).mockImplementation(async name => { files.add(name); return adapter(name); });
    jest.mocked(SQLite.deleteDatabaseAsync).mockImplementation(async name => { events.push(`delete:${name}`); files.delete(name); databases.delete(name); });
});
afterEach(() => { for (const db of allDatabases) db.close(); });
function legacy() {
    files.add(DB_NAME); files.add(DB_NAME + '-wal'); files.add(DB_NAME + '-shm');
    raw(DB_NAME).exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('version','4'); CREATE TABLE assets(id TEXT PRIMARY KEY, label TEXT); INSERT INTO assets VALUES('photo-1','cat'),('photo-2','dog'); CREATE TABLE future(a TEXT, b INTEGER, PRIMARY KEY(a,b)) WITHOUT ROWID; INSERT INTO future VALUES('item',2);");
}

it('verifies all legacy tables before deleting only the old database and its companions', async () => {
    legacy();
    await openEncryptedDatabase();
    expect(raw(ENCRYPTED_DB_NAME).prepare('SELECT label FROM assets ORDER BY id').all()).toEqual([{ label: 'cat' }, { label: 'dog' }]);
    expect(raw(ENCRYPTED_DB_NAME).prepare('SELECT * FROM future').get()).toEqual({ a: 'item', b: 2 });
    expect(files.has(DB_NAME)).toBe(false); expect(files.has(DB_NAME + '-wal')).toBe(false);
    const lastComparison = events.lastIndexOf(`${ENCRYPTED_DB_NAME}:compare`);
    expect(events.indexOf(`delete:${DB_NAME}`)).toBeGreaterThan(lastComparison);
    expect(events.indexOf(`delete:${DB_NAME}-wal`)).toBeGreaterThan(events.indexOf(`delete:${DB_NAME}`));
    expect(getDeviceKeyHex).toHaveBeenCalledWith('scanner', false);
});

it('does not remove any source records when the migrated copy differs', async () => {
    legacy(); tamperExport = true;
    await expect(openEncryptedDatabase()).rejects.toThrow('original data was preserved');
    expect(files.has(DB_NAME)).toBe(true); expect(files.has(DB_NAME + '-wal')).toBe(true);
    expect(raw(DB_NAME).prepare("SELECT label FROM assets WHERE id='photo-1'").get()).toEqual({ label: 'cat' });
    expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalledWith(DB_NAME);
    expect(usePrivacyStore.getState().failures.scanner).toBe('read');
});

it('refuses a no-op encryption pragma and preserves the plaintext source', async () => {
    legacy(); cipherAvailable = false;
    await expect(openEncryptedDatabase()).rejects.toThrow();
    expect(files.has(DB_NAME)).toBe(true);
    expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalled();
});

it('retains the source when another connection prevents the final WAL checkpoint', async () => {
    legacy(); busy = true;
    await expect(openEncryptedDatabase()).rejects.toThrow();
    expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalledWith(DB_NAME);
});

it('does not open or replace existing ciphertext when its key is unavailable', async () => {
    files.add(ENCRYPTED_DB_NAME);
    jest.mocked(getDeviceKeyHex).mockRejectedValueOnce(new Error('key missing'));
    await expect(openEncryptedDatabase()).rejects.toThrow();
    expect(getDeviceKeyHex).toHaveBeenCalledWith('scanner', true);
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
    expect(files.has(ENCRYPTED_DB_NAME)).toBe(true);
});

it('keys an isolated transaction before BEGIN and rolls back a cancelled action without reporting key loss', async () => {
    await openEncryptedDatabase(); events = [];
    await expect(withEncryptedTransaction(async db => {
        await db.execAsync('CREATE TABLE cancelled(id TEXT)');
        throw new Error('user cancelled');
    })).rejects.toThrow('user cancelled');
    expect(events.findIndex(event => event.includes('PRAGMA key'))).toBeLessThan(events.indexOf(`${ENCRYPTED_DB_NAME}:BEGIN IMMEDIATE;`));
    expect(raw(ENCRYPTED_DB_NAME).prepare("SELECT name FROM sqlite_master WHERE name='cancelled'").get()).toBeUndefined();
    expect(usePrivacyStore.getState().failures).toEqual({});
});

it('reports failed commits as protected write failures and rolls back changes', async () => {
    await openEncryptedDatabase(); failCommit = true;
    await expect(withEncryptedTransaction(async db => { await db.execAsync('CREATE TABLE lost(id TEXT)'); })).rejects.toThrow('original data was preserved');
    expect(raw(ENCRYPTED_DB_NAME).prepare("SELECT name FROM sqlite_master WHERE name='lost'").get()).toBeUndefined();
    expect(usePrivacyStore.getState().failures.scanner).toBe('write');
});
