import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { syncModalAppearance } from '../services/modalAppearance';

jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));
const initialOS = Platform.OS;
beforeEach(() => { Platform.OS = 'android'; jest.mocked(requireOptionalNativeModule).mockReset(); });
afterEach(() => { Platform.OS = initialOS; });

it('passes the actual resolved appearance to the Android dialog adapter', async () => {
    const sync = jest.fn(async () => {});
    jest.mocked(requireOptionalNativeModule).mockReturnValue({ syncModalAppearance: sync });
    await syncModalAppearance(true); await syncModalAppearance(false);
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('PickPicSystemUI');
    expect(sync.mock.calls).toEqual([[true], [false]]);
});
it.each(['ios', 'web'] as const)('does not query Android native windows on %s', async os => {
    Platform.OS = os; await syncModalAppearance(true);
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
});
it('keeps old-build absence and native failures out of the privacy/data workflow', async () => {
    jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
    await expect(syncModalAppearance(true)).resolves.toBeUndefined();
    jest.mocked(requireOptionalNativeModule).mockReturnValue({ syncModalAppearance: async () => { throw new Error('Unavailable'); } });
    await expect(syncModalAppearance(false)).resolves.toBeUndefined();
});
