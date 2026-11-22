import React from 'react';
import { act, cleanup, fireEvent, renderAsync, screen, waitFor } from '@testing-library/react-native';
import * as MediaLibrary from 'expo-media-library';

const mockEnqueueWithReport = jest.fn();
const mockMediaState = {
  permissionScope: 'full',
  mediaLibraryRefreshVersion: 0,
  permissionRefreshVersion: 0,
  lastDeletionResult: null as any,
  removeDeletedAssets: jest.fn(),
  deleteQueue: [] as any[],
  videoTrashBin: [] as any[],
  pendingDeletionInfo: {},
  enqueuePendingDeletion: jest.fn(() => 1),
  enqueuePendingDeletionWithReport: (...args: any[]) => mockEnqueueWithReport(...args),
  photoProcessedIds: [] as string[],
  protectedAlbums: [{ albumId: 'alb-id', title: 'ID Cards', createdAt: 1 }],
  protectedAssetIds: ['blur-protected', 'sim-protected'],
  hasHydrated: true,
  isConfirmingDeletion: false,
  isConfirmingVideoTrash: false,
};

const mockGetSnapshotsBatch = jest.fn();
const mockGetReviewsBatch = jest.fn();
const mockGetSnapshot = jest.fn();
const mockGetReview = jest.fn();
const mockKeepSimilar = jest.fn();
const mockCompleteSimilar = jest.fn();

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' }),
  getAssetInfoAsync: jest.fn(),
  getAssetsAsync: jest.fn(),
  deleteAssetsAsync: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn() }),
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 20, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../hooks/useI18n', () => ({
  useI18n: () => ({
    language: 'zh',
    t: (key: string, params?: Record<string, string | number>) => {
      const zh = require('../i18n/zh').default as Record<string, string>;
      let text = zh[key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) {
        text = text.replace(`{${k}}`, String(v));
      }
      return text;
    },
  }),
}));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => ({ colors: require('../constants/theme').COLORS_DARK, isDark: true }),
}));
jest.mock('../hooks/useAICategories', () => ({
  useAICategories: () => ({
    peopleGroups: [], objectGroups: [], uncategorizedGroup: null,
    isLoading: false, hasError: false, completedCount: 0, refresh: jest.fn(),
  }),
}));
jest.mock('../stores/useSettingsStore', () => ({
  useSettingsStore: () => ({ enableAIClassification: false }),
}));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: Object.assign((selector: any) => selector(mockMediaState), { getState: () => mockMediaState }),
  getCurrentlyVisibleAssetIds: jest.fn(async (ids: string[]) => new Set(ids)),
}));
jest.mock('../database/db', () => ({ getDatabase: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../database', () => ({
  AssetRepository: {
    getBlurryAssets: jest.fn(),
    getStatusCounts: jest.fn().mockResolvedValue({ pending: 0, done: 5, error: 0 }),
    removeAssetAndDerivedData: jest.fn(),
  },
  DupGroupRepository: {
    getGroupsPage: jest.fn().mockResolvedValue([]),
    getGroupMembersBatch: jest.fn().mockResolvedValue(new Map()),
  },
}));
jest.mock('../database/repositories/SimilarReviewRepository', () => ({
  SimilarReviewRepository: {
    getSnapshot: (...args: any[]) => mockGetSnapshot(...args),
    getReview: (...args: any[]) => mockGetReview(...args),
    getSnapshotsBatch: (...args: any[]) => mockGetSnapshotsBatch(...args),
    getReviewsBatch: (...args: any[]) => mockGetReviewsBatch(...args),
  },
  isSimilarReviewCurrent: jest.requireActual('../database/repositories/SimilarReviewRepository').isSimilarReviewCurrent,
}));
jest.mock('../services/similarReview', () => ({
  keepSimilarPhotos: (...args: any[]) => mockKeepSimilar(...args),
  completeSimilarGroup: (...args: any[]) => mockCompleteSimilar(...args),
}));
jest.mock('../services/mediaSizes', () => ({
  readMediaSizes: jest.fn(async () => ({ status: 'unavailable', sizes: new Map() })),
}));
jest.mock('../services/mediaProgressStorage', () => ({
  flushMediaProgress: jest.fn(async () => {}),
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useSharedValue: (value: any) => require('react').useRef({ value }).current,
  useAnimatedStyle: (cb: () => unknown) => cb(),
  withTiming: (value: any, _cfg?: unknown, cb?: (finished: boolean) => void) => { cb?.(true); return value; },
  runOnJS: (cb: unknown) => cb,
  useReducedMotion: () => false,
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children, ...rest }: any) => require('react').createElement(require('react-native').View, rest, children),
  GestureDetector: ({ children }: any) => children,
  Gesture: {
    Pinch: () => { const g: any = { onStart: () => g, onUpdate: () => g, onEnd: () => g }; return g; },
    Pan: () => { const g: any = { minPointers: () => g, maxPointers: () => g, manualActivation: () => g, onTouchesDown: () => g, onTouchesMove: () => g, onStart: () => g, onUpdate: () => g, onEnd: () => g }; return g; },
    Tap: () => { const g: any = { numberOfTaps: () => g, maxDuration: () => g, onEnd: () => g }; return g; },
    Simultaneous: () => ({}),
  },
}));

