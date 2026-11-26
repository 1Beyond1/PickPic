import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { createOrganizingSession } from '../services/organizingSession';
import { recoverOrganizingSession } from '../services/sessionRecovery';
import { createMediaMonth, mediaMonthQuery } from '../services/mediaMonth';

jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAlbumsAsync: jest.fn(), getAssetsAsync: jest.fn() }));
const permissions = MediaLibrary.getPermissionsAsync as jest.Mock;
const albums = MediaLibrary.getAlbumsAsync as jest.Mock;
const page = MediaLibrary.getAssetsAsync as jest.Mock;
const originalOS = Platform.OS;
const asset = (id: string, mediaType = 'photo') => ({ id, mediaType, uri: `file:///fresh-${id}.jpg` });
const session = (albumIds: string[] = []) => createOrganizingSession('photo', { albumIds, order: 'random' }, ['c', 'a', 'b'], 'synthetic', 1);
beforeEach(() => {
    Platform.OS = 'android';
    permissions.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    albums.mockResolvedValue([{ id: 'family' }]);
    page.mockResolvedValue({ assets: [asset('a'), asset('b'), asset('c')], hasNextPage: false });
});
afterEach(() => { Platform.OS = originalOS; });

it('recovers the exact original randomized order from fresh URIs without writing session data', async () => {
    const saved = session(), snapshot = JSON.stringify(saved);
    const recovered = await recoverOrganizingSession(saved, new Set());
    expect(recovered).toMatchObject({ status: 'ready', unavailableCount: 0 });
    expect(recovered.assets.map(item => item.id)).toEqual(['c', 'a', 'b']);
    expect(page).toHaveBeenCalledWith({ mediaType: 'photo', first: 200, resolveWithFullInfo: false });
    expect(JSON.stringify(saved)).toBe(snapshot);
});
it('resumes only saved members still inside the captured month, without changing the original boundaries', async () => {
    const date = createMediaMonth(2026, 10);
    const saved = createOrganizingSession('photo', { albumIds: [], order: 'oldest', date }, ['a', 'b'], 'month-session', 1);
    page.mockResolvedValue({ assets: [{ ...asset('a'), creationTime: date.startInclusive }, { ...asset('b'), creationTime: date.endExclusive }], hasNextPage: false });
    expect(await recoverOrganizingSession(saved, new Set())).toMatchObject({ status: 'ready', unavailableCount: 1, assets: [{ id: 'a' }] });
    expect(page).toHaveBeenCalledWith(expect.objectContaining(mediaMonthQuery(date)));
    expect(saved.scope.date).toEqual(date); expect(saved.assetIds).toEqual(['a', 'b']);
});
it('excludes already processed, deferred and earlier navigation positions', async () => {
    const saved = { ...session(), position: 1, deferredIds: ['b'] };
    expect((await recoverOrganizingSession(saved, new Set(['a']))).status).toBe('review');
    expect(page).not.toHaveBeenCalled();
});
it('does not silently widen a disappeared album to all media', async () => {
    albums.mockResolvedValue([]);
    expect((await recoverOrganizingSession(session(['missing']), new Set())).status).toBe('unavailable');
    expect(page).not.toHaveBeenCalled();
});
it('does not mistake a still-accessible iOS smart album for a missing album during recovery', async () => {
    Platform.OS = 'ios';
    albums.mockImplementation(async (options: any) => options?.includeSmartAlbums ? [{ id: 'family', type: 'smartAlbum' }] : []);
    expect((await recoverOrganizingSession(session(['family']), new Set())).status).toBe('ready');
});
it('keeps album constraints and rejects disappearance during enumeration', async () => {
    albums.mockResolvedValueOnce([{ id: 'family' }]).mockResolvedValueOnce([]);
    expect((await recoverOrganizingSession(session(['family']), new Set())).status).toBe('unavailable');
    expect(page).toHaveBeenCalledWith(expect.objectContaining({ album: 'family' }));
});
it('never attempts an album query under iOS selected-only permission', async () => {
    Platform.OS = 'ios'; permissions.mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    expect((await recoverOrganizingSession(session(['family']), new Set())).status).toBe('unavailable');
    expect(albums).not.toHaveBeenCalled(); expect(page).not.toHaveBeenCalled();
});
it('reports missing accessible members without changing the saved order or marking them processed', async () => {
    page.mockResolvedValue({ assets: [asset('b'), asset('a', 'video')], hasNextPage: false });
    const saved = session();
    const result = await recoverOrganizingSession(saved, new Set());
    expect(result).toMatchObject({ status: 'ready', assets: [asset('b')], unavailableCount: 2 });
    expect(saved.assetIds).toEqual(['c', 'a', 'b']);
});
it('distinguishes permission denial, a provider failure and an exhausted accessible projection', async () => {
    permissions.mockResolvedValueOnce({ granted: false });
    expect((await recoverOrganizingSession(session(), new Set())).status).toBe('permission');
    page.mockRejectedValueOnce(new Error('Synthetic provider error'));
    expect((await recoverOrganizingSession(session(), new Set())).status).toBe('failed');
    page.mockResolvedValue({ assets: [], hasNextPage: false });
    expect((await recoverOrganizingSession(session(), new Set())).status).toBe('unavailable');
});
it('discards permission revocation and same-privilege selection changes that happen while paging', async () => {
    permissions.mockResolvedValueOnce({ granted: true, accessPrivileges: 'all' }).mockResolvedValueOnce({ granted: true, accessPrivileges: 'limited' });
    expect((await recoverOrganizingSession(session(), new Set())).status).toBe('permission');
    let current = true;
    page.mockImplementationOnce(async () => { current = false; return { assets: [asset('a')], hasNextPage: false }; });
    expect((await recoverOrganizingSession(session(), new Set(), () => current)).status).toBe('stale');
});
it('rejects incomplete cursor cycles rather than claiming their missing members are gone', async () => {
    page.mockResolvedValue({ assets: [asset('a')], hasNextPage: true, endCursor: 'cycle' });
    expect((await recoverOrganizingSession(session(), new Set())).status).toBe('failed');
    expect(page).toHaveBeenCalledTimes(2);
});
it('preserves a saved review/complete stage instead of loading a different random batch', async () => {
    expect((await recoverOrganizingSession({ ...session(), phase: 'review', position: 3 }, new Set())).status).toBe('review');
    expect((await recoverOrganizingSession({ ...session(), phase: 'complete', position: 3 }, new Set())).status).toBe('complete');
    expect(page).not.toHaveBeenCalled();
});

