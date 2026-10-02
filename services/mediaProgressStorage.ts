import { canWriteEncryptedStorage, encryptedRecordStorage } from './privacy/encryptedStorage';
import type { StateStorage } from 'zustand/middleware';

// Serialize persisted decisions so slow earlier writes cannot overwrite newer
// ones. Keep errors observable to an explicit backup/import flush, without
// leaving unhandled promises in Zustand's synchronous action setters.
let queue = Promise.resolve();
let lastWriteFailed = false;
let latest: { name: string; value: string } | null = null;
export const mediaProgressStorage: StateStorage = {
    getItem: async name => { await queue; return encryptedRecordStorage.getItem(name); },
    setItem: (name, value) => {
        // Permission/count setters can run before automatic hydration. Their
        // default snapshots are never allowed to replace a stored decision.
        if (!canWriteEncryptedStorage('records', name)) return;
        latest = { name, value };
        queue = queue.then(async () => {
            try { await encryptedRecordStorage.setItem(name, value); lastWriteFailed = false; }
            catch { lastWriteFailed = true; }
        });
    },
    removeItem: async name => { await queue; await encryptedRecordStorage.removeItem(name); },
};
export async function flushMediaProgress(): Promise<void> {
    // Include writes added by an in-flight gallery event while we awaited.
    let observed: Promise<void>;
    do { observed = queue; await observed; } while (observed !== queue);
    if (lastWriteFailed && latest) {
        // Permit recovery after storage becomes available again. A failed
        // import must not permanently lock every subsequent transfer.
        mediaProgressStorage.setItem(latest.name, latest.value);
        do { observed = queue; await observed; } while (observed !== queue);
    }
    if (lastWriteFailed) throw new Error('Could not persist organizing records');
}
