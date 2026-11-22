jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('../../database/encryptedDatabase', () => ({ openEncryptedDatabase: jest.fn(), withEncryptedTransaction: jest.fn() }));
jest.mock('../../database/migrations', () => ({ runMigrations: jest.fn() }));
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { openEncryptedDatabase, withEncryptedTransaction } from '../../database/encryptedDatabase';
import { runMigrations } from '../../database/migrations';
import { closeDatabase, getDatabase, withTransaction } from '../../database/db';
import { LocalPrivacyError, usePrivacyStore } from '../../stores/usePrivacyStore';

beforeEach(() => { Platform.OS = 'web'; usePrivacyStore.setState({ failures: {}, reasons: {} }); });
afterEach(async () => { await closeDatabase(); });
it('does not open a plaintext browser database when native protection is unavailable', async () => {
    await expect(getDatabase()).rejects.toThrow('original data was preserved');
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled(); expect(openEncryptedDatabase).not.toHaveBeenCalled();
    expect(usePrivacyStore.getState().failures.scanner).toBe('read');
    expect(usePrivacyStore.getState().reasons.scanner).toBe('keystore_unavailable');
});
it('classifies keystore, sqlcipher decrypt, and schema migration failures into distinct domains', async () => {
    Platform.OS = 'android';
    jest.mocked(openEncryptedDatabase).mockRejectedValueOnce(new LocalPrivacyError('keystore_unavailable'));
    await expect(getDatabase()).rejects.toThrow('original data was preserved');
    expect(usePrivacyStore.getState().reasons.scanner).toBe('keystore_unavailable');

    jest.mocked(openEncryptedDatabase).mockRejectedValueOnce(new Error('SQLCipher decrypt failed'));
    await expect(getDatabase()).rejects.toThrow('original data was preserved');
    expect(usePrivacyStore.getState().reasons.scanner).toBe('cipher_decrypt_failed');

    const db = { execAsync: jest.fn().mockResolvedValue(undefined), closeAsync: jest.fn().mockResolvedValue(undefined) } as any;
    jest.mocked(openEncryptedDatabase).mockResolvedValueOnce(db);
    jest.mocked(runMigrations).mockRejectedValueOnce(new Error('schema mismatch'));
    await expect(getDatabase()).rejects.toThrow('original data was preserved');
    expect(usePrivacyStore.getState().reasons.scanner).toBe('schema_corrupt');
});
it('closes failed native initialization, reports a non-sensitive gate and permits explicit retry', async () => {
    Platform.OS = 'android';
    const db = { execAsync: jest.fn().mockResolvedValue(undefined), closeAsync: jest.fn().mockResolvedValue(undefined) } as any;
    jest.mocked(openEncryptedDatabase).mockResolvedValue(db);
    jest.mocked(runMigrations).mockRejectedValueOnce(new Error('private path and SQL')).mockResolvedValueOnce(undefined);
    await expect(getDatabase()).rejects.toThrow('original data was preserved');
    expect(db.closeAsync).toHaveBeenCalledTimes(1);
    expect(await getDatabase()).toBe(db);
    expect(usePrivacyStore.getState().failures.scanner).toBeUndefined();
    expect(openEncryptedDatabase).toHaveBeenCalledTimes(2);
});
it('runs application transactions through the keyed helper instead of an unkeyed Expo transaction', async () => {
    Platform.OS = 'android';
    const db = { execAsync: jest.fn().mockResolvedValue(undefined), closeAsync: jest.fn().mockResolvedValue(undefined) } as any;
    jest.mocked(openEncryptedDatabase).mockResolvedValue(db);
    jest.mocked(withEncryptedTransaction).mockImplementation(async fn => fn(db));
    expect(await withTransaction(async passed => passed === db ? 'ok' : 'wrong')).toBe('ok');
    expect(withEncryptedTransaction).toHaveBeenCalledTimes(1);
    expect(db.execAsync).not.toHaveBeenCalledWith('BEGIN TRANSACTION;');
});
it('waits for in-flight initialization and queued transactions before closing the connection', async () => {
    Platform.OS = 'android';
    let releaseInit!: (value: any) => void;
    let releaseTx!: () => void;
    const db = { execAsync: jest.fn().mockResolvedValue(undefined), closeAsync: jest.fn().mockResolvedValue(undefined) } as any;
    jest.mocked(openEncryptedDatabase).mockReturnValueOnce(new Promise(resolve => { releaseInit = resolve; }));
    jest.mocked(withEncryptedTransaction).mockImplementationOnce(async fn => fn(db));

    const events: string[] = [];
    const txPromise = withTransaction(async () => {
        events.push('tx-start');
        await new Promise<void>(resolve => { releaseTx = resolve; });
        events.push('tx-end');
        return 'done';
    });

    const closePromise = closeDatabase().then(() => { events.push('closed'); });
    await Promise.resolve();
    expect(db.closeAsync).not.toHaveBeenCalled();

    releaseInit(db);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['tx-start']);
    expect(db.closeAsync).not.toHaveBeenCalled();

    releaseTx();
    expect(await txPromise).toBe('done');
    await closePromise;
    expect(events).toEqual(['tx-start', 'tx-end', 'closed']);
    expect(db.closeAsync).toHaveBeenCalledTimes(1);
});
