jest.unmock('../../services/privacy/encryptedStorage');
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7, getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn() }));
jest.mock('react-native-quick-base64', () => ({
    fromByteArray: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    toByteArray: (encoded: string) => new Uint8Array(Buffer.from(encoded, 'base64')),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytesAsync } from 'expo-crypto';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { canWriteEncryptedStorage, createEncryptedStorage, markEncryptedStorageHydrated } from '../../services/privacy/encryptedStorage';
import { usePrivacyStore } from '../../stores/usePrivacyStore';

const name = 'photoapp-media-progress';
const encryptedName = name + '.encrypted-v1';
const legacy = JSON.stringify({ state: { photoProcessedIds: ['fixture-id'], deleteQueue: [{ id: 'fixture-delete' }] }, version: 0 });
let disk: Map<string, string>, keys: Map<string, string>;
beforeEach(() => {
    disk = new Map(); keys = new Map(); usePrivacyStore.setState({ failures: {} });
    jest.mocked(AsyncStorage.getItem).mockImplementation(async key => disk.get(key) ?? null);
    jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => { disk.set(key, value); });
    jest.mocked(AsyncStorage.removeItem).mockImplementation(async key => { disk.delete(key); });
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async key => keys.get(key) ?? null);
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => { keys.set(key, value); });
    jest.mocked(getRandomBytesAsync).mockImplementation(async count => new Uint8Array(randomBytes(count)));
});

it('migrates decisions into authenticated ciphertext and independently decrypts with Node', async () => {
    disk.set(name, legacy);
    const storage = createEncryptedStorage('records');
    expect(await storage.getItem(name)).toBe(legacy);
    expect(disk.has(name)).toBe(false);
    const encoded = disk.get(encryptedName)!;
    expect(encoded).not.toContain('fixture-id'); expect(encoded).not.toContain('deleteQueue');
    const [, nonce, payload] = encoded.split(':');
    const bytes = Buffer.from(payload, 'base64');
    const decryptor = createDecipheriv('aes-256-gcm', Buffer.from(keys.get('pickpic.records.v1')!, 'hex'), Buffer.from(nonce, 'hex'));
    decryptor.setAAD(Buffer.from(`PickPic/local/v1/${name}`)); decryptor.setAuthTag(bytes.subarray(-16));
    expect(Buffer.concat([decryptor.update(bytes.subarray(0, -16)), decryptor.final()]).toString('utf8')).toBe(legacy);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('pickpic.records.v1', expect.any(String), expect.objectContaining({ keychainAccessible: 7 }));
});

it('reopens encrypted records with the same system key and a fresh adapter', async () => {
    const first = createEncryptedStorage('records'); await first.getItem(name); await first.setItem(name, legacy);
    expect(await createEncryptedStorage('records').getItem(name)).toBe(legacy);
});

it('protects pending-deletion sources and confirmed counts in the same authenticated record', async () => {
    const snapshot = JSON.stringify({ state: {
        photoProcessedIds: ['fixture-id'], deleteQueue: [{ id: 'fixture-delete' }],
        pendingDeletionInfo: { 'fixture-delete': { source: 'similar', addedAt: 123 } },
        deletedCounts: { photos: 2, videos: 1 },
    }, version: 0 });
    const storage = createEncryptedStorage('records');
    await storage.getItem(name);
    await storage.setItem(name, snapshot);
    expect(disk.get(encryptedName)).not.toContain('fixture-delete');
    expect(disk.get(encryptedName)).not.toContain('similar');
    expect(await createEncryptedStorage('records').getItem(name)).toBe(snapshot);
});

it.each([
    { pendingDeletionInfo: { fixture: { source: 'invented', addedAt: 1 } } },
    { pendingDeletionInfo: { fixture: { source: 'photos', addedAt: -1 } } },
    { pendingDeletionInfo: [] },
    { deletedCounts: { photos: -1, videos: 0 } },
    { deletedCounts: { photos: 0, videos: 0.5 } },
])('preserves malformed queue metadata rather than migrating and overwriting it: %j', async extra => {
    const snapshot = JSON.stringify({ state: { photoProcessedIds: ['fixture-id'], ...extra }, version: 0 });
    disk.set(name, snapshot);
    await expect(createEncryptedStorage('records').getItem(name)).rejects.toThrow();
    expect(disk.get(name)).toBe(snapshot);
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(disk.get(encryptedName)).toBeUndefined();
});

it('leaves old records intact when migration write or verification fails', async () => {
    disk.set(name, legacy);
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    const storage = createEncryptedStorage('records');
    await expect(storage.getItem(name)).rejects.toThrow('original data was preserved');
    expect(disk.get(name)).toBe(legacy);
    await expect(storage.setItem(name, JSON.stringify({ state: {} }))).rejects.toThrow();
    expect(disk.get(name)).toBe(legacy);
    expect(await storage.getItem(name)).toBe(legacy); // Explicit retry succeeds.
});

it('does not delete the source if the just-written encrypted copy cannot be read back', async () => {
    disk.set(name, legacy);
    jest.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => { disk.set(key, value + 'tampered'); });
    await expect(createEncryptedStorage('records').getItem(name)).rejects.toThrow();
    expect(disk.get(name)).toBe(legacy);
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
});

