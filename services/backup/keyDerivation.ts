import { scryptAsync } from '@noble/hashes/scrypt.js';
import { BACKUP_KEY_LENGTH, BACKUP_SCRYPT } from './keyParameters';

// Portable path for independent algorithm tests. Metro selects the native
// sibling on Android/iOS; native failures must not silently downgrade it.
export function deriveBackupKey(bytes: Uint8Array, salt: Uint8Array, checkCancelled: () => void, onProgress?: (fraction: number) => void) {
    return scryptAsync(bytes, salt, { ...BACKUP_SCRYPT, dkLen: BACKUP_KEY_LENGTH, asyncTick: 10,
        onProgress: fraction => { checkCancelled(); onProgress?.(fraction); } });
}
