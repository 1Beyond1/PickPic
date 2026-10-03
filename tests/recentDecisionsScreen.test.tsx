import React from 'react';
import { act, fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as MediaLibrary from 'expo-media-library';
import { StyleSheet, ScrollView } from 'react-native';
jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), getAssetInfoAsync: jest.fn(),
    deleteAssetsAsync: jest.fn(), SortBy: { creationTime: 'creationTime' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../database', () => ({ AssetRepository: {} }));
const mockBack = jest.fn(), mockPush = jest.fn();
const mockParams: { kind?: string } = {};
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: mockPush }), useLocalSearchParams: () => mockParams }));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null, Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 32, bottom: 24, left: 4, right: 4 }) }));
jest.mock('../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: require('../constants/theme').COLORS, isDark: false }) }));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ language: 'zh', t: (key: string, params: Record<string, string | number> = {}) => {
    let value = require('../i18n/zh').default[key] ?? key;
    for (const [name, replacement] of Object.entries(params)) value = value.replace(`{${name}}`, String(replacement));
    return value;
} }) }));
import RecentDecisionsScreen from '../app/recent-decisions';
import { RecentDecisionsButton } from '../components/RecentDecisionControls';
import { useMediaStore } from '../stores/useMediaStore';
import { usePrivacyStore } from '../stores/usePrivacyStore';
const photo = (id: string) => ({ id, uri: `file:///fresh-${id}.jpg`, filename: `${id}.jpg`, mediaType: 'photo', creationTime: 1, width: 10, height: 10 }) as any;
const video = (id: string) => ({ ...photo(id), mediaType: 'video' }) as any;
let mockLibrary = [photo('one'), photo('two'), video('movie')];
beforeEach(async () => {
    mockParams.kind = undefined; mockLibrary = [photo('one'), photo('two'), video('movie')]; usePrivacyStore.setState({ failures: {} });
    jest.mocked(MediaLibrary.getPermissionsAsync).mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async options => ({ assets: mockLibrary.filter(asset => asset.mediaType === options?.mediaType), hasNextPage: false } as any));
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async asset => {
        const id = typeof asset === 'string' ? asset : asset.id;
        return mockLibrary.find(item => item.id === id) ?? null;
    });
    await act(async () => useMediaStore.setState({ hasHydrated: true, photos: [], videos: [], photoProcessedIds: [], videoProcessedIds: [],
        deleteQueue: [], collectionQueue: [], videoTrashBin: [], organizingSessions: { photo: null, video: null },
        recentDecisions: [], pendingDeletionInfo: {}, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
        mediaLibraryRefreshVersion: 0, permissionRefreshVersion: 0, permissionScope: 'full' }));
});
it('opens the actual native route with the selected type, without changing any records', async () => {
    await renderAsync(<RecentDecisionsButton kind="video" />);
    await fireEventAsync.press(screen.getByRole('button', { name: '近期决定' }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recent-decisions', params: { kind: 'video' } });
    expect(useMediaStore.getState().recentDecisions).toEqual([]);
});
it('shows an honest empty state and returns without inventing legacy history', async () => {
    useMediaStore.setState({ photoProcessedIds: ['one'] });
    await renderAsync(<RecentDecisionsScreen />);
    expect(screen.getByText('还没有近期决定。旧记录不会被推测成撤销历史。')).toBeTruthy();
    await fireEventAsync.press(screen.getByRole('button', { name: '返回整理' }));
    expect(mockBack).toHaveBeenCalled(); expect(useMediaStore.getState().photoProcessedIds).toEqual(['one']);
});
it('keeps a chosen pending item on this page and preserves unrelated pending decisions', async () => {
    useMediaStore.getState().enqueuePendingDeletion([photo('one'), photo('two')], 'similar');
    await renderAsync(<RecentDecisionsScreen />);
    const button = await waitFor(() => screen.getByRole('button', { name: '第 1 项改为保留' }));
    await waitFor(() => expect(button).toBeEnabled());
    await fireEventAsync.press(button);
    expect(screen.getByTestId('recent-decisions')).toBeTruthy();
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['one']);
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['one', 'two']);
    expect(await screen.findByText('整理决定已修改')).toBeTruthy();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
});
it('undoes a keep without affecting other media and queues another keep without a native delete', async () => {
    useMediaStore.getState().markAsSkipped(photo('one')); useMediaStore.getState().markVideoAsProcessed(video('movie'));
    await renderAsync(<RecentDecisionsScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: '撤销第 2 项的这次决定' })).toBeEnabled());
    await fireEventAsync.press(screen.getByRole('button', { name: '撤销第 2 项的这次决定' }));
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]); expect(useMediaStore.getState().videoProcessedIds).toEqual(['movie']);
    await waitFor(() => expect(screen.getByRole('button', { name: '第 1 项加入待删除' })).toBeEnabled());
    await fireEventAsync.press(screen.getByRole('button', { name: '第 1 项加入待删除' }));
    expect(useMediaStore.getState().videoTrashBin.map(asset => asset.id)).toEqual(['movie']);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
it('does not leave stale previews or enabled changes after permission generation invalidation', async () => {
    useMediaStore.getState().markAsSkipped(photo('one'));
    await renderAsync(<RecentDecisionsScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: '查看第 1 项' })).toBeEnabled());
    await fireEventAsync.press(screen.getByRole('button', { name: '查看第 1 项' }));
    expect(screen.getByTestId('photo-preview')).toBeTruthy();
    mockLibrary = [];
    await act(async () => useMediaStore.setState({ permissionRefreshVersion: 1, mediaLibraryRefreshVersion: 1 }));
    await waitFor(() => expect(screen.getByRole('button', { name: '查看第 1 项' })).toBeDisabled());
    expect(screen.queryByTestId('photo-preview')).toBeNull();
    expect(screen.getByRole('button', { name: '撤销第 1 项的这次决定' })).toBeDisabled();
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['one']);
});
it('honors the initial media filter and keeps wrapped actions inside a scrollable safe-area layout', async () => {
    mockParams.kind = 'video'; useMediaStore.getState().markAsSkipped(photo('one')); useMediaStore.getState().markVideoAsProcessed(video('movie'));
    await renderAsync(<RecentDecisionsScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: '查看第 1 项' })).toBeEnabled());
    expect(screen.queryByText('one.jpg')).toBeNull(); expect(screen.getByText('movie.jpg')).toBeTruthy();
    const root = StyleSheet.flatten(screen.getByTestId('recent-decisions').props.style);
    expect(root.paddingBottom).toBe(24); expect(root.paddingLeft).toBe(4);
    expect(screen.UNSAFE_getByType(ScrollView)).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByRole('button', { name: '第 1 项加入待删除' }).props.style).minHeight).toBeGreaterThanOrEqual(44);
});
