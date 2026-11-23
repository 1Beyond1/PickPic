import React from 'react';
import { act, fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as MediaLibrary from 'expo-media-library';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));
jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), getAlbumsAsync: jest.fn(),
    deleteAssetsAsync: jest.fn(), SortBy: { creationTime: 'creationTime' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../database', () => ({ AssetRepository: {} }));
const mockSettings = { groupSize: 10, selectedAlbumIds: [] as string[], displayOrder: 'oldest', setSelectedAlbums: jest.fn() };
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: Object.assign(() => mockSettings, { getState: () => mockSettings }) }));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
jest.mock('../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: require('../constants/theme').COLORS }) }));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string, params: Record<string, string | number> = {}) => {
    let value = require('../i18n/zh').default[key] ?? key;
    for (const [name, replacement] of Object.entries(params)) value = value.replace(`{${name}}`, String(replacement));
    return value;
} }) }));
jest.mock('../components/PendingDeletionReview', () => ({ PendingDeletionButton: () => null }));
// AlbumSelector has separate draft/permission tests. Only its selection boundary
// is substituted; this page and the media/session APIs remain real.
jest.mock('../components/AlbumSelector', () => ({ AlbumSelector: ({ visible, onConfirm }: any) => {
    const { Pressable, Text } = require('react-native');
    return visible ? <Pressable accessibilityRole="button" onPress={() => onConfirm(['camera'])}><Text>选择 Camera</Text></Pressable> : null;
} }));
import { OrganizingScopeModal } from '../components/OrganizingScopeModal';
import { useMediaStore } from '../stores/useMediaStore';
import { createMediaMonth } from '../services/mediaMonth';
const month = createMediaMonth(2026, 10);
const asset = (id: string, creationTime: number, mediaType = 'photo') => ({ id, creationTime, mediaType, uri: `file:///synthetic-${id}.jpg`,
    filename: `${id}.jpg`, width: 20, height: 20 }) as any;
