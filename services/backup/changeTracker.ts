import { create } from 'zustand';
import { getDatabase, withTransaction } from '../../database/db';
import { MetaKeys } from '../../database/schema';
import { usePrivacyStore } from '../../stores/usePrivacyStore';

export const BACKUP_REMINDER_THRESHOLD = 20;

export interface BackupChangeState {
    pendingChanges: number;
    lastBackupAt: number | null;
    loaded: boolean;
}

export const useBackupReminderStore = create<BackupChangeState>(() => ({
    pendingChanges: 0,
    lastBackupAt: null,
    loaded: false,
}));

function parseNonNegativeInt(raw: string | null): number | null {
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

let pendingDelta = 0;
let flushPromise: Promise<void> | null = null;
let writeSuspendDepth = 0;

/** Blocks new backup-reminder writes during self-rescue reset until resumed. */
export function suspendBackupChangeWrites(): () => void {
    let released = false;
    writeSuspendDepth++;
    pendingDelta = 0;
    return () => {
        if (released) return;
        released = true;
        writeSuspendDepth = Math.max(0, writeSuspendDepth - 1);
    };
}

function scheduleFlush(): Promise<void> {
    if (flushPromise) return flushPromise;
    if (writeSuspendDepth > 0) {
        pendingDelta = 0;
        return Promise.resolve();
    }
    flushPromise = Promise.resolve()
        .then(async () => {
            while (pendingDelta > 0) {
                if (writeSuspendDepth > 0 || Object.keys(usePrivacyStore.getState().failures).length > 0) {
                    pendingDelta = 0;
                    break;
                }
                const delta = pendingDelta;
                pendingDelta = 0;
                const nextCount = await withTransaction(async db => {
                    const row = await db.getFirstAsync<{ value: string }>(
                        'SELECT value FROM meta WHERE key = ?',
                        [MetaKeys.BACKUP_PENDING_CHANGES],
                    );
                    const current = parseNonNegativeInt(row?.value ?? null) ?? 0;
                    const updated = current + delta;
                    await db.runAsync(
                        'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
                        [MetaKeys.BACKUP_PENDING_CHANGES, String(updated)],
                    );
                    return updated;
                }, { blockOnFailure: false });
                if (writeSuspendDepth > 0) {
                    pendingDelta = 0;
                    break;
                }
                useBackupReminderStore.setState({
                    pendingChanges: nextCount + pendingDelta,
                    loaded: true,
                });
            }
        })
        .catch(() => {
            // Non-critical reminder metadata must never break user organizing actions.
        })
        .finally(() => {
            flushPromise = null;
        });
    return flushPromise;
}

export async function loadBackupChangeState(): Promise<{ pendingChanges: number; lastBackupAt: number | null }> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<{ key: string; value: string }>(
        'SELECT key, value FROM meta WHERE key IN (?, ?)',
        [MetaKeys.BACKUP_PENDING_CHANGES, MetaKeys.BACKUP_LAST_EXPORTED_AT],
    );
    let pendingChanges = 0;
    let lastBackupAt: number | null = null;
    for (const row of rows) {
        if (row.key === MetaKeys.BACKUP_PENDING_CHANGES) {
            pendingChanges = parseNonNegativeInt(row.value) ?? 0;
        } else if (row.key === MetaKeys.BACKUP_LAST_EXPORTED_AT) {
            lastBackupAt = parseNonNegativeInt(row.value);
        }
    }
    useBackupReminderStore.setState({
        pendingChanges: pendingChanges + pendingDelta,
        lastBackupAt,
        loaded: true,
    });
    return { pendingChanges: pendingChanges + pendingDelta, lastBackupAt };
}

export async function recordBackupChanges(delta = 1): Promise<number> {
    if (writeSuspendDepth > 0 || !Number.isSafeInteger(delta) || delta <= 0) {
        return useBackupReminderStore.getState().pendingChanges;
    }
    pendingDelta += delta;
    useBackupReminderStore.setState(state => ({
        pendingChanges: state.pendingChanges + delta,
    }));
    await scheduleFlush();
    return useBackupReminderStore.getState().pendingChanges;
}

export async function markBackupCompleted(timestamp = Date.now()): Promise<void> {
    const safeTimestamp = Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Date.now();
    // Drain any in-flight increment first, then clear delta & reset counter to 0.
    while (flushPromise) {
        const observed = flushPromise;
        await observed.catch(() => undefined);
    }
    pendingDelta = 0;
    if (writeSuspendDepth > 0) return;
    await withTransaction(async db => {
        await db.runAsync(
            'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
            [MetaKeys.BACKUP_PENDING_CHANGES, '0'],
        );
        await db.runAsync(
            'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
            [MetaKeys.BACKUP_LAST_EXPORTED_AT, String(safeTimestamp)],
        );
    }, { blockOnFailure: false });
    useBackupReminderStore.setState({
        pendingChanges: 0,
        lastBackupAt: safeTimestamp,
        loaded: true,
    });
}

export async function resetBackupChangeState(): Promise<void> {
    pendingDelta = 0;
    useBackupReminderStore.setState({
        pendingChanges: 0,
        lastBackupAt: null,
        loaded: false,
    });
    while (flushPromise) {
        const observed = flushPromise;
        await observed.catch(() => undefined);
    }
    pendingDelta = 0;
    useBackupReminderStore.setState({
        pendingChanges: 0,
        lastBackupAt: null,
        loaded: false,
    });
}
