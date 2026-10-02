jest.mock('react-native-quick-crypto', () => ({ scrypt: jest.fn() }));
jest.unmock('../../services/backup/keyDerivation.native');
import { scryptSync } from 'node:crypto';
import { scrypt } from 'react-native-quick-crypto';
import { deriveBackupKey } from '../../services/backup/keyDerivation.native';
import { BACKUP_SCRYPT } from '../../services/backup/keyParameters';

it('uses asynchronous native scrypt with exactly the format-v1 costs and Unicode bytes', async () => {
    jest.mocked(scrypt).mockImplementationOnce((password: any, salt: any, length: any, options: any, callback: any) => {
        callback(null, scryptSync(password, salt, length, options));
    });
    const bytes = Buffer.from('测试-unique-password-2026');
    const salt = new Uint8Array(32).fill(3);
    const result = await deriveBackupKey(bytes, salt, () => undefined);
    const expected = scryptSync(bytes, salt, 32, BACKUP_SCRYPT);
    expect([...result]).toEqual([...expected]);
    expect(scrypt).toHaveBeenCalledWith(bytes, salt, 32, BACKUP_SCRYPT, expect.any(Function));
    result.fill(0); expected.fill(0); bytes.fill(0);
});
it('discards and wipes a native result when cancelled before it resolves', async () => {
    let callback!: (error: Error | null, result?: any) => void;
    let cancelled = false;
    const progress = jest.fn();
    jest.mocked(scrypt).mockImplementationOnce((_p: any, _s: any, _l: any, _o: any, cb: any) => { callback = cb; });
    const operation = deriveBackupKey(new Uint8Array(16), new Uint8Array(32), () => {
        if (cancelled) throw new Error('cancelled');
    }, progress);
    cancelled = true;
    const result = Buffer.alloc(32, 4);
    callback(null, result);
    await expect(operation).rejects.toThrow('cancelled');
    expect([...result]).toEqual(new Array(32).fill(0));
    expect(progress).not.toHaveBeenCalled();
});
it('fails closed on native errors or malformed results rather than using another backend', async () => {
    const bad = Buffer.alloc(16, 4);
    jest.mocked(scrypt).mockImplementationOnce((_p: any, _s: any, _l: any, _o: any, cb: any) => cb(new Error('native error')))
        .mockImplementationOnce((_p: any, _s: any, _l: any, _o: any, cb: any) => cb(null, bad));
    for (let i = 0; i < 2; i++) await expect(deriveBackupKey(new Uint8Array(16), new Uint8Array(32), () => undefined)).rejects.toThrow('unavailable');
    expect([...bad]).toEqual(new Array(16).fill(0));
});
