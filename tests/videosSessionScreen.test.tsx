import React from 'react';
import { act, fireEvent, fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as MediaLibrary from 'expo-media-library';
import { FlatList, Platform, ScrollView } from 'react-native';

jest.mock('expo-media-library', () => ({ getPermissionsAsync: jest.fn(), getAssetsAsync: jest.fn(), getAlbumsAsync: jest.fn(),
    getAssetInfoAsync: jest.fn(), deleteAssetsAsync: jest.fn(), SortBy: { creationTime: 'creationTime' }, presentPermissionsPickerAsync: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../database', () => ({ AssetRepository: { removeAssetAndDerivedData: jest.fn(async () => {}), removeAssetsAndDerivedData: jest.fn(async () => {}) } }));
const mockSettings = { displayOrder: 'oldest', selectedAlbumIds: [] as string[], hasHydrated: true, setSelectedAlbums: jest.fn() };
jest.mock('../stores/useSettingsStore', () => ({ useSettingsStore: Object.assign(() => mockSettings, { getState: () => mockSettings }) }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]) }));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null, Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 32, bottom: 24, left: 0, right: 0 }) }));
jest.mock('../components/AlbumSelector', () => ({ AlbumSelector: () => null }));
jest.mock('../components/VideoFeedItem', () => ({ VideoFeedItem: ({ video, onDelete }: any) => {
    const { Pressable, Text } = require('react-native');
    return <Pressable accessibilityRole="button" accessibilityLabel={`queue:${video.id}`} onPress={onDelete}><Text>{video.id}</Text></Pressable>;
} }));
jest.mock('../hooks/useThemeColor', () => ({ useThemeColor: () => ({ isDark: false, colors: require('../constants/theme').COLORS }) }));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ language: 'zh', t: (key: string, params: Record<string, string | number> = {}) => {
    let value = require('../i18n/zh').default[key] ?? key;
    for (const [name, replacement] of Object.entries(params)) value = value.replace(`{${name}}`, String(replacement));
    return value;
} }) }));

import VideosScreen from '../app/(tabs)/videos';
import { useMediaStore } from '../stores/useMediaStore';
import { createMediaMonth } from '../services/mediaMonth';

const video = (id: string) => ({ id, uri: `file:///synthetic-${id}.mp4`, filename: `${id}.mp4`, mediaType: 'video', creationTime: 1, width: 800, height: 600 }) as any;
let mockLibrary = [video('one'), video('two'), video('three')];
const originalOS = Platform.OS;
beforeEach(async () => {
    Platform.OS = 'android'; mockLibrary = [video('one'), video('two'), video('three')];
    mockSettings.selectedAlbumIds = [];
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    (MediaLibrary.getAlbumsAsync as jest.Mock).mockResolvedValue([{ id: 'saved' }, { id: 'new-scope' }]);
    (MediaLibrary.getAssetsAsync as jest.Mock).mockImplementation(async ({ album }: any) => ({
        assets: album === 'new-scope' ? [video('other')] : mockLibrary, hasNextPage: false, totalCount: mockLibrary.length,
    }));
    (MediaLibrary.getAssetInfoAsync as jest.Mock).mockImplementation(async (id: string) => video(id));
    await act(async () => useMediaStore.setState({ photos: [], videos: [], albums: [], hasHydrated: true,
        photoProcessedIds: [], videoProcessedIds: [], deleteQueue: [], collectionQueue: [], videoTrashBin: [],
        organizingSessions: { photo: null, video: null }, videoCurrentIndex: 0, videoSessionRecoveryStatus: null, videoSessionUnavailableCount: 0,
        isLoading: false, videoLoadFailed: false, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
        pendingDeletionInfo: {}, deletedCounts: { photos: 0, videos: 0 }, lastDeletionResult: null, recentDecisions: [],
        permissionScope: 'full', permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0,
    }));
});
afterEach(() => { Platform.OS = originalOS; });

async function mount() {
    const view = await renderAsync(<VideosScreen />);
    await waitFor(() => expect(useMediaStore.getState().isLoading).toBe(false));
    fireEvent(screen.getByTestId('video-feed-viewport'), 'layout', { nativeEvent: { layout: { width: 390, height: 600 } } });
    const list = await waitFor(() => screen.UNSAFE_getByType(FlatList));
    const scrollView = list.findByType(ScrollView);
    fireEvent(scrollView, 'layout', { nativeEvent: { layout: { width: 390, height: 600 } } });
    fireEvent(scrollView, 'contentSizeChange', 390, list.props.data.length * 600);
    act(() => list.props.onViewableItemsChanged({ viewableItems: [{ key: list.props.data[list.props.initialScrollIndex].id }] }));
    return view;
}
function swipe(index: number) {
    const list = screen.UNSAFE_getByType(FlatList);
    const scrollView = list.findByType(ScrollView);
    act(() => {
        list.props.onScrollBeginDrag();
        fireEvent.scroll(scrollView, {
            nativeEvent: {
                contentOffset: { x: 0, y: index * 600 },
                contentSize: { width: 390, height: list.props.data.length * 600 },
                layoutMeasurement: { width: 390, height: 600 },
            },
        });
        list.props.onViewableItemsChanged({ viewableItems: [{ key: list.props.data[index].id }] });
        list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: index * 600 } } });
    });
}
function visible() {
    const list = screen.UNSAFE_getByType(FlatList);
    const index = useMediaStore.getState().videoCurrentIndex;
    act(() => list.props.onViewableItemsChanged({ viewableItems: [{ key: list.props.data[index].id }] }));
}