it('does not regenerate a missing key or overwrite unreadable ciphertext with defaults', async () => {
    const storage = createEncryptedStorage('records'); await storage.getItem(name); await storage.setItem(name, legacy);
    const ciphertext = disk.get(encryptedName); keys.clear();
    const writeCount = jest.mocked(SecureStore.setItemAsync).mock.calls.length;
    const reopened = createEncryptedStorage('records');
    await expect(reopened.getItem(name)).rejects.toThrow();
    await expect(reopened.setItem(name, JSON.stringify({ state: {} }))).rejects.toThrow();
    expect(disk.get(encryptedName)).toBe(ciphertext);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(writeCount);
    expect(usePrivacyStore.getState().failures.records).toBe('read');
});

it('rejects swapping authenticated ciphertext between storage keys', async () => {
    const storage = createEncryptedStorage('records'); await storage.getItem(name); await storage.setItem(name, legacy);
    disk.set('other.encrypted-v1', disk.get(encryptedName)!);
    await expect(storage.getItem('other')).rejects.toThrow();
});

it('fails closed when secure storage, randomness or legacy parsing is unavailable', async () => {
    disk.set(name, legacy);
    jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('device locked'));
    await expect(createEncryptedStorage('records').getItem(name)).rejects.toThrow();
    expect(disk.get(name)).toBe(legacy);
    jest.mocked(getRandomBytesAsync).mockRejectedValueOnce(new Error('no CSPRNG'));
    await expect(createEncryptedStorage('records').getItem(name)).rejects.toThrow();
    expect(disk.get(name)).toBe(legacy);
    disk.set(name, '{corrupt JSON');
    await expect(createEncryptedStorage('records').getItem(name)).rejects.toThrow();
    expect(disk.get(name)).toBe('{corrupt JSON');
});

it('uses different nonces for repeated writes of the same decision', async () => {
    const storage = createEncryptedStorage('records'); await storage.getItem(name); await storage.setItem(name, legacy);
    const first = disk.get(encryptedName); await storage.setItem(name, legacy);
    expect(disk.get(encryptedName)).not.toBe(first);
});

it('preserves unsupported persisted versions instead of migrating them into default state', async () => {
    const future = JSON.stringify({ state: { photoProcessedIds: ['future-record'] }, version: 9 });
    disk.set(name, future);
    const storage = createEncryptedStorage('records');
    await expect(storage.getItem(name)).rejects.toThrow();
    await expect(storage.setItem(name, JSON.stringify({ state: {}, version: 0 }))).rejects.toThrow();
    expect(disk.get(name)).toBe(future);
    expect(disk.has(encryptedName)).toBe(false);
});

it('serializes secure key creation when independent purposes hydrate concurrently', async () => {
    disk.set(name, legacy);
    const first = createEncryptedStorage('records'), second = createEncryptedStorage('records');
    expect(await Promise.all([first.getItem(name), second.getItem(name)])).toEqual([legacy, legacy]);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(await first.getItem(name)).toBe(legacy);
});

it('does not enable captured default snapshots between decryption and Zustand state merge', async () => {
    const storage = createEncryptedStorage('records');
    disk.set(name, legacy);
    await storage.getItem(name);
    expect(canWriteEncryptedStorage('records', name)).toBe(false);
    markEncryptedStorageHydrated('records', name);
    expect(canWriteEncryptedStorage('records', name)).toBe(true);
    keys.clear();
    await expect(storage.getItem(name)).rejects.toThrow();
    expect(canWriteEncryptedStorage('records', name)).toBe(false);
});

it('does not migrate malformed decision fields that would crash or replace restored progress', async () => {
    const malformed = JSON.stringify({ state: { photoProcessedIds: null, deleteQueue: 'invalid' }, version: 0 });
    disk.set(name, malformed);
    await expect(createEncryptedStorage('records').getItem(name)).rejects.toThrow();
    expect(disk.get(name)).toBe(malformed);
    expect(disk.has(encryptedName)).toBe(false);
});

it.each([null, {}, [{ version: 2 }], [{ uri: 'file:///private.jpg' }]])('preserves malformed recent decisions and prevents empty overwrite %j', async recentDecisions => {
    const original = JSON.stringify({ state: { photoProcessedIds: ['kept'], recentDecisions }, version: 0 });
    disk.set(name, original);
    const storage = createEncryptedStorage('records');
    await expect(storage.getItem(name)).rejects.toThrow();
    await expect(storage.setItem(name, JSON.stringify({ state: {}, version: 0 }))).rejects.toThrow();
    expect(disk.get(name)).toBe(original); expect(disk.has(encryptedName)).toBe(false);
});

it.each([
    null, [], {}, { photo: null }, { photo: null, video: null, extra: null },
    { photo: { version: 2 }, video: null },
    { photo: { version: 1, sessionId: 'invalid', kind: 'video', scope: { albumIds: [], order: 'random' },
        assetIds: ['a'], position: 0, deferredIds: [], phase: 'organizing', startedAt: 1, updatedAt: 1 }, video: null },
])('preserves unsupported or malformed sensitive session records rather than replacing them %j', async organizingSessions => {
    const original = JSON.stringify({ state: { organizingSessions }, version: 0 });
    disk.set(name, original);
    const storage = createEncryptedStorage('records');
    await expect(storage.getItem(name)).rejects.toThrow();
    await expect(storage.setItem(name, JSON.stringify({ state: {} }))).rejects.toThrow();
    expect(disk.get(name)).toBe(original);
    expect(disk.has(encryptedName)).toBe(false);
});
