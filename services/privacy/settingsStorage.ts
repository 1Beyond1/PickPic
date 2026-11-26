import type { StateStorage } from 'zustand/middleware';
import { canWriteEncryptedStorage, encryptedSettingsStorage } from './encryptedStorage';

// Zustand callers are synchronous; observe failures in the privacy gate and
// keep the last intended value available for explicit retry.
let queue = Promise.resolve();
let failed = false;
let latest: { name: string; value: string } | null = null;
let writeSuspendDepth = 0;

/** Blocks new settings writes during self-rescue reset until resumed. */
export function suspendSettingsWrites(): () => void {
    let released = false;
    writeSuspendDepth++;
    return () => {
        if (released) return;
        released = true;
        writeSuspendDepth = Math.max(0, writeSuspendDepth - 1);
    };
}

export const settingsStorage: StateStorage = {
    async getItem(name) { await queue; return encryptedSettingsStorage.getItem(name); },
    setItem(name, value) {
        if (writeSuspendDepth > 0 || !canWriteEncryptedStorage('settings', name)) return;
        latest = { name, value };
        queue = queue.then(async () => {
            if (writeSuspendDepth > 0) return;
            try { await encryptedSettingsStorage.setItem(name, value); failed = false; }
            catch { failed = true; }
        });
    },
    async removeItem(name) { await queue; await encryptedSettingsStorage.removeItem(name); },
};
export async function resetSettingsPersistenceState(): Promise<void> {
    latest = null;
    let observed;
    do { observed = queue; await observed.catch(() => undefined); } while (observed !== queue);
    failed = false;
    latest = null;
}

export async function flushSettings(): Promise<void> {
    let observed;
    do { observed = queue; await observed; } while (observed !== queue);
    if (failed && latest) {
        settingsStorage.setItem(latest.name, latest.value);
        do { observed = queue; await observed; } while (observed !== queue);
    }
    if (failed) throw new Error('Could not persist preferences');
}
