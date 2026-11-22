import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import { create } from 'zustand';

interface DeviceAlbum {
  id: string;
  title: string;
  assetCount: number;
  type: string;
}

interface ProtectedAlbumRecord {
  albumId: string;
  title: string;
  createdAt: number;
}

const deviceAlbums: DeviceAlbum[] = [
  { id: 'camera', title: 'Camera', assetCount: 12, type: 'album' },
  { id: 'travel', title: 'Travel', assetCount: 8, type: 'album' },
];

const mockSettings = {
  groupSize: 10,
  displayOrder: 'random',
  theme: 'light',
  language: 'zh',
  selectedAlbumIds: [] as string[],
  showDevOptions: false,
  enableAIClassification: false,
  hasHydrated: true,
  setGroupSize: jest.fn(),
  setDisplayOrder: jest.fn(),
  setTheme: jest.fn(),
  setLanguage: jest.fn(),
  setSelectedAlbums: jest.fn(),
  setEnableAIClassification: jest.fn(),
  toggleDevOptions: jest.fn(),
  dismissAnnouncement: jest.fn(),
  dismissAIGuide: jest.fn(),
};

const mockScanner = {
  classificationProgress: { pending: 0, done: 0, error: 0 },
  startClassification: jest.fn(),
  progress: { totalPending: 0, totalDone: 0, totalError: 0, currentBatch: 0 },
  isRunning: false,
  isFinalizing: false,
  lastError: null,
  start: jest.fn(),
  stop: jest.fn(),
  resumeOnce: jest.fn(),
  resetScan: jest.fn().mockResolvedValue(undefined),
};

const mockFullAccess = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
const mockLoadAlbumsSpy = jest.fn<Promise<void>, []>();
const mockSetProtectedAlbumsSpy = jest.fn<Promise<void>, [readonly { albumId: string; title: string }[]]>();

interface TestMediaState {
  photoProcessedIds: string[];
  videoProcessedIds: string[];
  resetPhotoProgress: jest.Mock;
  resetVideoProgress: jest.Mock;
  totalPhotos: number;
  totalVideos: number;
  refreshTotalCounts: jest.Mock;
  hasHydrated: boolean;
  getVisibleProcessedCounts: jest.Mock;
  mediaLibraryRefreshVersion: number;
  isConfirmingDeletion: boolean;
  isConfirmingVideoTrash: boolean;
  albums: DeviceAlbum[];
  protectedAlbums: ProtectedAlbumRecord[];
  missingProtectedAlbumIds: string[];
  loadAlbums: () => Promise<void>;
  setProtectedAlbums: (albums: readonly { albumId: string; title: string }[]) => Promise<void>;
}

const mockMediaStore = create<TestMediaState>((set) => ({
  photoProcessedIds: [],
  videoProcessedIds: [],
  resetPhotoProgress: jest.fn(),
  resetVideoProgress: jest.fn(),
  totalPhotos: 0,
  totalVideos: 0,
  refreshTotalCounts: jest.fn().mockResolvedValue(undefined),
  hasHydrated: true,
  getVisibleProcessedCounts: jest.fn().mockResolvedValue({ photos: 0, videos: 0 }),
  mediaLibraryRefreshVersion: 0,
  isConfirmingDeletion: false,
  isConfirmingVideoTrash: false,
  albums: [],
  protectedAlbums: [
    { albumId: 'camera', title: 'Camera', createdAt: 1 },
    { albumId: 'deleted-vault', title: 'Deleted Vault', createdAt: 2 },
  ],
  missingProtectedAlbumIds: ['deleted-vault'],
  loadAlbums: async () => {
    await mockLoadAlbumsSpy();
    // Always write a brand new array reference, mirroring MediaLibrary.getAlbumsAsync.
    set({ albums: deviceAlbums.map(album => ({ ...album })) });
  },
  setProtectedAlbums: async (next) => {
    await mockSetProtectedAlbumsSpy(next);
    const availableIds = new Set(deviceAlbums.map(album => album.id));
    set({
      protectedAlbums: next.map((item, idx) => ({
        albumId: item.albumId,
        title: item.title,
        createdAt: idx + 10,
      })),
      missingProtectedAlbumIds: next
        .filter(item => !availableIds.has(item.albumId))
        .map(item => item.albumId),
    });
  },
}));

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null, Ionicons: () => null }));
jest.mock('../components/ScanBatchModal', () => ({ ScanBatchModal: () => null }));
jest.mock('../hooks/useAIScanner', () => ({ useAIScanner: () => mockScanner }));
jest.mock('../stores/useSettingsStore', () => ({
  APP_VERSION: 'v0.4.0',
  useSettingsStore: Object.assign(() => mockSettings, { getState: () => mockSettings }),
}));
jest.mock('../stores/useMediaStore', () => ({
  useMediaStore: (selector?: (state: TestMediaState) => unknown) =>
    selector ? mockMediaStore(selector) : mockMediaStore(),
  hasFullPhotoLibraryAccess: () => mockFullAccess(),
}));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => ({
    colors: require('../constants/theme').COLORS,
    isDark: false,
  }),
}));
jest.mock('../hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = require('../i18n/zh').default;
      const template = messages[key] ?? key;
      return Object.entries(params ?? {}).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)),
        template,
      );
    },
  }),
}));

