jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { readMediaSizes, validMediaBytes } from '../services/mediaSizes';
const read = jest.fn();
const originalOS = Platform.OS;
beforeEach(() => {
    Platform.OS = 'android'; read.mockReset();
    jest.mocked(requireOptionalNativeModule).mockReturnValue({ readSizes: read });
});
afterEach(() => { Platform.OS = originalOS; });
it.each([null, undefined, 0, -1, NaN, Infinity, 1.5, '10', Number.MAX_SAFE_INTEGER + 1])('keeps invalid or missing size %s unknown', value => {
    expect(validMediaBytes(value)).toBeNull();
});
it('accepts exact large sizes without a 32-bit truncation', () => {
    expect(validMediaBytes(5 * 1024 ** 3)).toBe(5 * 1024 ** 3);
});
it('reads deduplicated batches and leaves inaccessible or zero-size rows unknown', async () => {
    read.mockResolvedValue([{ id: '2', bytes: 0 }, { id: '1', bytes: 5 * 1024 ** 3 }]);
    const result = await readMediaSizes('video', ['1', '2', '3', '1']);
    expect(read).toHaveBeenCalledWith('video', ['1', '2', '3']);
    expect([...result.sizes]).toEqual([['1', 5 * 1024 ** 3], ['2', null], ['3', null]]);
    expect(result.status).toBe('ready');
});
it('limits each native query and rejects malformed responses instead of publishing a partial ranking', async () => {
    read.mockImplementation(async (_, ids: string[]) => ids.map(id => ({ id, bytes: 100 })));
    const ids = Array.from({ length: 401 }, (_, index) => String(index + 1));
    expect((await readMediaSizes('photo', ids)).sizes.size).toBe(401);
    expect(read.mock.calls.map(call => call[1].length)).toEqual([200, 200, 1]);
    read.mockResolvedValue([{ id: 'foreign', bytes: 100 }]);
    expect(await readMediaSizes('photo', ['1'])).toEqual({ status: 'failed', sizes: new Map() });
});
it('discards sizes if permission/scope changes or the provider fails midway', async () => {
    let current = true;
    read.mockImplementation(async () => { current = false; return [{ id: '1', bytes: 10 }]; });
    expect(await readMediaSizes('photo', ['1'], () => current)).toEqual({ status: 'stale', sizes: new Map() });
    read.mockRejectedValue(new Error('Permission unavailable'));
    expect((await readMediaSizes('photo', ['1'])).status).toBe('failed');
});
it('does not claim old Android builds or unsupported platforms can read size', async () => {
    jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
    expect((await readMediaSizes('photo', ['1'])).status).toBe('unavailable');
    Platform.OS = 'ios';
    expect((await readMediaSizes('photo', ['iOS-synthetic-id'])).status).toBe('unavailable');
    expect(read).not.toHaveBeenCalled();
});
