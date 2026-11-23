jest.unmock('../services/reviewIgnores');
jest.unmock('../services/privacy/encryptedStorage');
jest.mock('@react-native-async-storage/async-storage', () => ({
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
    getItemAsync: jest.fn(),
    setItemAsync: jest.fn(),
}));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn() }));
jest.mock('react-native-quick-base64', () => ({
    fromByteArray: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    toByteArray: (encoded: string) => new Uint8Array(Buffer.from(encoded, 'base64')),
}));
jest.mock('expo-media-library', () => ({
    MediaType: { photo: 'photo', video: 'video' },
    getPermissionsAsync: jest.fn(),
    getAlbumsAsync: jest.fn(),
    getAssetsAsync: jest.fn(),
    getAssetInfoAsync: jest.fn(),
    deleteAssetsAsync: jest.fn(),
}));
jest.mock('../services/backup/crypto', () => {
    const actual = jest.requireActual('../services/backup/crypto');
    return {
        ...actual,
        encryptBackup: jest.fn(async (value: unknown) => new TextEncoder().encode(JSON.stringify(value))),
    };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytesAsync } from 'expo-crypto';
import * as MediaLibrary from 'expo-media-library';
import { randomBytes } from 'node:crypto';
import { Platform } from 'react-native';
import { closeDatabase } from '../database/db';
import { ReviewIgnoreRepository } from '../database/repositories/ReviewIgnoreRepository';
import { createEncryptedRecords, restoreEncryptedRecords } from '../services/backup/records';
import { encryptBackup } from '../services/backup/crypto';
import { type BackupPayloadV2 } from '../services/backup/payload';
import {
    createEncryptedStorage,
    markEncryptedStorageHydrated,
} from '../services/privacy/encryptedStorage';
import {
    getAllIgnoredSimilarGroupKeys,
    ignoreSimilarGroupKeys,
} from '../services/reviewIgnores';
import {
    buildSimilarGroupContentKey,
    collectSimilarGroupIgnoreKeys,
    isSimilarGroupIgnored,
} from '../services/similarGroupKey';
import { useMediaStore } from '../stores/useMediaStore';
import { usePrivacyStore } from '../stores/usePrivacyStore';
import { TestDatabase } from './helpers/testDatabase';

jest.mock('../database/db', () => {
    let activeDb: any = null;
    return {
        __setTestDb: (db: any) => { activeDb = db; },
        getDatabase: async () => activeDb,
        withTransaction: async (fn: (db: any) => Promise<any>) => fn(activeDb),
        closeDatabase: async () => { await activeDb?.closeAsync?.(); activeDb = null; },
    };
});

const dbModule = require('../database/db');

describe('Not Similar stable key encrypted persistence & cross-device v2 backup restore', () => {
    let disk: Map<string, string>;
    let keys: Map<string, string>;

    beforeEach(async () => {
        jest.clearAllMocks();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        disk = new Map();
        keys = new Map();
        jest.mocked(AsyncStorage.getItem).mockImplementation(async key => disk.get(key) ?? null);
        jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => { disk.set(key, value); });
        jest.mocked(AsyncStorage.removeItem).mockImplementation(async key => { disk.delete(key); });
        jest.mocked(SecureStore.getItemAsync).mockImplementation(async key => keys.get(key) ?? null);
        jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => { keys.set(key, value); });
        jest.mocked(getRandomBytesAsync).mockImplementation(async count => new Uint8Array(randomBytes(count)));

        usePrivacyStore.setState({ failures: {}, reasons: {}, recoveryDepth: 0, recovering: false });
        useMediaStore.setState({
            hasHydrated: true,
            photoProcessedIds: [],
            videoProcessedIds: [],
            deleteQueue: [],
            collectionQueue: [],
            videoTrashBin: [],
            pendingDeletionInfo: {},
            ignoredSimilarGroupKeys: [],
            isConfirmingDeletion: false,
            isConfirmingVideoTrash: false,
        });

        const memDb = new TestDatabase();
        dbModule.__setTestDb(memDb);

        jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
        jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([]);
        jest.mocked(MediaLibrary.getAssetsAsync).mockResolvedValue({ assets: [], hasNextPage: false } as any);
    });

    afterEach(async () => {
        await closeDatabase();
    });

    it('produces an order-independent, privacy-preserving content key identical across platforms and device IDs', () => {
        const iosPhotoA = { id: 'IOS-UUID-A', filename: 'IMG_4201.JPG', mediaType: 'photo', width: 4032, height: 3024, creationTime: 1700000000000 };
        const iosPhotoB = { id: 'IOS-UUID-B', filename: 'IMG_4202.JPG', mediaType: 'photo', width: 4032, height: 3024, creationTime: 1700000002000 };

        const androidPhotoA = { id: '101', filename: 'IMG_4201.JPG', mediaType: 'photo', width: 4032, height: 3024, creationTime: 1700000001000 };
        const androidPhotoB = { id: '999', filename: 'IMG_4202.JPG', mediaType: 'photo', width: 4032, height: 3024, creationTime: 1700000003000 };

        const keyIos = buildSimilarGroupContentKey([iosPhotoA, iosPhotoB]);
        const keyAndroidReversed = buildSimilarGroupContentKey([androidPhotoB, androidPhotoA]);

        expect(keyIos).toMatch(/^sgc1:[a-f0-9]{64}$/);
        expect(keyIos).toBe(keyAndroidReversed);
        expect(keyIos).not.toContain('IMG_4201');
        expect(keyIos).not.toContain('IOS-UUID');
    });

    it('encrypts ignoredSimilarGroupKeys with AES-256-GCM without cleartext leaks and rejects malformed entries', async () => {
        const contentKey = buildSimilarGroupContentKey([
            { id: '1', filename: 'A.jpg', mediaType: 'photo', width: 1000, height: 800 },
            { id: '2', filename: 'B.jpg', mediaType: 'photo', width: 1000, height: 800 },
        ])!;
        const storage = createEncryptedStorage('records');
        await storage.getItem('photoapp-media-progress');
        markEncryptedStorageHydrated('records', 'photoapp-media-progress');

        const payload = JSON.stringify({
            state: { ignoredSimilarGroupKeys: [contentKey] },
            version: 0,
        });
        await storage.setItem('photoapp-media-progress', payload);

        const cipher = disk.get('photoapp-media-progress.encrypted-v1')!;
        expect(cipher).toMatch(/^PKLOCAL1:/);
        expect(cipher).not.toContain(contentKey);
        expect(cipher).not.toContain('ignoredSimilarGroupKeys');

        // Reopening decrypts cleanly.
        expect(await createEncryptedStorage('records').getItem('photoapp-media-progress')).toBe(payload);

        // Malformed non-string entry fails closed.
        const bad = JSON.stringify({ state: { ignoredSimilarGroupKeys: [123] }, version: 0 });
        disk.set('photoapp-media-progress', bad);
        disk.delete('photoapp-media-progress.encrypted-v1');
        await expect(createEncryptedStorage('records').getItem('photoapp-media-progress')).rejects.toThrow();
    });

    it('persists Not Similar keys, exports them in v2 backup, and suppresses the same group after cross-device restore with new asset IDs', async () => {
        // Device A (source device): photo IDs are 'src-1' & 'src-2'.
        const srcA = { id: 'src-1', filename: 'BURST_001.jpg', mediaType: 'photo', width: 3000, height: 2000, creationTime: 1700000000000 };
        const srcB = { id: 'src-2', filename: 'BURST_002.jpg', mediaType: 'photo', width: 3000, height: 2000, creationTime: 1700000001000 };
        const deviceAKeys = collectSimilarGroupIgnoreKeys({
            snapshotKey: 'device-a-snapshot-key',
            assets: [srcA, srcB],
            assetIds: [srcA.id, srcB.id],
        });
        expect(deviceAKeys).toHaveLength(2); // snapshot key + sgc1 content key

        await ignoreSimilarGroupKeys(deviceAKeys, 1700000100000);
        expect(useMediaStore.getState().ignoredSimilarGroupKeys).toEqual(expect.arrayContaining(deviceAKeys));
        expect(await ReviewIgnoreRepository.getIgnoredKeys('similar_group')).toEqual(new Set(deviceAKeys));

        // Export v2 encrypted backup from Device A.
        const exported = await createEncryptedRecords('valid-passphrase-2026');
        expect(exported.reviewIgnores).toBe(2);
        const exportedPayload = jest.mocked(encryptBackup).mock.calls[0][0] as BackupPayloadV2;
        expect(exportedPayload.version).toBe(2);
        expect(exportedPayload.reviewIgnores.map(item => item.targetKey)).toEqual(expect.arrayContaining(deviceAKeys));

        // Simulate Device B (brand-new encrypted DB + empty store + different asset IDs 'dst-901' & 'dst-902').
        const deviceBDb = new TestDatabase();
        dbModule.__setTestDb(deviceBDb);
        useMediaStore.setState({ ignoredSimilarGroupKeys: [] });

        // Restore v2 backup onto Device B.
        const preview = await restoreEncryptedRecords(exportedPayload, false);
        expect(preview.reviewIgnores).toBe(2);
        expect(useMediaStore.getState().ignoredSimilarGroupKeys).toEqual(expect.arrayContaining(deviceAKeys));

        // After rescan on Device B, group gets a brand-new group_id & snapshotKey,
        // and completely different asset IDs ('dst-901', 'dst-902'), yet MUST stay suppressed!
        const ignoredOnDeviceB = await getAllIgnoredSimilarGroupKeys();
        const dstA = { id: 'dst-901', filename: 'BURST_001.jpg', mediaType: 'photo', width: 3000, height: 2000, creationTime: 1700000000500 };
        const dstB = { id: 'dst-902', filename: 'BURST_002.jpg', mediaType: 'photo', width: 3000, height: 2000, creationTime: 1700000001500 };
        expect(isSimilarGroupIgnored(ignoredOnDeviceB, {
            snapshotKey: 'brand-new-device-b-snapshot-key',
            assets: [dstA, dstB],
            assetIds: [dstA.id, dstB.id],
        })).toBe(true);
    });
});
