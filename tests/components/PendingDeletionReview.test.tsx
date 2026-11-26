import React from 'react';
import { act, fireEvent, fireEventAsync, renderAsync, screen, waitFor, within } from '@testing-library/react-native';
import { Image, Modal, ScrollView, StyleSheet } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

jest.mock('expo-media-library', () => ({
    getPermissionsAsync: jest.fn(), getAssetInfoAsync: jest.fn(), getAssetsAsync: jest.fn(), deleteAssetsAsync: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) }));
jest.mock('../../database', () => ({
    AssetRepository: {
        removeAssetAndDerivedData: jest.fn(async () => {}),
        removeAssetsAndDerivedData: jest.fn(async () => {}),
    },
}));
jest.mock('../../stores/useSettingsStore', () => ({ useSettingsStore: { getState: () => ({ selectedAlbumIds: [] }) } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
let mockInsets = { top: 32, bottom: 24, left: 4, right: 8 };
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ language: 'zh', t: (key: string, params: Record<string, string | number> = {}) => {
    let text = require('../../i18n/zh').default[key] ?? key;
    for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
    return text;
} }) }));
let mockDark = false;
let mockReducedMotion = false;
jest.mock('react-native-reanimated', () => ({ useReducedMotion: () => mockReducedMotion }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({
    colors: require('../../constants/theme')[mockDark ? 'COLORS_DARK' : 'COLORS'], isDark: mockDark,
}) }));

import { PendingDeletionModal, PendingDeletionReview } from '../../components/PendingDeletionReview';
import { useMediaStore } from '../../stores/useMediaStore';
import { AssetRepository } from '../../database';

const photo = (id: string) => ({ id, mediaType: 'photo', uri: `file:///${id}.jpg`, filename: `${id}.jpg`, width: 800, height: 600, creationTime: 1 }) as any;
const video = { ...photo('video'), mediaType: 'video', uri: 'file:///synthetic.mp4', duration: 12 } as any;
const readInfo = MediaLibrary.getAssetInfoAsync as jest.Mock;
const permissions = MediaLibrary.getPermissionsAsync as jest.Mock;
const nativeDelete = MediaLibrary.deleteAssetsAsync as jest.Mock;
afterEach(async () => { await act(async () => {}); });

beforeEach(async () => {
    await act(async () => {
        useMediaStore.setState({
            photos: [], videos: [], deleteQueue: [], collectionQueue: [], videoTrashBin: [],
            photoProcessedIds: [], videoProcessedIds: [], pendingDeletionInfo: {},
            deletedCounts: { photos: 0, videos: 0 }, lastDeletionResult: null,
            isConfirmingDeletion: false, isConfirmingVideoTrash: false, hasHydrated: true,
            permissionScope: 'full', permissionRefreshVersion: 0, mediaLibraryRefreshVersion: 0,
            hiddenPhotoQueuedAssetIds: null, hiddenVideoQueuedAssetIds: null,
        });
    });
    mockDark = false;
    mockReducedMotion = false;
    mockInsets = { top: 32, bottom: 24, left: 4, right: 8 };
    permissions.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    readInfo.mockImplementation(async (id: string) => id === 'video' ? video : photo(id));
    nativeDelete.mockResolvedValue(true);
    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValue({ assets: [], hasNextPage: false, endCursor: '' });
});

async function open(assets = [photo('first'), photo('second'), video], onContinue = jest.fn()) {
    useMediaStore.getState().enqueuePendingDeletion(assets, 'similar');
    const view = await renderAsync(<PendingDeletionReview onContinue={onContinue} />);
    await waitFor(() => expect(screen.getByRole('button', { name: `确认删除当前 ${assets.length} 项` })).toBeEnabled());
    return { view, onContinue };
}