let fixtures: any[];
beforeEach(() => {
    jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
    fixtures = [asset('start', month.startInclusive), asset('middle', month.startInclusive + 10000), asset('next', month.endExclusive), asset('unknown', 0)];
    mockSettings.selectedAlbumIds = []; mockSettings.setSelectedAlbums.mockClear();
    useMediaStore.setState({ hasHydrated: true, photos: [], videos: [], photoProcessedIds: [], videoProcessedIds: [],
        deleteQueue: [], videoTrashBin: [], collectionQueue: [], pendingDeletionInfo: {}, recentDecisions: [],
        organizingSessions: { photo: null, video: null }, isLoading: false, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
        photoSessionRecoveryStatus: null, videoSessionRecoveryStatus: null, photoLoadFailed: false, videoLoadFailed: false,
        permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0, totalPhotos: 40, totalVideos: 30 });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([{ id: 'camera' }] as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async options => {
        const assets = fixtures.filter(item => item.mediaType === options?.mediaType
            && (options?.createdAfter === undefined || item.creationTime > Number(options.createdAfter))
            && (options?.createdBefore === undefined || item.creationTime < Number(options.createdBefore)));
        if ((options?.sortBy as any)?.[0]?.[1] === false) assets.reverse();
        return { assets, totalCount: assets.length, hasNextPage: false } as any;
    });
});
const startButton = () => screen.getByRole('button', { name: '按此范围开始整理' });
it('does not block the main scope when an optional album suggestion is slow', async () => {
    let release!: (value: any) => void;
    jest.mocked(MediaLibrary.getAlbumsAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const view = await renderAsync(<OrganizingScopeModal visible kind="photo" onStarted={jest.fn()} onClose={jest.fn()} />);
    try {
        await waitFor(() => expect(screen.getByRole('radio', { name: '2026 年 10 月' })).toBeTruthy());
        expect(startButton()).toBeEnabled();
        expect(screen.queryByRole('button', { name: '选择截图相册' })).toBeNull();
        expect(useMediaStore.getState().organizingSessions.photo).toBeNull();
    } finally {
        await act(async () => release([{ id: 'shot', title: 'Screenshots' }]));
        await view.unmountAsync();
    }
});
it.each(['photo', 'video'] as const)('the %s source shortcut changes only a draft album selection, keeps date/order and requires explicit start', async kind => {
    fixtures = fixtures.map(item => ({ ...item, mediaType: kind }));
    const saved = useMediaStore.getState().startOrganizingSession(kind, { albumIds: [], order: 'newest', date: month }, ['start']);
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([{ id: 'camera', title: kind === 'photo' ? 'Screenshots' : 'ScreenRecordings' }] as any);
    const { onStarted } = await open(kind);
    await waitFor(() => expect(screen.getByText(require('../i18n/zh').default.scope_source_hint)).toBeTruthy());
    await fireEventAsync.press(screen.getByRole('button', { name: kind === 'photo' ? '选择截图相册' : '选择录屏相册' }));
    expect(useMediaStore.getState().organizingSessions[kind]).toBe(saved); expect(onStarted).not.toHaveBeenCalled();
    await waitFor(() => expect(startButton()).toBeEnabled());
    expect(screen.getByText('已选择 1 个相册')).toBeTruthy();
    await fireEventAsync.press(startButton());
    expect(useMediaStore.getState().organizingSessions[kind]?.scope).toEqual({ albumIds: ['camera'], order: 'newest', date: month });
    expect(onStarted).toHaveBeenCalledTimes(1); expect(mockSettings.selectedAlbumIds).toEqual([]);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
it.each(['photo', 'video'] as const)('starts %s largest-first from the range page, with a distinct unknown-size explanation and no global preference change', async kind => {
    const original = Platform.OS;
    try {
        Platform.OS = 'android';
        fixtures = [asset('1', 0, kind), asset('2', 0, kind), asset('3', 0, kind)];
        jest.mocked(requireOptionalNativeModule).mockReturnValue({ readSizes: jest.fn(async (_: string, ids: string[]) =>
            ids.map(id => ({ id, bytes: id === '1' ? 50 : id === '2' ? 200 : null }))) });
        const { onStarted } = await open(kind);
        await fireEventAsync.press(screen.getByRole('radio', { name: '大文件优先' }));
        expect(screen.getByText(require('../i18n/zh').default.scope_size_hint)).toBeTruthy();
        await fireEventAsync.press(startButton());
        expect(onStarted).toHaveBeenCalledTimes(1);
        expect(useMediaStore.getState().organizingSessions[kind]).toMatchObject({ scope: { order: 'largest' }, assetIds: ['2', '1'] });
        expect(mockSettings.displayOrder).toBe('oldest');
        expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    } finally { Platform.OS = original; }
});
it('disables unsupported largest-first without replacing or disguising the saved session', async () => {
    const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'largest' }, ['1']);
    await renderAsync(<OrganizingScopeModal visible kind="photo" onStarted={jest.fn()} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText(require('../i18n/zh').default.scope_size_unavailable)).toBeTruthy());
    expect(screen.getByRole('radio', { name: '大文件优先' })).toBeDisabled();
    expect(startButton()).toBeDisabled();
    await fireEventAsync.press(screen.getByRole('radio', { name: '最旧优先' }));
    await waitFor(() => expect(startButton()).toBeEnabled());
    expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
});
async function open(kind: 'photo' | 'video' = 'photo') {
    const onStarted = jest.fn(), onClose = jest.fn();
    const view = await renderAsync(<OrganizingScopeModal visible kind={kind} onStarted={onStarted} onClose={onClose} />);
    await waitFor(() => expect(startButton()).toBeEnabled());
    return { view, onStarted, onClose };
}
it.each(['photo', 'video'] as const)('starts an actual %s session with the selected album, month and order, preserving previous decisions', async kind => {
    fixtures = fixtures.map(item => ({ ...item, mediaType: kind }));
    const store = useMediaStore.getState();
    if (kind === 'photo') store.markAsSkipped(fixtures[0]); else store.markVideoAsProcessed(fixtures[0]);
    const { onStarted } = await open(kind);
    await fireEventAsync.press(screen.getByRole('button', { name: '相册范围' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '选择 Camera' }));
    await waitFor(() => expect(startButton()).toBeEnabled());
    await fireEventAsync.press(screen.getByRole('radio', { name: '2026 年 10 月' }));
    await fireEventAsync.press(screen.getByRole('radio', { name: '最新优先' }));
    await fireEventAsync.press(startButton());
    expect(onStarted).toHaveBeenCalledTimes(1);
    const state = useMediaStore.getState();
    expect(state.organizingSessions[kind]).toMatchObject({ scope: { albumIds: ['camera'], order: 'newest', date: month }, assetIds: ['middle'] });
    expect(kind === 'photo' ? state.photoProcessedIds : state.videoProcessedIds).toEqual(['start']);
    expect(kind === 'photo' ? state.videoProcessedIds : state.photoProcessedIds).toEqual([]);
    expect(mockSettings.selectedAlbumIds).toEqual([]); expect(mockSettings.displayOrder).toBe('oldest');
    expect(mockSettings.setSelectedAlbums).not.toHaveBeenCalled();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(state.totalPhotos).toBe(40); expect(state.totalVideos).toBe(30);
});
it('cancels a draft without replacing the saved session, order or decisions', async () => {
    const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['start', 'middle']);
    const { onClose, onStarted } = await open();
    await fireEventAsync.press(screen.getByRole('radio', { name: '拍摄日期未知' }));
    await fireEventAsync.press(screen.getByRole('radio', { name: '随机' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '返回整理' }));
    expect(onClose).toHaveBeenCalledTimes(1); expect(onStarted).not.toHaveBeenCalled();
    expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
});
it('does not start using stale counts after the accessible-library generation changes', async () => {
    const { onStarted } = await open();
    let release!: (value: any) => void;
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await act(async () => { useMediaStore.setState({ permissionRefreshVersion: 1 }); });
    expect(startButton()).toBeDisabled();
    await fireEventAsync.press(startButton());
    expect(onStarted).not.toHaveBeenCalled(); expect(useMediaStore.getState().organizingSessions.photo).toBeNull();
    await act(async () => release({ assets: [], totalCount: 0, hasNextPage: false }));
    await waitFor(() => expect(startButton()).toBeEnabled());
});
it('keeps the original session when permission is lost after a successful range read', async () => {
    const saved = useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['start']);
    const { onStarted } = await open();
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: false, accessPrivileges: 'none' } as any);
    await fireEventAsync.press(startButton());
    expect(onStarted).not.toHaveBeenCalled(); expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
    expect(screen.getByText('无法开始此范围，请重新读取或检查相册权限。原会话仍保留。')).toBeTruthy();
    await waitFor(() => expect(startButton()).toBeDisabled());
});
it('allows an empty unknown-date scope without guessing dates or processing other media', async () => {
    fixtures = fixtures.filter(item => item.creationTime !== 0);
    const { onStarted } = await open();
    await fireEventAsync.press(screen.getByRole('radio', { name: '拍摄日期未知' }));
    await fireEventAsync.press(startButton());
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ scope: { date: 'unknown' }, phase: 'complete', assetIds: [] });
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
});

