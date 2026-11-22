import * as MediaLibrary from 'expo-media-library';
import { closeDatabase, getDatabase } from '../../database/db';
import { resetEncryptedDatabaseFiles } from '../../database/encryptedDatabase';
import {
    LocalPrivacyError,
    type PrivacyFailureReason,
    type PrivacyScope,
    usePrivacyStore,
} from '../../stores/usePrivacyStore';
import { useMediaStore } from '../../stores/useMediaStore';
import { DEFAULT_SETTINGS_STATE, useSettingsStore } from '../../stores/useSettingsStore';
import { resetMediaProgressPersistenceState } from '../mediaProgressStorage';
import { isScanning, stop as stopScanner } from '../scanner';
import { BackupError, type BackupCancellation } from '../backup/crypto';
import type { BackupPayload, RestorePreview } from '../backup/payload';
import { restoreEncryptedRecords } from '../backup/records';
import { resetBackupChangeState } from '../backup/changeTracker';
import { deleteDeviceKey, probeDeviceKeystore } from './deviceKey';
import { resetEncryptedStorageKeys } from './encryptedStorage';
import { clearLegacyMediaCache } from './mediaCache';
import { resetSettingsPersistenceState } from './settingsStorage';

const DOMAIN_PRIORITY: readonly PrivacyFailureReason[] = [
    'keystore_unavailable',
    'cipher_decrypt_failed',
    'schema_corrupt',
    'storage_io',
    'unknown',
];

export function resolvePrimaryFailureDomain(
    failures: Partial<Record<PrivacyScope, 'read' | 'write'>>,
    reasons: Partial<Record<PrivacyScope, PrivacyFailureReason>> = {},
): PrivacyFailureReason | null {
    const activeScopes = Object.keys(failures) as PrivacyScope[];
    if (activeScopes.length === 0) return null;

    const activeReasons = new Set<PrivacyFailureReason>();
    for (const scope of activeScopes) {
        activeReasons.add(reasons[scope] ?? 'unknown');
    }
    for (const candidate of DOMAIN_PRIORITY) {
        if (activeReasons.has(candidate)) return candidate;
    }
    return 'unknown';
}

/**
 * Explicit user-confirmed self-rescue: wipes ONLY PickPic's local encrypted
 * index, settings ciphertext, and device keys, then initializes a fresh
 * encrypted database and rehydrates stores. NEVER touches original photos or
 * videos in the device media library.
 */
export async function resetLocalPrivacyIndex(): Promise<void> {
    if (isScanning()) {
        stopScanner();
        const deadline = Date.now() + 20000;
        while (isScanning() && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (isScanning()) throw new LocalPrivacyError('storage_io');
    }

    // Verify device keystore health BEFORE destroying any recoverable local ciphertext.
    if (typeof probeDeviceKeystore === 'function') {
        await probeDeviceKeystore();
    }

    const endRecovery = usePrivacyStore.getState().beginRecovery?.();
    try {
        await clearLegacyMediaCache().catch(() => undefined);
        await closeDatabase();
        await resetEncryptedDatabaseFiles();
        await resetEncryptedStorageKeys();
        for (const scope of ['scanner', 'records', 'settings'] as const) {
            await deleteDeviceKey(scope);
        }
        await resetMediaProgressPersistenceState();
        if (typeof resetSettingsPersistenceState === 'function') {
            await resetSettingsPersistenceState();
        }
        resetBackupChangeState();

        useSettingsStore.setState?.({
            ...(DEFAULT_SETTINGS_STATE ?? {}),
            hasHydrated: false,
        });

        useMediaStore.setState({
            photos: [],
            videos: [],
            albums: [],
            currentIndex: 0,
            videoCurrentIndex: 0,
            deleteQueue: [],
            collectionQueue: [],
            videoTrashBin: [],
            pendingDeletionInfo: {},
            deletedCounts: { photos: 0, videos: 0 },
            lastDeletionResult: null,
            recentDecisions: [],
            organizingSessions: { photo: null, video: null },
            photoSessionRecoveryStatus: null,
            photoSessionUnavailableCount: 0,
            videoSessionRecoveryStatus: null,
            videoSessionUnavailableCount: 0,
            photoProcessedIds: [],
            videoProcessedIds: [],
            protectedAlbums: [],
            protectedAssetIds: [],
            hiddenPhotoQueuedAssetIds: null,
            hiddenVideoQueuedAssetIds: null,
            hasHydrated: false,
        });

        usePrivacyStore.getState().clearAll();

        // Open a clean freshly keyed SQLCipher database and rehydrate both stores
        // while the recovery gate lock remains active.
        await getDatabase();
        await useSettingsStore.persist.rehydrate();
        await useMediaStore.persist.rehydrate();
        await useMediaStore.getState().loadProtectedAlbums?.();
        await useMediaStore.getState().refreshTotalCounts?.().catch(() => undefined);
    } finally {
        endRecovery?.();
    }
}

async function assertMediaAccessForRecoveryBackup(payload: BackupPayload): Promise<void> {
    if (typeof MediaLibrary.getPermissionsAsync !== 'function') return;
    const needsPhoto = payload.records.some(record => record.kind === 'photo')
        || (payload.version === 2 && payload.reviewIgnores.some(ignore => ignore.ignoreType === 'blur'));
    const needsVideo = payload.records.some(record => record.kind === 'video');
    if (needsPhoto) {
        const photoPermission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
        if (!photoPermission.granted) {
            throw new BackupError('unavailable');
        }
    } else if (needsVideo) {
        const videoPermission = await MediaLibrary.getPermissionsAsync(false, ['video']);
        if (!videoPermission.granted) {
            throw new BackupError('unavailable');
        }
    }
}

/**
 * Self-rescue from a verified `.pickpic` backup payload (v1 or v2).
 * Caller MUST decrypt and validate `payload` BEFORE calling this function so
 * wrong passwords or damaged files never wipe existing local storage.
 * Keeps the privacy recovery gate closed until local reset AND backup restore
 * both finish so RootLayout cannot unmount the recovery wizard mid-restore.
 */
export async function recoverFromEncryptedBackup(
    payload: BackupPayload,
    includePending: boolean,
    cancelled?: BackupCancellation,
): Promise<RestorePreview> {
    await assertMediaAccessForRecoveryBackup(payload);
    const endRecovery = usePrivacyStore.getState().beginRecovery?.();
    try {
        await resetLocalPrivacyIndex();
        const result = await restoreEncryptedRecords(payload, includePending, cancelled);
        await useMediaStore.getState().loadProtectedAlbums?.();
        await useMediaStore.getState().refreshTotalCounts?.().catch(() => undefined);
        return result;
    } finally {
        endRecovery?.();
    }
}
