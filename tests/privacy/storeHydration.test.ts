jest.unmock('../../services/privacy/encryptedStorage');
let mockDisk: Map<string, string>, mockKeys: Map<string, string>;
let mockLocked = false;
jest.mock('@react-native-async-storage/async-storage', () => ({
    getItem: jest.fn(async (name: string) => mockDisk.get(name) ?? null),
    setItem: jest.fn(async (name: string, value: string) => { mockDisk.set(name, value); }),
    removeItem: jest.fn(async (name: string) => { mockDisk.delete(name); }),
}));
jest.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
    getItemAsync: jest.fn(async (name: string) => { if (mockLocked) throw new Error('locked'); return mockKeys.get(name) ?? null; }),
    setItemAsync: jest.fn(async (name: string, value: string) => { mockKeys.set(name, value); }),
}));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: async (count: number) => new Uint8Array(require('node:crypto').randomBytes(count)) }));
jest.mock('react-native-quick-base64', () => ({
    fromByteArray: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    toByteArray: (encoded: string) => new Uint8Array(Buffer.from(encoded, 'base64')),
}));
jest.mock('expo-media-library', () => ({}));
jest.mock('../../database', () => ({ AssetRepository: {} }));

const recordsName = 'photoapp-media-progress';
const settingsName = 'photoapp-settings';
const records = JSON.stringify({ state: { photoProcessedIds: ['kept'], videoProcessedIds: ['video'], deleteQueue: [{ id: 'pending', mediaType: 'photo' }], collectionQueue: [], videoTrashBin: [] }, version: 0 });
const settings = JSON.stringify({ state: { theme: 'dark', selectedAlbumIds: ['private-album'], displayOrder: 'oldest', language: 'en', groupSize: 20 }, version: 0 });
beforeEach(() => {
    jest.resetModules(); mockDisk = new Map([[recordsName, records], [settingsName, settings]]); mockKeys = new Map(); mockLocked = false;
});
async function openStores() {
    const { useMediaStore } = require('../../stores/useMediaStore');
    const { useSettingsStore } = require('../../stores/useSettingsStore');
    const { usePrivacyStore } = require('../../stores/usePrivacyStore');
    // Let automatic hydration complete before an explicit retry. Immediate
    // setters below deliberately race hydration like startup metadata updates.
    useMediaStore.getState().setPermissionScope('full');
    for (let step = 0; step < 40; step++) await Promise.resolve();
    return { media: useMediaStore, settings: useSettingsStore, privacy: usePrivacyStore };
}

it('hydrates real Zustand stores without startup default snapshots replacing legacy records', async () => {
    const stores = await openStores();
    await stores.media.persist.rehydrate(); await stores.settings.persist.rehydrate();
    await require('../../services/mediaProgressStorage').flushMediaProgress();
    await require('../../services/privacy/settingsStorage').flushSettings();
    expect(stores.media.getState()).toMatchObject({ hasHydrated: true, photoProcessedIds: ['kept'], videoProcessedIds: ['video'], deleteQueue: [{ id: 'pending', mediaType: 'photo' }] });
    expect(stores.settings.getState()).toMatchObject({ hasHydrated: true, theme: 'dark', selectedAlbumIds: ['private-album'], groupSize: 20 });
    expect(mockDisk.has(recordsName)).toBe(false); expect(mockDisk.has(settingsName)).toBe(false);
    expect(mockDisk.get(recordsName + '.encrypted-v1')).not.toContain('pending');
    expect(mockDisk.get(settingsName + '.encrypted-v1')).not.toContain('private-album');
});

it('keeps failed hydration closed and preserves old records, then restores them on explicit retry', async () => {
    mockLocked = true;
    const stores = await openStores();
    await stores.media.persist.rehydrate(); await stores.settings.persist.rehydrate();
    expect(stores.media.getState().hasHydrated).toBe(false); expect(stores.settings.getState().hasHydrated).toBe(false);
    expect(stores.privacy.getState().failures).toMatchObject({ records: 'read', settings: 'read' });
    stores.media.getState().setHasHydrated(false);
    stores.settings.getState().setLanguage('zh');
    await require('../../services/mediaProgressStorage').flushMediaProgress();
    await require('../../services/privacy/settingsStorage').flushSettings();
    expect(mockDisk.get(recordsName)).toBe(records); expect(mockDisk.get(settingsName)).toBe(settings);
    mockLocked = false;
    await stores.media.persist.rehydrate(); await stores.settings.persist.rehydrate();
    expect(stores.media.getState().photoProcessedIds).toEqual(['kept']);
    expect(stores.settings.getState().language).toBe('en');
    expect(stores.privacy.getState().failures).toEqual({});
});

it('rejects persisted fields that replace store actions, even with a forged hydrated flag', async () => {
    mockDisk.set(recordsName, JSON.stringify({ state: { photoProcessedIds: ['kept'], setHasHydrated: 'not-an-action', hasHydrated: true }, version: 0 }));
    const stores = await openStores();
    await stores.media.persist.rehydrate();
    expect(stores.media.getState().hasHydrated).toBe(false);
    expect(typeof stores.media.getState().setHasHydrated).toBe('function');
    expect(stores.privacy.getState().failures.records).toBe('read');
    const saved = mockDisk.get(recordsName + '.encrypted-v1');
    stores.media.getState().setHasHydrated(false);
    await require('../../services/mediaProgressStorage').flushMediaProgress();
    expect(mockDisk.get(recordsName + '.encrypted-v1')).toBe(saved);
});

it('retains an unsaved decision in memory, gates actions, and persists that decision on retry with real encryption', async () => {
    const stores = await openStores();
    await stores.media.persist.rehydrate(); await stores.settings.persist.rehydrate();
    const { flushMediaProgress } = require('../../services/mediaProgressStorage');
    // resetModules creates a fresh native-boundary mock for these stores.
    const diskStorage = require('@react-native-async-storage/async-storage');
    await flushMediaProgress(); await require('../../services/privacy/settingsStorage').flushSettings();
    const saved = mockDisk.get(recordsName + '.encrypted-v1');
    diskStorage.setItem.mockRejectedValue(new Error('synthetic disk failure'));
    stores.media.getState().markForDeletion({ id: 'new-pending', mediaType: 'photo' });
    await expect(flushMediaProgress()).rejects.toThrow('Could not persist organizing records');
    expect(stores.privacy.getState().failures.records).toBe('write');
    expect(mockDisk.get(recordsName + '.encrypted-v1')).toBe(saved);
    expect(stores.media.getState().deleteQueue.map((asset: { id: string }) => asset.id)).toEqual(['pending', 'new-pending']);
    diskStorage.setItem.mockImplementation(async (name: string, value: string) => { mockDisk.set(name, value); });
    await flushMediaProgress();
    expect(stores.privacy.getState().failures).toEqual({});
    expect(mockDisk.get(recordsName + '.encrypted-v1')).not.toContain('new-pending');
    jest.resetModules();
    const restarted = await openStores();
    await restarted.media.persist.rehydrate();
    expect(restarted.media.getState().deleteQueue.map((asset: { id: string }) => asset.id)).toEqual(['pending', 'new-pending']);
    expect(restarted.media.getState().photoProcessedIds).toEqual(['kept', 'new-pending']);
});