it('retains already kept video history and its current viewing position, but never reopens pending deletions', async () => {
    const saved = createOrganizingSession('video', { albumIds: [], order: 'random' }, ['c', 'a', 'b'], 'synthetic-video', 1);
    saved.position = 1;
    page.mockResolvedValue({ assets: [asset('a', 'video'), asset('b', 'video'), asset('c', 'video')], hasNextPage: false });
    const recovered = await recoverOrganizingSession(saved, new Set(['c', 'b']), () => true, new Set(['b']));
    expect(recovered).toMatchObject({ status: 'ready', position: 1 });
    expect(recovered.assets.map(item => item.id)).toEqual(['c', 'a']);
});

it('revalidates completed video history before allowing a replay, while preserving the review stage', async () => {
    const saved = { ...createOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['a', 'b'], 'video', 1), phase: 'review' as const, position: 2 };
    page.mockResolvedValue({ assets: [asset('b', 'video'), asset('a', 'video')], hasNextPage: false });
    const recovered = await recoverOrganizingSession(saved, new Set(['a', 'b']));
    expect(recovered).toMatchObject({ status: 'review', position: 1, unavailableCount: 0 });
    expect(recovered.assets.map(item => item.id)).toEqual(['a', 'b']);
    expect(saved).toMatchObject({ phase: 'review', position: 2 });
    page.mockRejectedValueOnce(new Error('Synthetic provider failure'));
    expect((await recoverOrganizingSession(saved, new Set(['a', 'b']))).status).toBe('failed');
});
