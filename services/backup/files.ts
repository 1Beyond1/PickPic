import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { getRandomBytesAsync } from 'expo-crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toByteArray } from 'react-native-quick-base64';
import { BackupError, MAX_BACKUP_BYTES } from './crypto';

async function readAndroidContentUriBounded(uri: string): Promise<Uint8Array> {
    let base64: string;
    try {
        base64 = await LegacyFileSystem.readAsStringAsync(uri, {
            encoding: LegacyFileSystem.EncodingType.Base64,
        });
    } catch {
        throw new BackupError('unavailable');
    }
    let bytes: Uint8Array;
    try {
        bytes = toByteArray(base64);
    } catch {
        throw new BackupError('invalid');
    }
    if (bytes.length <= 0 || bytes.length > MAX_BACKUP_BYTES) {
        throw new BackupError('size');
    }
    return bytes;
}

export async function pickEncryptedFile(): Promise<Uint8Array | null> {
    // Avoid synchronous UI-thread copies of mistakenly picked large files (e.g. videos).
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: false, multiple: false });
    if (result.canceled || !result.assets?.[0]?.uri) return null;
    const asset = result.assets[0];
    const hasValidDeclaredSize = typeof asset.size === 'number' && Number.isFinite(asset.size);
    if (hasValidDeclaredSize && (asset.size! <= 0 || asset.size! > MAX_BACKUP_BYTES)) {
        throw new BackupError('size');
    }
    const isAndroidContentUri = Platform.OS === 'android' && asset.uri.startsWith('content://');
    const file = new File(asset.uri);
    try {
        try {
            if (file.exists) {
                if (file.size <= 0 || file.size > MAX_BACKUP_BYTES) throw new BackupError('size');
                const bytes = await file.bytes();
                if (bytes.length <= 0 || bytes.length > MAX_BACKUP_BYTES) throw new BackupError('size');
                return bytes;
            }
            if (!isAndroidContentUri) {
                throw new BackupError('size');
            }
        } catch (error) {
            if (error instanceof BackupError) throw error;
            if (!isAndroidContentUri) throw new BackupError('unavailable');
        }

        // Some Android content:// providers do not expose SAF document segments to
        // FileSystemFile. Allow controlled base64 fallback ONLY after asset.size has
        // already been verified <= MAX_BACKUP_BYTES so huge files can never OOM.
        if (!hasValidDeclaredSize) {
            throw new BackupError('unavailable');
        }
        return await readAndroidContentUriBounded(asset.uri);
    } finally {
        // Only remove a picker-owned private cache copy if one exists, never the original.
        if (file.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, '')}/`)) {
            try { file.delete(); } catch { /* At worst ciphertext remains in cache. */ }
        }
    }
}

/** Called only with authenticated ciphertext; no plaintext touches a file. */
export async function saveEncryptedFile(bytes: Uint8Array): Promise<boolean> {
    if (bytes.length > MAX_BACKUP_BYTES) throw new BackupError('size');
    const suffix = bytesToHex(await getRandomBytesAsync(8));
    const filename = `PickPic-${suffix}.pickpic`;
    const temp = new File(Paths.cache, filename);
    try {
        temp.create(); temp.write(bytes);
        if (Platform.OS === 'android') {
            const access = await LegacyFileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
            if (!access.granted) return false;
            const uri = await LegacyFileSystem.StorageAccessFramework.createFileAsync(access.directoryUri, filename, 'application/octet-stream');
            try {
                // This intermediate string contains ciphertext only.
                const base64 = await LegacyFileSystem.readAsStringAsync(temp.uri, { encoding: LegacyFileSystem.EncodingType.Base64 });
                await LegacyFileSystem.writeAsStringAsync(uri, base64, { encoding: LegacyFileSystem.EncodingType.Base64 });
            } catch {
                await LegacyFileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
                throw new BackupError('unavailable');
            }
        } else {
            if (!await Sharing.isAvailableAsync()) throw new BackupError('unavailable');
            await Sharing.shareAsync(temp.uri, { mimeType: 'application/octet-stream', UTI: 'public.data' });
        }
        return true;
    } finally { try { if (temp.exists) temp.delete(); } catch { /* Encrypted cache only. */ } }
}