it('largest-first empty scope is not described as an organized whole library', async () => {
    useMediaStore.getState().startOrganizingSession('video', { albumIds: [], order: 'largest' }, []);
    await renderAsync(<VideosScreen />);
    expect(await screen.findByText('已知大小的内容已整理完')).toBeTruthy();
    expect(screen.getByText('大小未知的内容未纳入，可切换其他顺序查看。')).toBeTruthy();
    expect(screen.queryByText('可访问视频已整理完')).toBeNull();
    const saved = useMediaStore.getState().organizingSessions.video;
    await fireEventAsync.press(screen.getByRole('button', { name: '开始新一轮' }));
    expect(await screen.findByRole('radio', { name: '大文件优先', checked: true })).toBeTruthy();
    expect(useMediaStore.getState().organizingSessions.video).toBe(saved);
});
it('permission lost during a session read is distinct from completion and still offers access management', async () => {
    await mount();
    await fireEventAsync.press(screen.getByRole('button', { name: '返回首页' }));
    await act(async () => useMediaStore.setState({ videos: [], videoSessionRecoveryStatus: 'permission', videoLoadFailed: false }));
    expect(screen.getByText('需要视频访问权限')).toBeTruthy();
    expect(screen.getByText(require('../i18n/zh').default.video_permission_btn)).toBeTruthy();
});

it('opens a monthly scope from video home without marking a viewed video as processed', async () => {
    const date = createMediaMonth(2026, 10);
    mockLibrary = [{ ...video('one'), creationTime: date.startInclusive }, { ...video('two'), creationTime: date.endExclusive }];
    await mount();
    await fireEventAsync.press(screen.getByRole('button', { name: '返回首页' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '整理范围' }));
    await fireEventAsync.press(await screen.findByRole('radio', { name: '2026 年 10 月' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '按此范围开始整理' }));
    await waitFor(() => expect(screen.queryByTestId('organizing-scope')).toBeNull());
    expect(useMediaStore.getState().videos.map(item => item.id)).toEqual(['one']);
    expect(useMediaStore.getState().organizingSessions.video?.scope.date).toEqual(date);
    expect(useMediaStore.getState().videoProcessedIds).toEqual([]);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    const saved = useMediaStore.getState().organizingSessions.video;
    await fireEventAsync.press(screen.getByRole('button', { name: '返回首页' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '开始新一轮' }));
    expect(await screen.findByRole('radio', { name: '2026 年 10 月', checked: true })).toBeTruthy();
    expect(useMediaStore.getState().organizingSessions.video).toBe(saved);
});

it('keeps forward-swiped video, permits sliding back, and restores exact order/cursor after a screen restart', async () => {
    const view = await mount(); swipe(1);
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['one']);
    expect(useMediaStore.getState().organizingSessions.video?.position).toBe(1);
    swipe(0);
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['one']);
    expect(useMediaStore.getState().organizingSessions.video?.position).toBe(0);
    await view.unmountAsync();
    mockLibrary.reverse(); mockLibrary.push(video('new'));
    useMediaStore.getState().clearLoadedMedia();
    await mount();
    expect(useMediaStore.getState().videos.map(asset => asset.id)).toEqual(['one', 'two', 'three']);
    expect(screen.UNSAFE_getByType(FlatList).props.initialScrollIndex).toBe(0);
    expect(useMediaStore.getState().organizingSessions.video?.position).toBe(0);
    swipe(1);
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['one']);
});

it('does not keep by restoring, partial dragging, returning home, or leaving the tab', async () => {
    useMediaStore.getState().startOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['one', 'two', 'three']);
    useMediaStore.setState({ organizingSessions: { photo: null, video: { ...useMediaStore.getState().organizingSessions.video!, position: 1 } } });
    const view = await mount();
    const list = screen.UNSAFE_getByType(FlatList);
    expect(list.props.initialScrollIndex).toBe(1);
    act(() => {
        list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 600 } } });
        list.props.onScrollBeginDrag();
        list.props.onViewableItemsChanged({ viewableItems: [{ key: 'three' }] });
        list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 600 } } });
    });
    await fireEventAsync.press(screen.getByRole('button', { name: '返回首页' }));
    expect(useMediaStore.getState().videoProcessedIds).toEqual([]);
    await view.unmountAsync();
    expect(useMediaStore.getState().videoProcessedIds).toEqual([]);
});