import ScanResultsScreen from '../app/(tabs)/scanResults';
import { SimilarGroupDetailOverlay } from '../components/SimilarGroupDetailOverlay';
import { AssetRepository, DupGroupRepository } from '../database';
import * as reviewIgnores from '../services/reviewIgnores';

describe('Stage 4 P1 review workflows (Blur zoom/multi-select/ignore & Similar keep-rest/hide)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (reviewIgnores as any).__resetMockReviewIgnores?.();
    mockMediaState.deleteQueue = [];
    mockMediaState.photoProcessedIds = [];
    mockEnqueueWithReport.mockImplementation((assets: any[]) => {
      for (const a of assets) {
        mockMediaState.deleteQueue.push(a);
        mockMediaState.photoProcessedIds.push(a.id);
      }
      return { added: assets.length, alreadyQueued: 0, protectedSkipped: 0, protectedAssetIds: [] };
    });
    mockKeepSimilar.mockImplementation(async (_groupId: string, _key: string, ids: string[]) => {
      mockMediaState.photoProcessedIds = [...new Set([...mockMediaState.photoProcessedIds, ...ids])];
      return 'saved';
    });
    mockGetSnapshotsBatch.mockResolvedValue(new Map());
    mockGetReviewsBatch.mockResolvedValue(new Map());
    mockGetReview.mockResolvedValue(null);
    jest.mocked(MediaLibrary.getAssetInfoAsync).mockImplementation(async (ref: any) => {
      const id = typeof ref === 'string' ? ref : ref.id;
      return {
        id,
        mediaType: 'photo',
        uri: `file:///${id}.jpg`,
        width: 1200,
        height: 900,
        creationTime: 1000,
        ...(id.includes('protected') ? { albumId: 'alb-id' } : {}),
      } as any;
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('supports blur zoomable preview, multi-select batch queue (skipping protected), and persistent ignore filtering', async () => {
    jest.mocked(AssetRepository.getBlurryAssets).mockResolvedValue([
      { asset_id: 'blur-ok', blur_score: 10, mean_luma: 120 },
      { asset_id: 'blur-protected', blur_score: 12, mean_luma: 120 },
      { asset_id: 'blur-ignore-me', blur_score: 15, mean_luma: 120 },
    ]);

    await renderAsync(<ScanResultsScreen />);
    await screen.findByTestId('blurry-protected-badge-blur-protected');

    // Tap blurry card to open ZoomablePhotoModal.
    fireEvent.press(screen.getAllByRole('button', { name: '缩放预览模糊照片' })[0]);
    expect(screen.getByTestId('blur-zoom-preview')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: '关闭' }));

    // Ignore one blurry item directly -> persisted & removed in real time.
    await act(async () => {
      fireEvent.press(screen.getByTestId('blurry-ignore-blur-ignore-me'));
    });
    expect(await reviewIgnores.getIgnoredReviewKeys('blur')).toEqual(new Set(['blur-ignore-me']));
    expect(screen.queryByTestId('blurry-ignore-blur-ignore-me')).toBeNull();

    // Enter multi-select mode, select all remaining (1 normal + 1 protected), batch queue deletion.
    fireEvent.press(screen.getByTestId('blur-multiselect-toggle'));
    fireEvent.press(screen.getByRole('button', { name: '全选' }));
    await act(async () => {
      fireEvent.press(screen.getByTestId('blur-batch-queue-delete'));
    });

    // Only unprotected 'blur-ok' was queued; 'blur-protected' was skipped with explicit feedback!
    expect(mockEnqueueWithReport).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'blur-ok' })],
      'blur',
    );
    expect(screen.getByText(/1 项位于保护相册已自动跳过/)).toBeTruthy();
  });

  it('supports Similar group one-click "keep selected, queue rest" (skipping protected) and "not similar (hide)"', async () => {
    const snapshot = {
      key: 'stable-snapshot-key-1',
      recommendedAssetId: 'sim-keep',
      assets: ['sim-keep', 'sim-del', 'sim-protected'].map(asset_id => ({
        asset_id, width: 1200, height: 900, taken_at: 100, blur_score: 200, mean_luma: 128,
        file_signature: `sig-${asset_id}`, phash: 'abcd',
      })),
    };
    mockGetSnapshot.mockResolvedValue(snapshot);

    const onClose = jest.fn();
    const onComplete = jest.fn();
    const onIgnore = jest.fn();

    await renderAsync(
      <SimilarGroupDetailOverlay
        visible
        groupId="grp-1"
        memberAssetIds={['sim-keep', 'sim-del', 'sim-protected']}
        originRect={null}
        onClose={onClose}
        onComplete={onComplete}
        onIgnore={onIgnore}
      />,
    );

    await screen.findByTestId('similar-protected-badge-sim-protected');

    // Select 'sim-keep' and tap "保留选中，其余全部加入待删".
    const firstPhoto = screen.getByRole('button', { name: '第 1 张照片' });
    fireEvent(firstPhoto, 'longPress');
    await act(async () => {
      fireEvent.press(screen.getByTestId('similar-keep-selected-queue-rest'));
    });

    expect(mockKeepSimilar).toHaveBeenCalledWith('grp-1', 'stable-snapshot-key-1', ['sim-keep'], expect.any(Function));
    expect(mockEnqueueWithReport).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'sim-del' })],
      'similar',
    );
    // Protected photo is NEVER queued, and explicit notice is rendered.
    expect(screen.getByText(/1 张位于保护相册已自动跳过/)).toBeTruthy();

    // Tap "非相似（隐藏此组）" -> persists stable snapshot_key into media_review_ignores.
    await act(async () => {
      fireEvent.press(screen.getByTestId('similar-ignore-group'));
    });
    expect(await reviewIgnores.getIgnoredReviewKeys('similar_group')).toEqual(new Set(['stable-snapshot-key-1']));
    expect(onIgnore).toHaveBeenCalledWith('stable-snapshot-key-1');
  });

  it('filters out groups whose snapshot_key is in media_review_ignores on the Similar tab', async () => {
    await reviewIgnores.addReviewIgnore('similar_group', 'ignored-snap-key');
    jest.mocked(AssetRepository.getBlurryAssets).mockResolvedValue([]);
    jest.mocked(DupGroupRepository.getGroupsPage).mockResolvedValue([
      { group_id: 'grp-hidden', representative_asset_id: 'a1', best_asset_id: 'a1', created_at: 200 },
      { group_id: 'grp-visible', representative_asset_id: 'b1', best_asset_id: 'b1', created_at: 100 },
    ]);
    jest.mocked(DupGroupRepository.getGroupMembersBatch).mockResolvedValue(new Map([
      ['grp-hidden', [{ group_id: 'grp-hidden', asset_id: 'a1', distance: 0 }, { group_id: 'grp-hidden', asset_id: 'a2', distance: 1 }]],
      ['grp-visible', [{ group_id: 'grp-visible', asset_id: 'b1', distance: 0 }, { group_id: 'grp-visible', asset_id: 'b2', distance: 1 }]],
    ]));
    mockGetSnapshotsBatch.mockResolvedValue(new Map([
      ['grp-hidden', { key: 'ignored-snap-key', assets: [{ asset_id: 'a1' }, { asset_id: 'a2' }], recommendedAssetId: 'a1' }],
      ['grp-visible', { key: 'visible-snap-key', assets: [{ asset_id: 'b1' }, { asset_id: 'b2' }], recommendedAssetId: 'b1' }],
    ]));

    await renderAsync(<ScanResultsScreen />);
    await screen.findByText('未发现模糊照片');
    await act(async () => {
      fireEvent.press(screen.getByRole('tab', { name: '相似' }));
    });

    // Only the non-ignored group appears, and tapping its inline "非相似" hides it too.
    const hideButtons = await screen.findAllByRole('button', { name: '非相似（隐藏此组）' });
    expect(hideButtons).toHaveLength(1);

    await act(async () => {
      fireEvent.press(hideButtons[0]);
    });
    expect(await reviewIgnores.getIgnoredReviewKeys('similar_group')).toEqual(
      new Set(['ignored-snap-key', 'visible-snap-key']),
    );
    await waitFor(() => expect(screen.getByText('未发现相似照片组')).toBeTruthy());
  });

  it('P1-6: blurry batch queue awaits flushMediaProgress and rejects without false success when record transfer lock is active', async () => {
    const { acquireRecordOperation } = require('../services/recordOperationLock');
    const { flushMediaProgress } = require('../services/mediaProgressStorage');
    jest.mocked(AssetRepository.getBlurryAssets).mockResolvedValue([
      { asset_id: 'blur-ok-1', blur_score: 12, mean_luma: 120, status: 'done' } as any,
    ]);
    mockEnqueueWithReport.mockReturnValue({
      added: 1, alreadyQueued: 0, protectedSkipped: 0, protectedAssetIds: [],
    });

    await renderAsync(<ScanResultsScreen />);
    await screen.findByTestId('blurry-ignore-blur-ok-1');

    // Enter multi-select and select blur-ok-1.
    fireEvent.press(screen.getByTestId('blur-multiselect-toggle'));
    fireEvent.press(screen.getByRole('button', { name: '全选' }));

    // Hold record transfer lock -> batch queue MUST report failure and keep selection mode open!
    const release = acquireRecordOperation('backup')!;
    try {
      await act(async () => {
        fireEvent.press(screen.getByTestId('blur-batch-queue-delete'));
      });
      expect(mockEnqueueWithReport).not.toHaveBeenCalled();
      expect(screen.getByText(/暂时无法加入，请检查权限或重试/)).toBeTruthy();
      expect(screen.getByTestId('blur-batch-queue-delete')).toBeTruthy();
    } finally {
      release();
    }

    // Release lock -> batch queue succeeds and awaits flushMediaProgress!
    await act(async () => {
      fireEvent.press(screen.getByTestId('blur-batch-queue-delete'));
    });
    expect(mockEnqueueWithReport).toHaveBeenCalledTimes(1);
    expect(flushMediaProgress).toHaveBeenCalled();
  });
});