import SettingsScreen from '../app/(tabs)/settings';
import zh from '../i18n/zh';

beforeEach(() => {
  jest.clearAllMocks();
  mockFullAccess.mockResolvedValue(true);
  mockLoadAlbumsSpy.mockResolvedValue(undefined);
  mockSetProtectedAlbumsSpy.mockResolvedValue(undefined);
  mockMediaStore.setState({
    albums: [],
    mediaLibraryRefreshVersion: 0,
    protectedAlbums: [
      { albumId: 'camera', title: 'Camera', createdAt: 1 },
      { albumId: 'deleted-vault', title: 'Deleted Vault', createdAt: 2 },
    ],
    missingProtectedAlbumIds: ['deleted-vault'],
  });
  jest.spyOn(BackHandler, 'addEventListener').mockReturnValue({ remove: jest.fn() });
});

it('loads albums once without wiping checkbox or unavailable-item edits when SettingsScreen re-renders with new album references', async () => {
  render(<SettingsScreen />);
  await waitFor(() =>
    expect(mockMediaStore.getState().getVisibleProcessedCounts).toHaveBeenCalled(),
  );
  expect(screen.getByTestId('protected-albums-missing-warning')).toBeTruthy();

  // Open the real AlbumSelector from SettingsScreen.
  fireEvent.press(
    screen.getByRole('button', { name: new RegExp(zh.settings_protected_albums) }),
  );

  // Wait for albums and unavailable protected album row to render.
  const travelRow = await screen.findByRole('checkbox', { name: 'Travel' });
  expect(screen.getByRole('checkbox', { name: 'Camera', checked: true })).toBeTruthy();
  expect(travelRow.props.accessibilityState.checked).toBe(false);
  const unavailableRow = screen.getByTestId('album-unavailable-deleted-vault');

  // Flush queued microtasks to prove loadAlbums does not re-trigger in a loop.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mockLoadAlbumsSpy).toHaveBeenCalledTimes(1);
  expect(mockFullAccess).toHaveBeenCalledTimes(1);

  // Edit the draft: check Travel and remove the unavailable deleted album.
  fireEvent.press(travelRow);
  fireEvent.press(unavailableRow);

  expect(screen.getByRole('checkbox', { name: 'Travel', checked: true })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Camera', checked: true })).toBeTruthy();
  expect(screen.queryByTestId('album-unavailable-deleted-vault')).toBeNull();

  // Simulate another store update writing a fresh albums array reference while open.
  await act(async () => {
    mockMediaStore.setState(state => ({
      albums: deviceAlbums.map(album => ({ ...album })),
      mediaLibraryRefreshVersion: state.mediaLibraryRefreshVersion + 1,
    }));
    await Promise.resolve();
  });

  // Draft edits must survive parent re-renders and loadAlbums must not fire again.
  expect(mockLoadAlbumsSpy).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('checkbox', { name: 'Travel', checked: true })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Camera', checked: true })).toBeTruthy();
  expect(screen.queryByTestId('album-unavailable-deleted-vault')).toBeNull();

  // Confirm persists the edited selection and closes the modal.
  fireEvent.press(screen.getByRole('button', { name: zh.confirm }));
  await waitFor(() =>
    expect(mockSetProtectedAlbumsSpy).toHaveBeenCalledWith([
      { albumId: 'camera', title: 'Camera' },
      { albumId: 'travel', title: 'Travel' },
    ]),
  );
  expect(screen.queryByTestId('protected-albums-missing-warning')).toBeNull();

  // Re-opening after close loads albums once more and reflects the latest selection.
  fireEvent.press(
    screen.getByRole('button', { name: new RegExp(zh.settings_protected_albums) }),
  );
  await waitFor(() => expect(mockLoadAlbumsSpy).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole('checkbox', { name: 'Camera', checked: true })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Travel', checked: true })).toBeTruthy();
  expect(screen.queryByTestId('album-unavailable-deleted-vault')).toBeNull();
});