it.each([false, true])('preserves pending decisions and cancellation with reduced motion=%s', async reduced => {
    mockReducedMotion = reduced;
    useMediaStore.getState().enqueuePendingDeletion([photo('first')], 'photos');
    const onClose = jest.fn();
    const view = await renderAsync(<PendingDeletionModal visible onClose={onClose} />);
    const review = view.UNSAFE_getAllByType(Modal).find(modal => modal.props.visible && !modal.props.transparent)!;
    expect(review.props.animationType).toBe(reduced ? 'none' : 'fade');
    act(() => review.props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['first']);
    expect(nativeDelete).not.toHaveBeenCalled();
});

it('shows photo/video/source and keeps media types selectable without deleting on open', async () => {
    await open();
    expect(screen.getByText('3 项待删除')).toBeTruthy();
    expect(screen.getAllByText('图片 · 相似照片')).toHaveLength(2);
    expect(screen.getByText('视频 · 相似照片')).toBeTruthy();
    await fireEventAsync.press(screen.getByRole('radio', { name: '视频' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除当前 1 项' })).toBeEnabled());
    expect(screen.queryByText('图片 · 相似照片')).toBeNull();
    expect(screen.getByText('3 项待删除')).toBeTruthy();
    expect(nativeDelete).not.toHaveBeenCalled();
});

it('does not invent an origin for an older persisted decision', async () => {
    useMediaStore.setState({ deleteQueue: [photo('old')] });
    await renderAsync(<PendingDeletionReview />);
    expect(screen.getByText('图片 · 此前决定')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: '查看第 1 项' })).toBeEnabled());
});

it('keeps just the explicit item organized; previewing and closing change no decision', async () => {
    await open();
    await fireEventAsync.press(screen.getByRole('button', { name: '查看第 1 项' }));
    await waitFor(() => expect(within(screen.getByTestId('photo-preview')).UNSAFE_getByType(Image)).toBeTruthy());
    await fireEventAsync.press(within(screen.getByTestId('photo-preview')).getByRole('button', { name: '关闭' }));
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['first', 'second']);
    await fireEventAsync.press(screen.getByRole('button', { name: '保留第 1 项，保持已整理' }));
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['second']);
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['first', 'second']);
    expect(useMediaStore.getState().videoTrashBin).toEqual([video]);
    expect(nativeDelete).not.toHaveBeenCalled();
});