it('skips without a decision, retains deferrals across next batch and restart, and explicitly revisits them', async () => {
    await mount();
    await fireEventAsync.press(screen.getByRole('button', { name: '暂时跳过' })); visible();
    expect(useMediaStore.getState().videoProcessedIds).toEqual([]);
    expect(useMediaStore.getState().organizingSessions.video?.deferredIds).toEqual(['one']);
    await fireEventAsync.press(screen.getByRole('button', { name: '保留并下一条' })); visible();
    await fireEventAsync.press(screen.getByRole('button', { name: '保留' }));
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['two', 'three']);
    expect(useMediaStore.getState().organizingSessions.video?.phase).toBe('review');
    await fireEventAsync.press(screen.getByRole('button', { name: '查找下一批' }));
    expect(screen.getByText('本轮其余视频已整理完，还有暂时跳过的内容')).toBeTruthy();
    expect(useMediaStore.getState().organizingSessions.video?.deferredIds).toEqual(['one']);
    await fireEventAsync.press(screen.getByRole('button', { name: '处理本轮跳过的 1 项' })); visible();
    expect(useMediaStore.getState().videos.map(asset => asset.id)).toEqual(['one']);
    expect(useMediaStore.getState().videoTrashBin).toEqual([]);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});

it('queues the last video without deleting and leaves kept history available after restart', async () => {
    const view = await mount(); swipe(1); swipe(2);
    await fireEventAsync.press(await screen.findByRole('button', { name: 'queue:three' })); visible();
    expect(useMediaStore.getState().organizingSessions.video?.phase).toBe('review');
    expect(useMediaStore.getState().videoTrashBin.map(asset => asset.id)).toEqual(['three']);
    await view.unmountAsync(); useMediaStore.getState().clearLoadedMedia();
    await mount();
    expect(useMediaStore.getState().videos.map(asset => asset.id)).toEqual(['one', 'two']);
    expect(screen.getByRole('button', { name: '查找下一批' })).toBeTruthy();
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
    swipe(0);
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['one', 'two', 'three']);
});

it('preserves unavailable unreviewed members even when a later readable video is kept', async () => {
    useMediaStore.getState().startOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['one', 'two']);
    mockLibrary = [video('two')];
    await mount();
    await fireEventAsync.press(screen.getByRole('button', { name: '保留' }));
    expect(useMediaStore.getState().organizingSessions.video).toMatchObject({ assetIds: ['one', 'two'], position: 0, phase: 'organizing' });
    expect(screen.getByText('上次整理的部分内容暂时无法访问')).toBeTruthy();
    expect(useMediaStore.getState().finishVideoSession()).toBe(false);
    mockLibrary = [video('one'), video('two')];
    await fireEventAsync.press(screen.getByRole('button', { name: '重新加载' })); visible();
    expect(screen.UNSAFE_getByType(FlatList).props.initialScrollIndex).toBe(0);
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['two']);
});

it('uses saved filters when continuing and uses current settings only for an explicit new round', async () => {
    mockSettings.selectedAlbumIds = ['saved'];
    const view = await mount(); swipe(1);
    await fireEventAsync.press(screen.getByRole('button', { name: '返回首页' }));
    mockSettings.selectedAlbumIds = ['new-scope'];
    await view.rerenderAsync(<VideosScreen />);
    await waitFor(() => expect(screen.getByText('上次范围：1 个相册 · 最旧优先')).toBeTruthy());
    expect(useMediaStore.getState().organizingSessions.video?.scope.albumIds).toEqual(['saved']);
    await fireEventAsync.press(screen.getByRole('button', { name: '开始新一轮' })); visible();
    expect(useMediaStore.getState().organizingSessions.video?.scope.albumIds).toEqual(['new-scope']);
    expect(useMediaStore.getState().videos.map(asset => asset.id)).toEqual(['other']);
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['one']);
});

it('undoes the last kept video and resumes its saved position without unprocessing earlier videos', async () => {
    await mount(); swipe(1); swipe(2);
    await fireEventAsync.press(screen.getByRole('button', { name: '保留' }));
    expect(useMediaStore.getState().organizingSessions.video?.phase).toBe('review');
    await fireEventAsync.press(screen.getByRole('button', { name: '撤销上一步' }));
    await waitFor(() => expect(useMediaStore.getState().isLoading).toBe(false));
    fireEvent(screen.getByTestId('video-feed-viewport'), 'layout', { nativeEvent: { layout: { width: 390, height: 600 } } });
    visible();
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['one', 'two']);
    expect(useMediaStore.getState().organizingSessions.video).toMatchObject({ position: 2, phase: 'organizing' });
    expect(screen.UNSAFE_getByType(FlatList).props.initialScrollIndex).toBe(2);
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();
});
