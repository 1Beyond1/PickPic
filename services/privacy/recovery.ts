import { closeDatabase, getDatabase } from '../../database/db';
import { resetEncryptedDatabaseFiles } from '../../database/encryptedDatabase';
import {
    LocalPrivacyError,
    type PrivacyFailureReason,
    type PrivacyScope,
    usePrivacyStore,
} from '../../stores/usePrivacyStore';
import { useMediaStore } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { resetMediaProgressPersistenceState } from '../mediaProgressStorage';
import { isScanning, stop as stopScanner } from '../scanner';
import type { BackupCancellation } from '../backup/crypto';
import type { BackupPayload, RestorePreview } from '../backup/payload';
import { restoreEncryptedRecords } from '../backup/records';
import { resetBackupChangeState } from '../backup/changeTracker';
import { deleteDeviceKey } from './deviceKey';
import { resetEncryptedStorageKeys } from './encryptedStorage';
import { clearLegacyMediaCache } from './mediaCache';

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

    await clearLegacyMediaCache().catch(() => undefined);
    await closeDatabase();
    await resetEncryptedDatabaseFiles();
    await resetEncryptedStorageKeys();
    for (const scope of ['scanner', 'records', 'settings'] as const) {
        await deleteDeviceKey(scope);
    }
    await resetMediaProgressPersistenceState();
    resetBackupChangeState();

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

    // Open a clean freshly keyed SQLCipher database and rehydrate both stores.
    await getDatabase();
    await useSettingsStore.persist.rehydrate();
    await useMediaStore.persist.rehydrate();
    await useMediaStore.getState().loadProtectedAlbums?.();
    await useMediaStore.getState().refreshTotalCounts?.().catch(() => undefined);
}

/**
 * Self-rescue from a verified `.pickpic` backup payload (v1 or v2).
 * Caller MUST decrypt and validate `payload` BEFORE calling this function so
 * wrong passwords or damaged files never wipe existing local storage.
 */
export async function recoverFromEncryptedBackup(
    payload: BackupPayload,
    includePending: boolean,
    cancelled?: BackupCancellation,
): Promise<RestorePreview> {
    await resetLocalPrivacyIndex();
    return restoreEncryptedRecords(payload, includePending, cancelled);
}