it('keeping the last item leaves a completion state until explicit continue', async () => {
    const { onContinue } = await open([photo('first')]);
    await fireEventAsync.press(screen.getByRole('button', { name: '保留第 1 项，保持已整理' }));
    expect(screen.getByText('当前列表没有待删除项')).toBeTruthy();
    expect(onContinue).not.toHaveBeenCalled();
    expect(useMediaStore.getState().photoProcessedIds).toEqual(['first']);
    await fireEventAsync.press(screen.getByRole('button', { name: '继续整理' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(nativeDelete).not.toHaveBeenCalled();
});

it('keeps only the filtered type atomically in one store update when keeping all, without discarding other pending media', async () => {
    await open();
    await fireEventAsync.press(screen.getByRole('radio', { name: '图片' }));
    const updates = jest.fn();
    const unsubscribe = useMediaStore.subscribe(updates);
    try {
        await fireEventAsync.press(screen.getByRole('button', { name: '当前列表全部改为保留' }));
        expect(updates).toHaveBeenCalledTimes(1);
    } finally {
        unsubscribe();
    }
    expect(useMediaStore.getState()).toMatchObject({ deleteQueue: [], videoTrashBin: [video], photoProcessedIds: ['first', 'second'] });
    expect(nativeDelete).not.toHaveBeenCalled();
});

it('continues without silently keeping or dropping pending decisions', async () => {
    const { onContinue } = await open();
    await fireEventAsync.press(screen.getByRole('button', { name: '继续整理' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(useMediaStore.getState().deleteQueue).toHaveLength(2);
    expect(useMediaStore.getState().videoTrashBin).toEqual([video]);
});

it('bounds a large restored page and previews/keeps a later item without touching earlier ones', async () => {
    const assets = Array.from({ length: 1001 }, (_, index) => photo(`p${index}`));
    await open(assets);
    expect(screen.getAllByRole('button', { name: /^查看第/ })).toHaveLength(9);
    expect(readInfo).toHaveBeenCalledTimes(9);
    await fireEventAsync.press(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '查看第 10 项' })).toBeEnabled());
    await fireEventAsync.press(screen.getByRole('button', { name: '查看第 10 项' }));
    expect(useMediaStore.getState().deleteQueue).toEqual(assets);
    await fireEventAsync.press(within(screen.getByTestId('photo-preview')).getByRole('button', { name: '关闭' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '保留第 10 项，保持已整理' }));
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).not.toContain('p9');
    expect(useMediaStore.getState().deleteQueue.slice(0, 9)).toEqual(assets.slice(0, 9));
    expect(useMediaStore.getState().photoProcessedIds).toHaveLength(1001);
});

it('clamps the current page when its final item is kept and remains in review', async () => {
    await open(Array.from({ length: 10 }, (_, index) => photo(`p${index}`)));
    await fireEventAsync.press(screen.getByRole('button', { name: '下一页' }));
    await fireEventAsync.press(screen.getByRole('button', { name: '保留第 10 项，保持已整理' }));
    expect(screen.getAllByRole('button', { name: /^查看第/ })).toHaveLength(9);
    expect(screen.getByTestId('pending-deletion-review')).toBeTruthy();
    expect(useMediaStore.getState().photoProcessedIds).toHaveLength(10);
});

it('confirms the whole filtered queue, not only the currently rendered page', async () => {
    await open(Array.from({ length: 19 }, (_, index) => photo(`p${index}`)));
    await fireEventAsync.press(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除当前 19 项' })).toBeEnabled());
    await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 19 项' }));
    await screen.findByText('已确认删除 19 项。');
    expect(nativeDelete.mock.calls[0][0]).toEqual(Array.from({ length: 19 }, (_, index) => `p${index}`));
    expect(AssetRepository.removeAssetsAndDerivedData).toHaveBeenCalledTimes(1);
    expect(AssetRepository.removeAssetsAndDerivedData).toHaveBeenCalledWith(Array.from({ length: 19 }, (_, index) => `p${index}`));
    expect(AssetRepository.removeAssetAndDerivedData).not.toHaveBeenCalled();
    expect(useMediaStore.getState().deletedCounts.photos).toBe(19);
});

it.each(['cancelled', 'failed', 'partial'] as const)('reports %s truthfully and leaves unresolved decisions available', async outcome => {
    permissions.mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    await open();
    if (outcome === 'partial') nativeDelete.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    else if (outcome === 'cancelled') nativeDelete.mockResolvedValue(false);
    else nativeDelete.mockRejectedValue(new Error('Synthetic provider error'));
    await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 3 项' }));
    await screen.findByTestId('pending-result');
    expect(useMediaStore.getState().lastDeletionResult?.status).toBe(outcome);
    expect(screen.getByTestId('pending-result').props.children).toContain(outcome === 'partial' ? '另有 1 项仍待删除' : '3 项仍');
    expect(useMediaStore.getState().videoTrashBin).toEqual([video]);
    expect(useMediaStore.getState().deletedCounts).toEqual({ photos: outcome === 'partial' ? 2 : 0, videos: 0 });
    if (outcome === 'partial') expect(screen.getByTestId('pending-deleted-totals').props.children).toBe('已记录的系统删除：照片 2 张 · 视频 0 个');
    else expect(screen.queryByTestId('pending-deleted-totals')).toBeNull();
});

it('retries a failed confirmation and shows success without prematurely closing the review', async () => {
    permissions.mockResolvedValue({ granted: true, accessPrivileges: 'limited' });
    const { onContinue } = await open([photo('first')]);
    nativeDelete.mockRejectedValueOnce(new Error('Synthetic provider error'));
    await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 1 项' }));
    await screen.findByTestId('pending-result');
    await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 1 项' }));
    await screen.findByText('已确认删除 1 项。');
    expect(onContinue).not.toHaveBeenCalled();
    expect(nativeDelete).toHaveBeenCalledTimes(2);
});

it('preserves the system outcome if a media refresh unmounts and reopens the review', async () => {
    const { view } = await open([photo('first')]);
    let finish!: (value: boolean) => void;
    nativeDelete.mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve; }));
    await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 1 项' }));
    await waitFor(() => expect(nativeDelete).toHaveBeenCalledTimes(1));
    await view.unmountAsync();
    await act(async () => { finish(false); });
    await renderAsync(<PendingDeletionReview />);
    expect(screen.getByTestId('pending-result').props.children).toBe('已取消系统删除，1 项仍保留在待删除列表。');
    expect(useMediaStore.getState().deleteQueue).toHaveLength(1);
    expect(useMediaStore.getState().deletedCounts.photos).toBe(0);
    await fireEventAsync.press(screen.getByRole('button', { name: '保留第 1 项，保持已整理' }));
    expect(screen.queryByTestId('pending-result')).toBeNull();
});

