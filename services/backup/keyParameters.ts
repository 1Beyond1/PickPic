// File-format v1 parameters: never take KDF costs from untrusted files.
export const BACKUP_SCRYPT = Object.freeze({ N: 65536, r: 8, p: 2, maxmem: 80 * 1024 * 1024 });
export const BACKUP_KEY_LENGTH = 32;
