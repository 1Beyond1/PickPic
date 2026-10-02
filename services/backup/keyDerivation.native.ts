import { scrypt } from 'react-native-quick-crypto';
import { BACKUP_KEY_LENGTH, BACKUP_SCRYPT } from './keyParameters';

// Off-thread native scrypt, with identical format-v1 costs. Do not install
// global crypto/Buffer polyfills or change the app's other cryptography.
export async function deriveBackupKey(bytes: Uint8Array, salt: Uint8Array, checkCancelled: () => void, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
    checkCancelled();
    // This backend cannot report intermediate progress or abort CPU work.
    // Cancellation still discards and wipes its result before publication.
    const key = await new Promise<Uint8Array>((resolve, reject) => {
        scrypt(bytes, salt, BACKUP_KEY_LENGTH, BACKUP_SCRYPT, (error, result) => {
            if (error || !result || result.length !== BACKUP_KEY_LENGTH) {
                result?.fill(0);
                reject(new Error('Native backup key derivation unavailable'));
            } else resolve(result);
        });
    });
    try { checkCancelled(); onProgress?.(1); return key; }
    catch (error) { key.fill(0); throw error; }
}