it('retains unavailable decisions with no authorized thumbnail and no false deletion count', async () => {
    readInfo.mockImplementation(async (id: string) => id === 'first' ? photo(id) : null);
    await open([photo('first'), photo('hidden')]);
    expect(screen.getByRole('button', { name: '查看第 2 项' })).toBeDisabled();
    expect(screen.getByText('暂时无法读取')).toBeTruthy();
    await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 2 项' }));
    await screen.findByText('已确认删除 1 项，另有 1 项仍待删除。');
    expect(nativeDelete).toHaveBeenCalledWith(['first']);
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['hidden']);
    expect(useMediaStore.getState().deletedCounts.photos).toBe(1);
});

it('invalidates an open preview and immediately hides old URIs on a permission/library refresh', async () => {
    await open([photo('first')]);
    await fireEventAsync.press(screen.getByRole('button', { name: '查看第 1 项' }));
    permissions.mockResolvedValue({ granted: false, accessPrivileges: 'none' });
    await act(async () => { useMediaStore.getState().notifyPermissionRefresh(); });
    expect(screen.queryByTestId('photo-preview')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: '查看第 1 项' })).toBeDisabled());
    expect(screen.UNSAFE_queryByType(Image)).toBeNull();
    expect(useMediaStore.getState().deleteQueue).toHaveLength(1);
    expect(nativeDelete).not.toHaveBeenCalled();
});

it('disables keep, close and repeated confirmation while a system request is unresolved', async () => {
    useMediaStore.getState().enqueuePendingDeletion([photo('first')], 'photos');
    const close = jest.fn();
    await renderAsync(<PendingDeletionModal visible onClose={close} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除当前 1 项' })).toBeEnabled());
    let resolve!: (value: boolean) => void;
    nativeDelete.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
    await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 1 项' }));
    await waitFor(() => expect(nativeDelete).toHaveBeenCalledTimes(1));
    try {
        expect(screen.getByRole('button', { name: '保留第 1 项，保持已整理' })).toBeDisabled();
        await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 1 项' }));
        await fireEventAsync.press(screen.getByRole('button', { name: '关闭' }));
        const activeModal = screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.visible);
        fireEvent(activeModal!, 'requestClose');
        expect(close).not.toHaveBeenCalled();
        expect(useMediaStore.getState().deleteQueue).toHaveLength(1);
    } finally { await act(async () => { resolve(false); }); }
    expect(nativeDelete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled();
});

it('places final actions outside the grid scroll, follows dark colors and preserves modal safe areas', async () => {
    mockDark = true;
    useMediaStore.getState().enqueuePendingDeletion([photo('first')], 'photos');
    await renderAsync(<PendingDeletionModal visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '查看第 1 项' })).toBeEnabled());
    const modal = screen.UNSAFE_getAllByType(Modal).find(item => item.props.visible)!;
    expect(modal.props).toMatchObject({ statusBarTranslucent: true, navigationBarTranslucent: true });
    const scroll = screen.UNSAFE_getByType(ScrollView);
    expect(scroll.findAll((node: { props: any }) => node.props.testID === 'pending-review-actions')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '确认删除当前 1 项' })).toHaveStyle({ minHeight: 50 });
    expect(StyleSheet.flatten(screen.getByText('删除前复核').props.style).color).toBe('#F1F2EF');
    expect(AssetRepository.removeAssetAndDerivedData).not.toHaveBeenCalled();
});

