jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('../../database/encryptedDatabase', () => ({ openEncryptedDatabase: jest.fn(), withEncryptedTransaction: jest.fn() }));
jest.mock('../../database/migrations', () => ({ runMigrations: jest.fn() }));
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { openEncryptedDatabase, withEncryptedTransaction } from '../../database/encryptedDatabase';
import { runMigrations } from '../../database/migrations';
import { closeDatabase, getDatabase, withTransaction } from '../../database/db';
import { usePrivacyStore } from '../../stores/usePrivacyStore';

beforeEach(() => { Platform.OS = 'web'; usePrivacyStore.setState({ failures: {} }); });
afterEach(async () => { await closeDatabase(); });
it('does not open a plaintext browser database when native protection is unavailable', async () => {
    await expect(getDatabase()).rejects.toThrow('original data was preserved');
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled(); expect(openEncryptedDatabase).not.toHaveBeenCalled();
    expect(usePrivacyStore.getState().failures.scanner).toBe('read');
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
