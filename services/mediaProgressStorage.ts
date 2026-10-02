import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StateStorage } from 'zustand/middleware';

// Serialize persisted decisions so slow earlier writes cannot overwrite newer
// ones. Keep errors observable to an explicit backup/import flush, without
// leaving unhandled promises in Zustand's synchronous action setters.
let queue = Promise.resolve();
let lastWriteFailed = false;
let latest: { name: string; value: string } | null = null;
export const mediaProgressStorage: StateStorage = {
    getItem: async name => { await queue; return AsyncStorage.getItem(name); },
    setItem: (name, value) => {
        latest = { name, value };
        queue = queue.then(async () => {
            try { await AsyncStorage.setItem(name, value); lastWriteFailed = false; }
            catch { lastWriteFailed = true; }
        });
    },
    removeItem: async name => { await queue; await AsyncStorage.removeItem(name); },
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