it.each([30, 90] as const)('applies the old screenshots (%id) quick preset combining screenshot albums and creation-time filter', async days => {
    const now = Date.now();
    const veryOldTime = now - (days + 10) * 86400000;
    const recentTime = now - 5 * 86400000;
    fixtures = [
        asset('old-shot', veryOldTime, 'photo'),
        asset('recent-shot', recentTime, 'photo'),
        asset('unknown-shot', 0, 'photo'),
    ];
    jest.mocked(MediaLibrary.getAlbumsAsync).mockResolvedValue([
        { id: 'alb-shots', title: 'Screenshots' },
        { id: 'alb-cam', title: 'Camera' },
    ] as any);

    const { onStarted } = await open('photo');
    await waitFor(() => expect(screen.getByTestId(`scope-preset-old-screenshots-${days}`)).toBeEnabled());
    await fireEventAsync.press(screen.getByTestId(`scope-preset-old-screenshots-${days}`));
    await waitFor(() => expect(startButton()).toBeEnabled());

    expect(screen.getByText(`当前选择：${days} 天前`)).toBeTruthy();
    expect(onStarted).not.toHaveBeenCalled();

    await fireEventAsync.press(startButton());
    expect(onStarted).toHaveBeenCalledTimes(1);
    const session = useMediaStore.getState().organizingSessions.photo;
    expect(session).toMatchObject({
        scope: {
            albumIds: ['alb-shots'],
            order: 'oldest',
            date: { kind: 'older_than', days },
        },
        assetIds: ['old-shot'],
    });
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('applies the large videos quick preset using Android PickPicMediaIndex largest-first sorting', async () => {
    const original = Platform.OS;
    try {
        Platform.OS = 'android';
        fixtures = [asset('10', 1000, 'video'), asset('20', 2000, 'video'), asset('30', 3000, 'video')];
        jest.mocked(requireOptionalNativeModule).mockReturnValue({
            readSizes: jest.fn(async (_: string, ids: string[]) => ids.map(id => ({
                id,
                bytes: id === '10' ? 5_000_000 : id === '20' ? 250_000_000 : 12_000_000,
            }))),
        });
        const { onStarted } = await open('video');
        await fireEventAsync.press(screen.getByTestId('scope-preset-large-videos'));
        await fireEventAsync.press(startButton());

        expect(onStarted).toHaveBeenCalledTimes(1);
        expect(useMediaStore.getState().organizingSessions.video).toMatchObject({
            scope: { albumIds: [], order: 'largest' },
            assetIds: ['20', '30', '10'],
        });
        expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    } finally {
        Platform.OS = original;
    }
});
