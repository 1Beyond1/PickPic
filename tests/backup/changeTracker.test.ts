jest.unmock('../../services/backup/changeTracker');

const mockOpenDatabaseAsync = jest.fn();
const mockGetDeviceKeyHex = jest.fn().mockResolvedValue('a'.repeat(64));

jest.mock('expo-sqlite', () => ({
  defaultDatabaseDirectory: '/isolated/db',
  openDatabaseAsync: (...args: unknown[]) => mockOpenDatabaseAsync(...args),
  deleteDatabaseAsync: jest.fn(),
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async (uri: string) => ({
    exists: uri.includes('pickpic_scanner.encrypted-v1.db'),
  })),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/privacy/deviceKey', () => ({
  getDeviceKeyHex: (...args: unknown[]) => mockGetDeviceKeyHex(...args),
}));
jest.mock('../../database/migrations', () => ({
  runMigrations: jest.fn().mockResolvedValue(undefined),
}));

import { closeDatabase, getDatabase } from '../../database/db';
import {
  recordBackupChanges,
  resetBackupChangeState,
  suspendBackupChangeWrites,
  useBackupReminderStore,
} from '../../services/backup/changeTracker';
import { usePrivacyStore } from '../../stores/usePrivacyStore';

describe('changeTracker non-critical write failure isolation (P1-6)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await closeDatabase().catch(() => undefined);
    await resetBackupChangeState();
    usePrivacyStore.setState({ failures: {}, reasons: {}, recoveryDepth: 0, recovering: false });
  });

  it('does NOT trigger usePrivacyStore.block() when a transient SQLITE_BUSY fails reminder persistence', async () => {
    const busyConnection = {
      execAsync: jest.fn(async (sql: string) => {
        if (sql.includes('BEGIN IMMEDIATE')) {
          throw new Error('SQLITE_BUSY: database is locked');
        }
      }),
      getFirstAsync: jest.fn(async (sql: string) => {
        if (sql.includes('cipher_version')) return { cipher_version: '4.5.0' };
        return { 'count(*)': 0 };
      }),
      getAllAsync: jest.fn().mockResolvedValue([]),
      runAsync: jest.fn().mockResolvedValue(undefined),
      closeAsync: jest.fn().mockResolvedValue(undefined),
    };
    mockOpenDatabaseAsync.mockResolvedValue(busyConnection);

    // Open DB cleanly first (matching normal app runtime).
    await getDatabase();
    expect(usePrivacyStore.getState().failures).toEqual({});

    // Now trigger reminder counter write while BEGIN IMMEDIATE throws SQLITE_BUSY.
    await expect(recordBackupChanges(1)).resolves.toBe(1);

    // Crucial: transient reminder write failure MUST NOT kick the app into the privacy lock screen!
    expect(usePrivacyStore.getState().failures).toEqual({});
    expect(usePrivacyStore.getState().reasons).toEqual({});
  });

  it('does NOT force-open SQLCipher or block the privacy gate when database is not open', async () => {
    mockOpenDatabaseAsync.mockRejectedValue(new Error('Storage unavailable'));

    await expect(recordBackupChanges(1)).resolves.toBe(1);

    expect(mockOpenDatabaseAsync).not.toHaveBeenCalled();
    expect(usePrivacyStore.getState().failures).toEqual({});
  });

  it('P1-2: resetBackupChangeState awaits in-flight flushPromise and suspendBackupChangeWrites blocks new writes', async () => {
    let releaseTx!: () => void;
    let txStarted!: () => void;
    const txStartedPromise = new Promise<void>(resolve => { txStarted = resolve; });
    const slowConnection = {
      execAsync: jest.fn(async () => undefined),
      getFirstAsync: jest.fn(async (sql: string) => {
        if (sql.includes('cipher_version')) return { cipher_version: '4.5.0' };
        if (sql.includes('meta')) {
          txStarted();
          await new Promise<void>(resolve => { releaseTx = resolve; });
          return { value: '0' };
        }
        return { 'count(*)': 0 };
      }),
      getAllAsync: jest.fn().mockResolvedValue([]),
      runAsync: jest.fn().mockResolvedValue(undefined),
      closeAsync: jest.fn().mockResolvedValue(undefined),
    };
    mockOpenDatabaseAsync.mockResolvedValue(slowConnection);
    await getDatabase();

    // Start an in-flight change write.
    const writePromise = recordBackupChanges(3);
    await txStartedPromise;

    const resume = suspendBackupChangeWrites();
    let resetFinished = false;
    const resetPromise = resetBackupChangeState().then(() => { resetFinished = true; });

    // A concurrent change while suspended must be ignored and must not reopen/enqueue.
    await expect(recordBackupChanges(5)).resolves.toBe(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resetFinished).toBe(false);

    // Once the in-flight DB transaction completes, resetBackupChangeState resolves cleanly.
    releaseTx();
    await Promise.all([writePromise, resetPromise]);
    resume();

    expect(resetFinished).toBe(true);
    expect(useBackupReminderStore.getState()).toEqual({
      pendingChanges: 0,
      lastBackupAt: null,
      loaded: false,
    });
  });
});
