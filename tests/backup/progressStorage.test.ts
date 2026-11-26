jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { flushMediaProgress, mediaProgressStorage } from '../../services/mediaProgressStorage';
it('serializes writes so an earlier slow decision cannot overwrite a later one', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    jest.mocked(AsyncStorage.setItem).mockReturnValueOnce(pending).mockResolvedValue(undefined);
    mediaProgressStorage.setItem('records', 'first'); mediaProgressStorage.setItem('records', 'second');
    await Promise.resolve();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    release(); await flushMediaProgress();
    expect(jest.mocked(AsyncStorage.setItem).mock.calls.map(([, value]) => value)).toEqual(['first', 'second']);
});
it('exposes write failure and recovers on retry without losing the latest records', async () => {
    jest.mocked(AsyncStorage.setItem).mockRejectedValue(new Error('disk full'));
    mediaProgressStorage.setItem('records', 'latest');
    await expect(flushMediaProgress()).rejects.toThrow();
    jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
    await expect(flushMediaProgress()).resolves.toBeUndefined();
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith('records', 'latest');
});
