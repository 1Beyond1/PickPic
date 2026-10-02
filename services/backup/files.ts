import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { getRandomBytesAsync } from 'expo-crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BackupError, MAX_BACKUP_BYTES } from './crypto';

export async function pickEncryptedFile(): Promise<Uint8Array | null> {
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return null;
    const file = new File(result.assets[0].uri);
    try {
        if (!file.exists || file.size <= 0 || file.size > MAX_BACKUP_BYTES) throw new BackupError('size');
        const bytes = await file.bytes();
        if (bytes.length > MAX_BACKUP_BYTES) throw new BackupError('size');
        return bytes;
    } finally {
        // Only remove the picker-owned private cache copy, never the original.
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
