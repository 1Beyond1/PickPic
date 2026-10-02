import { getRandomBytesAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { bytesToHex } from '@noble/hashes/utils.js';
import { LocalPrivacyError, DeviceKeyScope } from '../../stores/usePrivacyStore';

const options: SecureStore.SecureStoreOptions = {
    keychainService: 'pickpic.local-records.v1',
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const queues = new Map<DeviceKeyScope, Promise<unknown>>();

/** No regenerated key may replace a missing key for existing ciphertext. Each
 * purpose has a separate random key; reads are serialized, never cached on disk. */
export function getDeviceKeyHex(scope: DeviceKeyScope, existingCiphertext: boolean): Promise<string> {
    const operation = (queues.get(scope) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        try {
            const slot = `pickpic.${scope}.v1`;
            const saved = await SecureStore.getItemAsync(slot, options);
            if (saved !== null) {
                if (!/^[a-f0-9]{64}$/.test(saved)) throw new LocalPrivacyError();
                return saved;
            }
            if (existingCiphertext) throw new LocalPrivacyError();
            const bytes = await getRandomBytesAsync(32);
            try {
                if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new LocalPrivacyError();
                const key = bytesToHex(bytes);
                await SecureStore.setItemAsync(slot, key, options);
                if (await SecureStore.getItemAsync(slot, options) !== key) throw new LocalPrivacyError();
                return key;
            } finally { bytes.fill(0); }
        } catch { throw new LocalPrivacyError(); }
    });
    queues.set(scope, operation.then(() => undefined, () => undefined));
    return operation;
}
