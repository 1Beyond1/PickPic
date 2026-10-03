import AsyncStorage from '@react-native-async-storage/async-storage';
import { gcm } from '@noble/ciphers/aes.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { getRandomBytesAsync } from 'expo-crypto';
import { fromByteArray, toByteArray } from 'react-native-quick-base64';
import type { StateStorage } from 'zustand/middleware';
import { getDeviceKeyHex } from './deviceKey';
import { LocalPrivacyError, DeviceKeyScope, usePrivacyStore } from '../../stores/usePrivacyStore';
import { isOrganizingSession } from '../organizingSession';

const suffix = '.encrypted-v1';
const prefix = 'PKLOCAL1:';
const readyNames = new Map<DeviceKeyScope, Set<string>>();
const hydratedNames = new Map<DeviceKeyScope, Set<string>>();
export function canWriteEncryptedStorage(scope: DeviceKeyScope, name: string): boolean {
    return !!readyNames.get(scope)?.has(name) && !!hydratedNames.get(scope)?.has(name);
}
export function markEncryptedStorageHydrated(scope: DeviceKeyScope, name: string): void {
    if (!readyNames.get(scope)?.has(name)) throw new LocalPrivacyError();
    const names = hydratedNames.get(scope) ?? new Set<string>();
    names.add(name); hydratedNames.set(scope, names);
    usePrivacyStore.getState().clear(scope);
}
function validateState(value: string): void {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !('state' in parsed)
        || !parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) throw new LocalPrivacyError();
    // Zustand silently falls back to defaults for an unsupported persisted
    // version without a migration function. Never remove that source first.
    if ('version' in parsed && parsed.version !== 0) throw new LocalPrivacyError();
    const state = parsed.state as Record<string, unknown>;
    for (const name of ['photoProcessedIds', 'videoProcessedIds', 'selectedAlbumIds', 'activeCollectionIds']) {
        if (name in state && (!Array.isArray(state[name]) || !(state[name] as unknown[]).every(id => typeof id === 'string' && id.length > 0))) throw new LocalPrivacyError();
    }
    for (const name of ['deleteQueue', 'collectionQueue', 'videoTrashBin']) {
        if (name in state && (!Array.isArray(state[name]) || !(state[name] as unknown[]).every(item =>
            !!item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' && item.id.length > 0))) throw new LocalPrivacyError();
    }
    if ('pendingDeletionInfo' in state) {
        const info = state.pendingDeletionInfo;
        if (!info || typeof info !== 'object' || Array.isArray(info)) throw new LocalPrivacyError();
        for (const value of Object.values(info)) {
            if (!value || typeof value !== 'object' || !('source' in value) || !('addedAt' in value)
                || !['photos', 'videos', 'blur', 'similar', 'classification', 'unknown'].includes(String(value.source))
                || !Number.isSafeInteger(value.addedAt) || Number(value.addedAt) < 0) throw new LocalPrivacyError();
        }
    }
    if ('deletedCounts' in state) {
        const counts = state.deletedCounts;
        if (!counts || typeof counts !== 'object' || !('photos' in counts) || !('videos' in counts)
            || ![counts.photos, counts.videos].every(value => Number.isSafeInteger(value) && Number(value) >= 0)) throw new LocalPrivacyError();
    }
    if ('organizingSessions' in state) {
        const sessions = state.organizingSessions;
        if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)
            || Object.keys(sessions).sort().join(',') !== 'photo,video') throw new LocalPrivacyError();
        for (const kind of ['photo', 'video'] as const) {
            const session = (sessions as Record<string, unknown>)[kind];
            if (session !== null && (!isOrganizingSession(session) || session.kind !== kind)) throw new LocalPrivacyError();
        }
    }
}
function aad(name: string): Uint8Array { return new TextEncoder().encode(`PickPic/local/v1/${name}`); }
async function seal(name: string, value: string, scope: DeviceKeyScope, exists: boolean): Promise<string> {
    validateState(value);
    const key = hexToBytes(await getDeviceKeyHex(scope, exists));
    const clear = new TextEncoder().encode(value);
    try {
        const nonce = await getRandomBytesAsync(12);
        if (!(nonce instanceof Uint8Array) || nonce.length !== 12) throw new LocalPrivacyError();
        const cipher = gcm(key, nonce, aad(name)).encrypt(clear);
        return `${prefix}${bytesToHex(nonce)}:${fromByteArray(cipher)}`;
    } finally { key.fill(0); clear.fill(0); }
}
async function unseal(name: string, value: string, scope: DeviceKeyScope): Promise<string> {
    if (!value.startsWith(prefix)) throw new LocalPrivacyError();
    const parts = value.slice(prefix.length).split(':');
    if (parts.length !== 2 || !/^[a-f0-9]{24}$/.test(parts[0]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) throw new LocalPrivacyError();
    const key = hexToBytes(await getDeviceKeyHex(scope, true));
    let clear: Uint8Array | undefined;
    try {
        clear = gcm(key, hexToBytes(parts[0]), aad(name)).decrypt(toByteArray(parts[1]));
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(clear);
        validateState(decoded);
        return decoded;
    } finally { key.fill(0); clear?.fill(0); }
}

/** A failed read never enables writes of default state. Migration reads back
 * and authenticates the new copy before removing the legacy AsyncStorage key. */
export function createEncryptedStorage(scope: DeviceKeyScope): StateStorage {
    const ready = new Set<string>();
    readyNames.set(scope, ready);
    return {
        async getItem(name) {
            ready.delete(name);
            hydratedNames.get(scope)?.delete(name);
            try {
                const encrypted = await AsyncStorage.getItem(name + suffix);
                const legacy = await AsyncStorage.getItem(name);
                let decoded: string | null = null;
                if (encrypted !== null) decoded = await unseal(name, encrypted, scope);
                else if (legacy !== null) {
                    validateState(legacy);
                    await AsyncStorage.setItem(name + suffix, await seal(name, legacy, scope, false));
                    const saved = await AsyncStorage.getItem(name + suffix);
                    if (saved === null || await unseal(name, saved, scope) !== legacy) throw new LocalPrivacyError();
                    decoded = legacy;
                }
                if (legacy !== null) await AsyncStorage.removeItem(name);
                ready.add(name);
                return decoded;
            } catch {
                ready.delete(name);
                usePrivacyStore.getState().block(scope, 'read');
                throw new LocalPrivacyError();
            }
        },
        async setItem(name, value) {
            try {
                if (!ready.has(name)) throw new LocalPrivacyError();
                const exists = await AsyncStorage.getItem(name + suffix) !== null;
                await AsyncStorage.setItem(name + suffix, await seal(name, value, scope, exists));
                usePrivacyStore.getState().clear(scope);
            } catch {
                usePrivacyStore.getState().block(scope, 'write');
                throw new LocalPrivacyError();
            }
        },
        async removeItem(name) {
            // There is no UI clear-storage escape hatch during a failed read.
            if (!ready.has(name)) throw new LocalPrivacyError();
            await AsyncStorage.removeItem(name + suffix);
            await AsyncStorage.removeItem(name);
        },
    };
}
export const encryptedRecordStorage = createEncryptedStorage('records');
export const encryptedSettingsStorage = createEncryptedStorage('settings');
