jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn(async (size: number) => new Uint8Array(require('node:crypto').randomBytes(size))) }));
import { createDecipheriv, scryptSync } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { getRandomBytesAsync } from 'expo-crypto';
import { decryptBackup, encryptBackup, MAX_BACKUP_BYTES } from '../../services/backup/crypto';

Object.assign(globalThis, { TextEncoder, TextDecoder });
jest.setTimeout(60000);
const password = 'test-only-long-passphrase-2026';
const payload = { version: 1, privateRecord: '测试照片-id-123', count: 3 };
let encrypted: Uint8Array;
beforeAll(async () => { encrypted = await encryptBackup(payload, password); });

it('round-trips Chinese records and independently decrypts with Node crypto', async () => {
    expect(await decryptBackup(encrypted, password)).toEqual(payload);
    const key = scryptSync(password, encrypted.subarray(8, 40), 32, { N: 65536, r: 8, p: 2, maxmem: 80 * 1024 * 1024 });
    const cipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(40, 52));
    cipher.setAAD(encrypted.subarray(0, 52)); cipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([cipher.update(encrypted.subarray(52, -16)), cipher.final()]);
    expect(JSON.parse(plaintext.subarray(4, 4 + plaintext.readUInt32BE(0)).toString('utf8'))).toEqual(payload);
    expect(Buffer.from(encrypted).includes(Buffer.from('测试照片'))).toBe(false);
    key.fill(0); plaintext.fill(0);
});
it('uses a fresh salt and nonce; small record-count changes share a padded size', async () => {
    const second = await encryptBackup({ ...payload, count: 30 }, password);
    expect(second.length).toBe(encrypted.length);
    expect(second.subarray(8, 40)).not.toEqual(encrypted.subarray(8, 40));
    expect(second.subarray(40, 52)).not.toEqual(encrypted.subarray(40, 52));
});
it('rejects wrong passwords without returning plaintext', async () => {
    await expect(decryptBackup(encrypted, 'a-different-long-passphrase')).rejects.toMatchObject({ code: 'invalid' });
});
it.each([8, 40, 52, -1])('authenticates salt, nonce, ciphertext and tag (%s)', async position => {
    const modified = encrypted.slice();
    modified[position < 0 ? modified.length + position : position] ^= 1;
    await expect(decryptBackup(modified, password)).rejects.toMatchObject({ code: 'invalid' });
});
it('rejects malformed headers and oversized input before password derivation', async () => {
    const changed = encrypted.slice(); changed[0] ^= 1;
    for (const value of [changed, new Uint8Array(100), new Uint8Array(MAX_BACKUP_BYTES + 1)]) {
        await expect(decryptBackup(value, '')).rejects.toMatchObject({ code: 'invalid' });
    }
});
it('fails closed if native randomness is unavailable', async () => {
    jest.mocked(getRandomBytesAsync).mockRejectedValueOnce(new Error('native unavailable'));
    await expect(encryptBackup(payload, password)).rejects.toMatchObject({ code: 'unavailable' });
});
it('cancels during derivation without publishing a result', async () => {
    let calls = 0;
    await expect(encryptBackup(payload, password, () => ++calls > 3)).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toBeGreaterThan(3);
});
it('rejects weak or empty passwords', async () => {
    for (const value of ['', '123456', 'aaaaaaaaaaaa']) await expect(encryptBackup(payload, value)).rejects.toMatchObject({ code: 'password' });
});
