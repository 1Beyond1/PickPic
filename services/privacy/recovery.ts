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
import {
    resetMediaProgressPersistenceState,
    suspendMediaProgressWrites,
} from '../mediaProgressStorage';
import { isScanning, stop as stopScanner } from '../scanner';
import { BackupError, type BackupCancellation } from '../backup/crypto';
import {
    getRequiredBackupMediaPermissions,
    type BackupPayload,
    type RestorePreview,
} from '../backup/payload';
import { restoreEncryptedRecords } from '../backup/records';
import {
    resetBackupChangeState,
    suspendBackupChangeWrites,
} from '../backup/changeTracker';
import { deleteDeviceKey, probeDeviceKeystore } from './deviceKey';
import {
    disableEncryptedStorageWrites,
    resetEncryptedStorageKeys,
} from './encryptedStorage';
import { clearLegacyMediaCache } from './mediaCache';
import {
    resetSettingsPersistenceState,
    suspendSettingsWrites,
} from './settingsStorage';

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
    const resumeMediaWrites = typeof suspendMediaProgressWrites === 'function' ? suspendMediaProgressWrites() : undefined;
    const resumeSettingsWrites = typeof suspendSettingsWrites === 'function' ? suspendSettingsWrites() : undefined;
    const resumeChangeWrites = typeof suspendBackupChangeWrites === 'function' ? suspendBackupChangeWrites() : undefined;
    let writesResumed = false;
    const resumeAllWrites = () => {
        if (writesResumed) return;
        writesResumed = true;
        resumeChangeWrites?.();
        resumeSettingsWrites?.();
        resumeMediaWrites?.();
    };
    let writesDisabled = false;
    try {
        // Block new persistence writes and drain every in-flight writer BEFORE
        // closing SQLCipher or wiping any local ciphertext / device key so old-key
        // writes can never land after key deletion and re-lock the app.
        if (typeof disableEncryptedStorageWrites === 'function') {
            disableEncryptedStorageWrites();
            writesDisabled = true;
        }
        await resetMediaProgressPersistenceState();
        if (typeof resetSettingsPersistenceState === 'function') {
            await resetSettingsPersistenceState();
        }
        await resetBackupChangeState();

        await clearLegacyMediaCache().catch(() => undefined);
        await closeDatabase();
        await resetEncryptedDatabaseFiles();
        await resetEncryptedStorageKeys();
        for (const scope of ['scanner', 'records', 'settings'] as const) {
            await deleteDeviceKey(scope);
        }

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
            missingProtectedAlbumIds: [],
            ignoredSimilarGroupKeys: [],
            hiddenPhotoQueuedAssetIds: null,
            hiddenVideoQueuedAssetIds: null,
            hasHydrated: false,
        });

        usePrivacyStore.getState().clearAll();

        // Re-enable writes only after all old files and keys are wiped, then
        // open a clean freshly keyed SQLCipher database and rehydrate both stores
        // while the recovery gate lock remains active.
        resumeAllWrites();
        await getDatabase();
        await useSettingsStore.persist.rehydrate();
        await useMediaStore.persist.rehydrate();
        await useMediaStore.getState().loadProtectedAlbums?.();
        await useMediaStore.getState().refreshTotalCounts?.().catch(() => undefined);
    } catch (error) {
        if (writesDisabled) {
            // Encrypted storage write gates were cleared; force both stores back
            // into read-blocked unhydrated state so Retry always rehydrates and
            // re-arms write gates instead of silently dropping writes or spinning.
            useSettingsStore.setState?.({ hasHydrated: false });
            useMediaStore.setState?.({ hasHydrated: false });
            const reason = error instanceof LocalPrivacyError ? error.reason : 'storage_io';
            const privacy = usePrivacyStore.getState();
            const settingsReason = privacy.failures.settings === 'read' ? privacy.reasons?.settings : undefined;
            const recordsReason = privacy.failures.records === 'read' ? privacy.reasons?.records : undefined;
            privacy.block?.('settings', 'read', settingsReason ?? reason);
            privacy.block?.('records', 'read', recordsReason ?? reason);
        }
        throw error;
    } finally {
        resumeAllWrites();
        endRecovery?.();
    }
}

export { getRequiredBackupMediaPermissions };

export async function getMissingBackupMediaPermissions(
    payload: BackupPayload,
): Promise<('photo' | 'video')[]> {
    if (typeof MediaLibrary.getPermissionsAsync !== 'function') return [];
    const required = getRequiredBackupMediaPermissions(payload);
    const missing: ('photo' | 'video')[] = [];
    for (const kind of required) {
        const permission = await MediaLibrary.getPermissionsAsync(false, [kind]);
        if (!permission || !permission.granted) {
            missing.push(kind);
        }
    }
    return missing;
}

async function assertMediaAccessForRecoveryBackup(payload: BackupPayload): Promise<void> {
    const missing = await getMissingBackupMediaPermissions(payload);
    if (missing.length > 0) {
        throw new BackupError('permission');
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