it('opens a video preview without rendering the video URI as an image or marking it processed again', async () => {
    await open([video]);
    await fireEventAsync.press(screen.getByRole('button', { name: '查看第 1 项' }));
    await act(async () => {});
    expect(screen.UNSAFE_queryByType(Image)).toBeNull();
    expect(useMediaStore.getState().videoTrashBin).toEqual([video]);
    expect(useMediaStore.getState().videoProcessedIds).toEqual(['video']);
    expect(nativeDelete).not.toHaveBeenCalled();
});

it('explains a photo decoder failure and retries without keeping or deleting it', async () => {
    await open([photo('first')]);
    await fireEventAsync.press(screen.getByRole('button', { name: '查看第 1 项' }));
    await waitFor(() => expect(within(screen.getByTestId('photo-preview')).UNSAFE_getByType(Image)).toBeTruthy());
    fireEvent(within(screen.getByTestId('photo-preview')).UNSAFE_getByType(Image), 'error', { nativeEvent: { error: 'Synthetic decoder failure' } });
    expect(within(screen.getByTestId('photo-preview')).getByRole('alert')).toBeTruthy();
    await fireEventAsync.press(within(screen.getByTestId('photo-preview')).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(within(screen.getByTestId('photo-preview')).UNSAFE_getByType(Image)).toBeTruthy());
    expect(useMediaStore.getState().deleteQueue.map(asset => asset.id)).toEqual(['first']);
    expect(nativeDelete).not.toHaveBeenCalled();
});

it('ignores a late failure from the previous preview attempt after a same-URI retry', async () => {
    await open([photo('first')]);
    await fireEventAsync.press(screen.getByRole('button', { name: '查看第 1 项' }));
    await waitFor(() => expect(within(screen.getByTestId('photo-preview')).UNSAFE_getByType(Image)).toBeTruthy());
    const oldFailure = within(screen.getByTestId('photo-preview')).UNSAFE_getByType(Image).props.onError;
    act(() => oldFailure());
    await fireEventAsync.press(within(screen.getByTestId('photo-preview')).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(within(screen.getByTestId('photo-preview')).UNSAFE_getByType(Image)).toBeTruthy());
    act(() => oldFailure());
    expect(within(screen.getByTestId('photo-preview')).queryByRole('alert')).toBeNull();
    expect(useMediaStore.getState().deleteQueue).toHaveLength(1);
});

it('P2: displays dedicated protected status without contradictory unavailable notice when all items are protected', async () => {
    const protectedAlbums = require('../../services/protectedAlbums');
    await protectedAlbums.saveProtectedAlbums([{ albumId: 'alb-vault', title: 'Vault', createdAt: 1 }]);
    const shielded = { ...photo('shielded'), albumId: 'alb-vault' };
    useMediaStore.setState({
        deleteQueue: [shielded],
        photoProcessedIds: ['shielded'],
        protectedAlbums: [{ albumId: 'alb-vault', title: 'Vault', createdAt: 1 }],
        protectedAssetIds: ['shielded'],
    });
    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValue({
        assets: [shielded], hasNextPage: false, endCursor: '', totalCount: 1,
    });
    readInfo.mockResolvedValue(shielded);

    await renderAsync(<PendingDeletionReview />);
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除当前 1 项' })).toBeEnabled());
    await fireEventAsync.press(screen.getByRole('button', { name: '确认删除当前 1 项' }));

    await screen.findByTestId('pending-result');
    expect(useMediaStore.getState().lastDeletionResult?.status).toBe('protected');
    expect(screen.getByTestId('pending-result').props.children).toContain('受保护相册');
    expect(screen.getByTestId('pending-result').props.children).not.toContain('请检查权限或重试');
    expect(screen.queryByTestId('pending-protected-warning')).toBeNull();
    expect(nativeDelete).not.toHaveBeenCalled();
});
