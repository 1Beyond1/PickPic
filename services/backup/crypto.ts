import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { getRandomBytesAsync } from 'expo-crypto';

// Version 1 fixes its KDF costs. Untrusted input can never request weaker
// parameters or unbounded work. scrypt N=2^16,r=8,p=2 uses ~64MiB working memory.
const MAGIC = new Uint8Array([80, 75, 80, 73, 67, 48, 48, 49]); // PKPIC001
const HEADER_SIZE = 52; // magic + 32-byte salt + 12-byte GCM nonce
const BLOCK_SIZE = 65536;
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024 + HEADER_SIZE + 16;
const MAX_JSON_BYTES = 8 * 1024 * 1024 - 4;
export type BackupCancellation = () => boolean;

export class BackupError extends Error {
    constructor(public readonly code: 'password' | 'invalid' | 'cancelled' | 'size' | 'unavailable') {
        super(`Backup operation failed (${code})`);
    }
}
function checkCancelled(cancelled?: BackupCancellation) {
    if (cancelled?.()) throw new BackupError('cancelled');
}
export function validateBackupPassword(password: string): void {
    if (typeof password !== 'string' || [...password].length < 12 || [...password].length > 128
        || password.trim().length < 12 || new Set(password).size < 5) throw new BackupError('password');
}
async function deriveKey(password: string, salt: Uint8Array, cancelled?: BackupCancellation) {
    validateBackupPassword(password);
    checkCancelled(cancelled);
    const bytes = new TextEncoder().encode(password);
    try {
        return await scryptAsync(bytes, salt, { N: 65536, r: 8, p: 2, dkLen: 32,
            maxmem: 80 * 1024 * 1024, asyncTick: 10,
            onProgress: () => checkCancelled(cancelled) });
    } finally { bytes.fill(0); }
}

/** Memory-only plaintext. Only the returned authenticated ciphertext may be saved. */
export async function encryptBackup(value: unknown, password: string, cancelled?: BackupCancellation): Promise<Uint8Array> {
    validateBackupPassword(password);
    checkCancelled(cancelled);
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new BackupError('invalid');
    const encoded = new TextEncoder().encode(json);
    let padded: Uint8Array | undefined;
    let key: Uint8Array | undefined;
    try {
        if (encoded.length > MAX_JSON_BYTES) throw new BackupError('size');
        padded = new Uint8Array(Math.ceil((encoded.length + 4) / BLOCK_SIZE) * BLOCK_SIZE);
        new DataView(padded.buffer).setUint32(0, encoded.length, false);
        padded.set(encoded, 4);
        const header = new Uint8Array(HEADER_SIZE);
        header.set(MAGIC);
        // Async native CSPRNG has no Math.random development fallback.
        let random: Uint8Array;
        try { random = await getRandomBytesAsync(44); }
        catch { throw new BackupError('unavailable'); }
        if (!(random instanceof Uint8Array) || random.length !== 44) throw new BackupError('unavailable');
        header.set(random, 8);
        key = await deriveKey(password, header.subarray(8, 40), cancelled);
        checkCancelled(cancelled);
        const ciphertext = gcm(key, header.subarray(40), header).encrypt(padded);
        const output = new Uint8Array(header.length + ciphertext.length);
        output.set(header); output.set(ciphertext, header.length);
        return output;
    } finally { encoded.fill(0); padded?.fill(0); key?.fill(0); }
}

export async function decryptBackup(input: Uint8Array, password: string, cancelled?: BackupCancellation): Promise<unknown> {
    if (!(input instanceof Uint8Array) || input.length < HEADER_SIZE + 16 + BLOCK_SIZE
        || input.length > MAX_BACKUP_BYTES || (input.length - HEADER_SIZE - 16) % BLOCK_SIZE !== 0
        || !MAGIC.every((byte, index) => input[index] === byte)) throw new BackupError('invalid');
    // Copy the bounded input: a caller must not mutate header/ciphertext while
    // asynchronous key derivation is in flight.
    const copy = input.slice();
    let key: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    try {
        key = await deriveKey(password, copy.subarray(8, 40), cancelled);
        checkCancelled(cancelled);
        try { plaintext = gcm(key, copy.subarray(40, HEADER_SIZE), copy.subarray(0, HEADER_SIZE)).decrypt(copy.subarray(HEADER_SIZE)); }
        catch { throw new BackupError('invalid'); } // Do not expose passwords, tags or payloads through errors.
        const length = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0, false);
        if (length > MAX_JSON_BYTES || length > plaintext.length - 4) throw new BackupError('invalid');
        checkCancelled(cancelled);
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(4, 4 + length))); }
        catch { throw new BackupError('invalid'); }
    } finally { key?.fill(0); plaintext?.fill(0); copy.fill(0); }
}
