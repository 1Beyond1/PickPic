import { getRandomBytesAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { bytesToHex } from '@noble/hashes/utils.js';
import { LocalPrivacyError, DeviceKeyScope } from '../../stores/usePrivacyStore';

const options: SecureStore.SecureStoreOptions = {
    keychainService: 'pickpic.local-records.v1',
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const queues = new Map<DeviceKeyScope, Promise<unknown>>();

function keySlot(scope: DeviceKeyScope): string {
    return `pickpic.${scope}.v1`;
}

/** No regenerated key may replace a missing key for existing ciphertext. Each
 * purpose has a separate random key; reads are serialized, never cached on disk. */
export function getDeviceKeyHex(scope: DeviceKeyScope, existingCiphertext: boolean): Promise<string> {
    const operation = (queues.get(scope) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        try {
            const slot = keySlot(scope);
            const saved = await SecureStore.getItemAsync(slot, options);
            if (saved !== null) {
                if (!/^[a-f0-9]{64}$/.test(saved)) throw new LocalPrivacyError('keystore_unavailable');
                return saved;
            }
            if (existingCiphertext) throw new LocalPrivacyError('keystore_unavailable');
            const bytes = await getRandomBytesAsync(32);
            try {
                if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new LocalPrivacyError('keystore_unavailable');
                const key = bytesToHex(bytes);
                await SecureStore.setItemAsync(slot, key, options);
                if (await SecureStore.getItemAsync(slot, options) !== key) throw new LocalPrivacyError('keystore_unavailable');
                return key;
            } finally { bytes.fill(0); }
        } catch (error) {
            throw error instanceof LocalPrivacyError ? error : new LocalPrivacyError('keystore_unavailable');
        }
    });
    queues.set(scope, operation.then(() => undefined, () => undefined));
    return operation;
}

const PROBE_SLOT = 'pickpic.keystore-probe.v1';

/** Non-destructive keystore health probe run BEFORE wiping local ciphertext:
 * verifies CSPRNG + SecureStore write/read/delete on an isolated probe slot so
 * a temporarily locked/broken Keystore never destroys recoverable local data. */
export async function probeDeviceKeystore(): Promise<void> {
    let bytes: Uint8Array | undefined;
    try {
        bytes = await getRandomBytesAsync(32);
        if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
            throw new LocalPrivacyError('keystore_unavailable');
        }
        const probeValue = bytesToHex(bytes);
        await SecureStore.setItemAsync(PROBE_SLOT, probeValue, options);
        const readBack = await SecureStore.getItemAsync(PROBE_SLOT, options);
        if (readBack !== probeValue) {
            throw new LocalPrivacyError('keystore_unavailable');
        }
    } catch (error) {
        throw error instanceof LocalPrivacyError ? error : new LocalPrivacyError('keystore_unavailable');
    } finally {
        bytes?.fill(0);
        if (typeof SecureStore.deleteItemAsync === 'function') {
            await SecureStore.deleteItemAsync(PROBE_SLOT, options).catch(() => undefined);
        }
    }
}

/** Explicit user-confirmed self-rescue only: removes the device key for a scope
 * so a fresh encrypted store can be initialized after irrecoverable key/DB loss. */
export function deleteDeviceKey(scope: DeviceKeyScope): Promise<void> {
    const operation = (queues.get(scope) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        try {
            if (typeof SecureStore.deleteItemAsync === 'function') {
                await SecureStore.deleteItemAsync(keySlot(scope), options);
            }
        } catch {
            throw new LocalPrivacyError('keystore_unavailable');
        }
    });
    queues.set(scope, operation.then(() => undefined, () => undefined));
    return operation;
}
