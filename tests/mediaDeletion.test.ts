jest.mock('expo-media-library', () => ({ deleteAssetsAsync: jest.fn() }));

import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { deleteAssetsInBatches } from '../services/mediaDeletion';

const nativeDelete = MediaLibrary.deleteAssetsAsync as jest.Mock;
const osDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
const versionDescriptor = Object.getOwnPropertyDescriptor(Platform, 'Version')!;
const ids = Array.from({ length: 2001 }, (_, i) => String(i + 1));

function platform(os: string, version: number | string) {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
    Object.defineProperty(Platform, 'Version', { configurable: true, value: version });
}

beforeEach(() => nativeDelete.mockResolvedValue(true));
afterEach(() => {
    Object.defineProperty(Platform, 'OS', osDescriptor);
    Object.defineProperty(Platform, 'Version', versionDescriptor);
});

it.each([['ios', '26'], ['android', 35]])('does not change existing requests on %s %s', async (os, version) => {
    platform(String(os), version);
    const reconcile = jest.fn();
    await deleteAssetsInBatches(ids, reconcile);
    expect(nativeDelete).toHaveBeenCalledTimes(1);
    expect(nativeDelete).toHaveBeenCalledWith(ids);
    expect(reconcile).toHaveBeenCalledWith(ids);
});

it.each([0, 1, 2000])('does not introduce additional prompts for %s assets on Android 16', async count => {
    platform('android', 36);
    const reconcile = jest.fn();
    const assets = ids.slice(0, count);
    await deleteAssetsInBatches(assets, reconcile);
    expect(nativeDelete).toHaveBeenCalledTimes(count === 0 ? 0 : 1);
    expect(reconcile).toHaveBeenCalledTimes(count === 0 ? 0 : 1);
    if (count > 0) expect(nativeDelete).toHaveBeenCalledWith(assets);
});

it('reconciles a successful request before asking for the next system confirmation', async () => {
    platform('android', 36);
    let finishReconcile!: () => void;
    const reconciliation = new Promise<void>(resolve => { finishReconcile = resolve; });
    let notifyReconcile!: () => void;
    const started = new Promise<void>(resolve => { notifyReconcile = resolve; });
    const reconcile = jest.fn<Promise<void>, [string[]]>(async () => {
        if (reconcile.mock.calls.length === 1) {
            notifyReconcile();
            await reconciliation;
        }
    });
    const deletion = deleteAssetsInBatches(ids, reconcile);
    try {
        await started;
        expect(nativeDelete).toHaveBeenCalledTimes(1);
    } finally {
        finishReconcile();
        await deletion;
    }
    expect(nativeDelete.mock.calls.map(([batch]) => batch.length)).toEqual([2000, 1]);
    expect(reconcile.mock.calls.map(([batch]) => batch.length)).toEqual([2000, 1]);
});
