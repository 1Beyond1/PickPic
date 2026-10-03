import React from 'react';
import { act, fireEvent, fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

jest.mock('expo-media-library', () => ({
    getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), getAlbumsAsync: jest.fn(), getAssetInfoAsync: jest.fn(),
    deleteAssetsAsync: jest.fn(), SortBy: { creationTime: 'creationTime' }, presentPermissionsPickerAsync: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../database', () => ({ AssetRepository: { removeAssetAndDerivedData: jest.fn(async () => {}) } }));
const mockSettings = { groupSize: 10, displayOrder: 'oldest', selectedAlbumIds: [] as string[], hasHydrated: true, setSelectedAlbums: jest.fn() };
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: Object.assign(() => mockSettings, { getState: () => mockSettings }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null, Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 32, bottom: 24, left: 0, right: 0 }) }));
jest.mock('../components/AlbumSelector', () => ({ AlbumSelector: () => null }));
jest.mock('../components/GlassContainer', () => ({ GlassContainer: ({ children }: any) => children }));
jest.mock('../components/PhotoCard', () => ({ PhotoCard: ({ photo, onSwipeDown, onSwipeUp }: any) => {
    const { View, Text, Pressable } = require('react-native');
    return <View testID={`card:${photo.id}`}><Text>{photo.id}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`keep:${photo.id}`} onPress={onSwipeDown}><Text>keep</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`queue:${photo.id}`} onPress={onSwipeUp}><Text>queue</Text></Pressable>
    </View>;
} }));
jest.mock('../hooks/useThemeColor', () => ({ useThemeColor: () => ({ isDark: false, colors: require('../constants/theme').COLORS }) }));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ language: 'zh', t: (key: string, params: Record<string, string | number> = {}) => {
    let value = require('../i18n/zh').default[key] ?? key;
    for (const [name, replacement] of Object.entries(params)) value = value.replace(`{${name}}`, String(replacement));
    return value;
} }) }));

import PhotosScreen from '../app/(tabs)/photos';
import { useMediaStore } from '../stores/useMediaStore';

const photo = (id: string) => ({ id, uri: `file:///synthetic-${id}.jpg`, filename: `${id}.jpg`, mediaType: 'photo', creationTime: 1, width: 800, height: 600 }) as any;
let mockLibrary = [photo('one'), photo('two'), photo('three')];
const originalOS = Platform.OS;
beforeEach(async () => {
    Platform.OS = 'android';
    mockLibrary = [photo('one'), photo('two'), photo('three')];
    mockSettings.selectedAlbumIds = [];
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    (MediaLibrary.getAlbumsAsync as jest.Mock).mockResolvedValue([{ id: 'saved' }, { id: 'new-scope' }]);
    (MediaLibrary.getAssetsAsync as jest.Mock).mockImplementation(async ({ album }: any) => ({
        assets: album === 'new-scope' ? [photo('other')] : mockLibrary, hasNextPage: false, totalCount: mockLibrary.length,
    }));
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => photo(id));
    await act(async () => useMediaStore.setState({ photos: [], videos: [], albums: [], hasHydrated: true,
        photoProcessedIds: [], videoProcessedIds: [], deleteQueue: [], collectionQueue: [], videoTrashBin: [],
        organizingSessions: { photo: null, video: null }, photoSessionRecoveryStatus: null, photoSessionUnavailableCount: 0,
        isLoading: false, photoLoadFailed: false, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
        pendingDeletionInfo: {}, deletedCounts: { photos: 0, videos: 0 }, lastDeletionResult: null, recentDecisions: [],
        permissionScope: 'full', permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0,
    }));
});
afterEach(() => { Platform.OS = originalOS; });

function measureDeck() {
    fireEvent(screen.getByTestId('photos-deck-viewport'), 'layout', { nativeEvent: { layout: { width: 390, height: 450 } } });
}
async function start() {
    const view = await renderAsync(<PhotosScreen />);
    await fireEventAsync.press(await screen.findByRole('button', { name: '开始整理' }));
    measureDeck();
    return view;
}

