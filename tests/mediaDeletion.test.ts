jest.mock('expo-media-library', () => ({ deleteAssetsAsync: jest.fn() }));

import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { deleteAssetsInBatches, getDeletionFailureKind } from '../services/mediaDeletion';

const nativeDelete = MediaLibrary.deleteAssetsAsync as jest.Mock;
const osDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
const versionDescriptor = Object.getOwnPropertyDescriptor(Platform, 'Version')!;
const ids = Array.from({ length: 2001 }, (_, i) => String(i + 1));

function platform(os: string, version: number | string) {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
    Object.defineProperty(Platform, 'Version', { configurable: true, value: version });
}

beforeEach(() => nativeDelete.mockResolvedValue(true));

it('distinguishes the SDK confirmation refusal from permission and provider failures', () => {
    expect(getDeletionFailureKind(new Error("Call rejected: User didn't grant write permission to requested files."))).toBe('cancelled');
    expect(getDeletionFailureKind(new Error('Missing media read permission'))).toBe('failed');
    expect(getDeletionFailureKind(new Error('Provider unavailable'))).toBe('failed');
});

it('sanitizes native failure details without claiming a successful batch', async () => {
    nativeDelete.mockRejectedValue(new Error('private synthetic path /not-a-real-photo.jpg'));
    const reconcile = jest.fn();
    await expect(deleteAssetsInBatches(['1'], reconcile)).rejects.toThrow('System deletion failed');
    expect(reconcile).not.toHaveBeenCalled();
});
afterEach(() => {
    Object.defineProperty(Platform, 'OS', osDescriptor);
    Object.defineProperty(Platform, 'Version', versionDescriptor);
});

it.each([['ios', '26'], ['android', 29]])('does not split requests on %s %s', async (os, version) => {
    platform(String(os), version);
    const reconcile = jest.fn();
    await deleteAssetsInBatches(ids, reconcile);
    expect(nativeDelete).toHaveBeenCalledTimes(1);
    expect(nativeDelete).toHaveBeenCalledWith(ids);
    expect(reconcile).toHaveBeenCalledWith(ids);
});

it.each([
    [30, 0], [30, 1], [30, 1000],
    [35, 1000], [36, 1000],
])('does not introduce additional prompts on Android API %s for %s assets', async (apiLevel, count) => {
    platform('android', apiLevel);
    const reconcile = jest.fn();
    const assets = ids.slice(0, count);
    await deleteAssetsInBatches(assets, reconcile);
    expect(nativeDelete).toHaveBeenCalledTimes(count === 0 ? 0 : 1);
    expect(reconcile).toHaveBeenCalledTimes(count === 0 ? 0 : 1);
    if (count > 0) expect(nativeDelete).toHaveBeenCalledWith(assets);
});

it.each([30, 31, 35, 36])('splits large deletion queues into max 1000-item batches on Android API %s', async apiLevel => {
    platform('android', apiLevel);
    const reconcile = jest.fn();
    await deleteAssetsInBatches(ids, reconcile);
    expect(nativeDelete.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1000, 1]);
    expect(reconcile.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1000, 1]);
});

it('reconciles a successful 1000-item request before asking for the next system confirmation on Android 11+', async () => {
    platform('android', 33);
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
    expect(nativeDelete.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1000, 1]);
    expect(reconcile.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1000, 1]);
});