it('uses real decisions: skip is neither processed nor pending, and can be revisited after batch review', async () => {
    await start();
    await fireEventAsync.press(screen.getByRole('button', { name: '暂时跳过' }));
    expect(useMediaStore.getState().organizingSessions.photo?.deferredIds).toEqual(['one']);
    expect(useMediaStore.getState().photoProcessedIds).toEqual([]);
    expect(useMediaStore.getState().deleteQueue).toEqual([]);
    await fireEventAsync.press(screen.getByRole('button', { name: 'keep:two' }));
    await fireEventAsync.press(screen.getByRole('button', { name: 'queue:three' }));
    expect(screen.getByTestId('photo-review')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: '保留第 1 项，保持已整理' })).toBeEnabled());
    await fireEventAsync.press(screen.getByRole('button', { name: '保留第 1 项，保持已整理' }));
    expect(screen.getByTestId('photo-review')).toBeTruthy();
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['two', 'three']);
    await fireEventAsync.press(screen.getByRole('button', { name: '继续整理' }));
    expect(screen.getByTestId('photos-home')).toBeTruthy();
    await fireEventAsync.press(screen.getByRole('button', { name: '处理本轮跳过的 1 项' }));
    measureDeck();
    expect(screen.getByTestId('card:one')).toBeTruthy();
    expect(screen.queryByTestId('card:two')).toBeNull();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('returns home and reopens after a screen restart with the saved order instead of a newly sampled batch', async () => {
    const view = await start();
    await fireEventAsync.press(screen.getByRole('button', { name: 'keep:one' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '返回首页' }));
    expect(screen.getByRole('button', { name: '继续上次整理' })).toBeTruthy();
    const saved = useMediaStore.getState().organizingSessions.photo;
    await view.unmountAsync();
    mockLibrary = [photo('three'), photo('two'), photo('other')];
    useMediaStore.getState().clearLoadedMedia();
    await renderAsync(<PhotosScreen />);
    await fireEventAsync.press(await screen.findByRole('button', { name: '继续上次整理' }));
    measureDeck();
    expect(useMediaStore.getState().photos.map(asset => asset.id)).toEqual(['two', 'three']);
    expect(screen.getByRole('progressbar').props.accessibilityValue).toEqual({ min: 0, max: 3, now: 2 });
    expect(useMediaStore.getState().organizingSessions.photo).toBe(saved);
    expect(screen.queryByTestId('card:other')).toBeNull();
});

it('continues a captured scope after settings change and uses the new settings only for an explicit new round', async () => {
    mockSettings.selectedAlbumIds = ['saved'];
    const view = await start();
    await fireEventAsync.press(screen.getByRole('button', { name: 'keep:one' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '返回首页' }));
    mockSettings.selectedAlbumIds = ['new-scope'];
    await view.rerenderAsync(<PhotosScreen />);
    await waitFor(() => expect(screen.getByText('上次范围：1 个相册 · 最旧优先')).toBeTruthy());
    expect(useMediaStore.getState().organizingSessions.photo?.scope.albumIds).toEqual(['saved']);
    expect(useMediaStore.getState().photos.map(asset => asset.id)).toEqual(['two', 'three']);
    await fireEventAsync.press(screen.getByRole('button', { name: '开始新一轮' }));
    measureDeck();
    expect(useMediaStore.getState().organizingSessions.photo?.scope.albumIds).toEqual(['new-scope']);
    expect(screen.getByTestId('card:other')).toBeTruthy();
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['one']);
});

it('does not discard an inaccessible earlier photo while readable later members are handled', async () => {
    useMediaStore.getState().startOrganizingSession('photo', { albumIds: [], order: 'oldest' }, ['one', 'two', 'three']);
    mockLibrary = [photo('two'), photo('three')];
    await renderAsync(<PhotosScreen />);
    await fireEventAsync.press(await screen.findByRole('button', { name: '继续上次整理' }));
    measureDeck();
    await fireEventAsync.press(screen.getByRole('button', { name: '暂时跳过' }));
    await fireEventAsync.press(screen.getByRole('button', { name: 'keep:three' }));
    expect(screen.getByRole('alert').props.children).toBe('上次整理的部分内容暂时无法访问');
    expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ assetIds: ['one', 'two', 'three'], position: 0, deferredIds: ['two'] });
    mockLibrary = [photo('one'), photo('two'), photo('three')];
    await act(async () => { useMediaStore.getState().notifyPermissionRefresh(); });
    await waitFor(() => expect(useMediaStore.getState().photos.map(asset => asset.id)).toEqual(['one']));
    measureDeck();
    expect(screen.getByTestId('card:one')).toBeTruthy();
    await fireEventAsync.press(screen.getByRole('button', { name: 'keep:one' }));
    expect(screen.getByRole('button', { name: '处理本轮跳过的 1 项' })).toBeTruthy();
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['three', 'one']);
});

it('distinguishes batch completion from exhaustion of the accessible library', async () => {
    await start();
    for (const id of ['one', 'two', 'three']) await fireEventAsync.press(screen.getByRole('button', { name: `keep:${id}` }));
    expect(screen.getByText('本组整理完成')).toBeTruthy();
    expect(screen.queryByText('当前可访问图库已整理完')).toBeNull();
    await fireEventAsync.press(screen.getByRole('button', { name: '查找下一批' }));
    expect(await screen.findByText('当前可访问图库已整理完')).toBeTruthy();
    await fireEventAsync.press(screen.getByRole('button', { name: '返回首页' }));
    expect(screen.getByTestId('photos-home')).toBeTruthy();
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['one', 'two', 'three']);
});

it('undoes from the completion screen and restores only the last photo to the deck', async () => {
    await start();
    for (const id of ['one', 'two', 'three']) await fireEventAsync.press(screen.getByRole('button', { name: `keep:${id}` }));
    expect(screen.getByText('本组整理完成')).toBeTruthy();
    await fireEventAsync.press(screen.getByRole('button', { name: '撤销上一步' }));
    await waitFor(() => expect(useMediaStore.getState().isLoading).toBe(false));
    measureDeck();
    expect(screen.getByTestId('card:three')).toBeTruthy();
    expect(screen.queryByTestId('card:one')).toBeNull();
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['one', 'two']);
    expect(useMediaStore.getState().organizingSessions.photo).toMatchObject({ position: 2, phase: 'organizing' });
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
