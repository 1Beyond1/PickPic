jest.unmock('../../services/privacy/encryptedStorage');

import React from 'react';
import { act, fireEvent, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockAsyncStorageMap = new Map<string, string>();
const mockSecureStoreMap = new Map<string, string>();

const mockCloseDatabase = jest.fn().mockResolvedValue(undefined);
const mockGetDatabase = jest.fn().mockResolvedValue({});
const mockResetDbFiles = jest.fn().mockResolvedValue(undefined);
const mockRouter = { replace: jest.fn() };
const mockPermissionState = { granted: true, accessPrivileges: 'all' };

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockAsyncStorageMap.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockAsyncStorageMap.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockAsyncStorageMap.delete(key); }),
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
  getItemAsync: jest.fn(async (key: string) => mockSecureStoreMap.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecureStoreMap.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecureStoreMap.delete(key); }),
}));
jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(async (size: number) => new Uint8Array(require('node:crypto').randomBytes(size))),
}));
jest.mock('react-native-quick-base64', () => ({
  fromByteArray: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  toByteArray: (encoded: string) => new Uint8Array(Buffer.from(encoded, 'base64')),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 16, bottom: 16, left: 0, right: 0 }),
}));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn().mockResolvedValue(undefined),
  hideAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/',
  Stack: Object.assign(
    ({ children }: { children: React.ReactNode }) => {
      const ReactModule = require('react');
      const { View, Text } = require('react-native');
      return ReactModule.createElement(
        View,
        { testID: 'main-app-stack' },
        ReactModule.createElement(Text, null, 'MAIN_APP_MOUNTED'),
        children,
      );
    },
    { Screen: () => null },
  ),
}));
jest.mock('../../components/AIScanGuideModal', () => ({ AIScanGuideModal: () => null }));
jest.mock('../../components/AnnouncementModal', () => ({ AnnouncementModal: () => null }));
jest.mock('../../components/MLBridge', () => ({ MLBridge: () => null }));
jest.mock('../../services/modalAppearance', () => ({ syncModalAppearance: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../hooks/useI18n', () => ({
  useI18n: () => ({
    language: 'zh',
    t: (key: string, params?: Record<string, string | number>) => {
      const zh = require('../../i18n/zh').default as Record<string, string>;
      let text = zh[key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) {
        text = text.replace(`{${k}}`, String(v));
      }
      return text;
    },
  }),
}));
jest.mock('../../hooks/useThemeColor', () => ({
  useThemeColor: () => ({ colors: require('../../constants/theme').COLORS, isDark: false }),
}));
jest.mock('../../services/scanner', () => ({
  isScanning: () => false,
  start: jest.fn(),
  stop: jest.fn(),
}));
jest.mock('../../stores/useScannerStore', () => ({
  useScannerStore: { getState: () => ({ setLastError: jest.fn() }) },
}));
jest.mock('../../services/privacy/mediaCache', () => ({
  clearLegacyMediaCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../database', () => ({
  AssetRepository: { removeAssetsAndDerivedData: jest.fn().mockResolvedValue(undefined) },
  closeDatabase: (...args: unknown[]) => mockCloseDatabase(...args),
  getDatabase: (...args: unknown[]) => mockGetDatabase(...args),
}));
jest.mock('../../database/db', () => ({
  closeDatabase: (...args: unknown[]) => mockCloseDatabase(...args),
  getDatabase: (...args: unknown[]) => mockGetDatabase(...args),
}));
jest.mock('../../database/encryptedDatabase', () => ({
  resetEncryptedDatabaseFiles: (...args: unknown[]) => mockResetDbFiles(...args),
}));
jest.mock('expo-media-library', () => ({
  MediaType: { photo: 'photo', video: 'video' },
  usePermissions: () => [mockPermissionState, jest.fn(), jest.fn().mockResolvedValue(mockPermissionState)],
  addListener: () => ({ remove: jest.fn() }),
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' }),
  getAlbumsAsync: jest.fn().mockResolvedValue([]),
  getAssetsAsync: jest.fn().mockResolvedValue({ assets: [], totalCount: 0, hasNextPage: false, endCursor: '' }),
}));

import RootLayout from '../../app/_layout';
import { flushMediaProgress } from '../../services/mediaProgressStorage';
import { canWriteEncryptedStorage } from '../../services/privacy/encryptedStorage';
import { resetLocalPrivacyIndex } from '../../services/privacy/recovery';
import { flushSettings } from '../../services/privacy/settingsStorage';
import { useMediaStore } from '../../stores/useMediaStore';
import { usePrivacyStore } from '../../stores/usePrivacyStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

describe('Real encryptedStorage resetLocalPrivacyIndex failure + Retry regression (P1-1)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockAsyncStorageMap.clear();
    mockSecureStoreMap.clear();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    usePrivacyStore.getState().clearAll();
    mockCloseDatabase.mockResolvedValue(undefined);
    mockGetDatabase.mockImplementation(async () => {
      usePrivacyStore.getState().clear('scanner');
      return {};
    });
    mockResetDbFiles.mockResolvedValue(undefined);

    await useSettingsStore.persist.rehydrate();
    await useMediaStore.persist.rehydrate();
    expect(useSettingsStore.getState().hasHydrated).toBe(true);
    expect(useMediaStore.getState().hasHydrated).toBe(true);
    expect(canWriteEncryptedStorage('settings', 'photoapp-settings')).toBe(true);
    expect(canWriteEncryptedStorage('records', 'photoapp-media-progress')).toBe(true);
  });

  it('Path A: scanner-only failure -> reset throws during wipe -> Retry rehydrates and restores encrypted writes', async () => {
    // Only scanner is blocked initially; settings & records are healthy and hydrated.
    usePrivacyStore.getState().block('scanner', 'read', 'schema_corrupt');
    mockResetDbFiles.mockRejectedValueOnce(new Error('SQLCipher unlink I/O error'));

    await expect(resetLocalPrivacyIndex()).rejects.toThrow('SQLCipher unlink I/O error');

    // Write gates were disabled, so BOTH stores MUST now be unhydrated and read-blocked.
    expect(canWriteEncryptedStorage('settings', 'photoapp-settings')).toBe(false);
    expect(canWriteEncryptedStorage('records', 'photoapp-media-progress')).toBe(false);
    expect(useSettingsStore.getState().hasHydrated).toBe(false);
    expect(useMediaStore.getState().hasHydrated).toBe(false);
    expect(usePrivacyStore.getState().failures.settings).toBe('read');
    expect(usePrivacyStore.getState().failures.records).toBe('read');

    await renderAsync(<RootLayout />);
    expect(screen.queryByTestId('main-app-stack')).toBeNull();
    const retryButton = screen.getByTestId('privacy-retry-btn');

    await act(async () => {
      fireEvent.press(retryButton);
    });

    await waitFor(() => expect(screen.getByTestId('main-app-stack')).toBeTruthy());
    expect(useSettingsStore.getState().hasHydrated).toBe(true);
    expect(useMediaStore.getState().hasHydrated).toBe(true);
    expect(canWriteEncryptedStorage('settings', 'photoapp-settings')).toBe(true);
    expect(canWriteEncryptedStorage('records', 'photoapp-media-progress')).toBe(true);

    // Verify subsequent writes ACTUALLY persist authenticated AES-256-GCM ciphertext (no silent drop!).
    await act(async () => {
      useSettingsStore.getState().setTheme('dark');
      useMediaStore.getState().addIgnoredSimilarGroupKeys(['sgc1:persisted-after-retry']);
      await flushSettings();
      await flushMediaProgress();
    });

    expect(mockAsyncStorageMap.get('photoapp-settings.encrypted-v1')).toMatch(/^PKLOCAL1:/);
    expect(mockAsyncStorageMap.get('photoapp-media-progress.encrypted-v1')).toMatch(/^PKLOCAL1:/);
  });

  it('Path B: reset clears failures then getDatabase() throws -> shows actionable recovery UI (not spinner) and Retry recovers fully', async () => {
    usePrivacyStore.getState().block('scanner', 'read', 'cipher_decrypt_failed');
    mockGetDatabase.mockImplementationOnce(async () => {
      usePrivacyStore.getState().block('scanner', 'read', 'storage_io');
      throw new Error('Transient DB open failure');
    });

    await expect(resetLocalPrivacyIndex()).rejects.toThrow('Transient DB open failure');

    // Both stores remain read-blocked & unhydrated so Retry can never deadlock into an empty spinner.
    expect(useSettingsStore.getState().hasHydrated).toBe(false);
    expect(useMediaStore.getState().hasHydrated).toBe(false);
    expect(usePrivacyStore.getState().failures.settings).toBe('read');
    expect(usePrivacyStore.getState().failures.records).toBe('read');

    await renderAsync(<RootLayout />);
    expect(screen.queryByTestId('main-app-stack')).toBeNull();
    const retryButton = screen.getByTestId('privacy-retry-btn');

    await act(async () => {
      fireEvent.press(retryButton);
    });

    await waitFor(() => expect(screen.getByTestId('main-app-stack')).toBeTruthy());
    expect(useSettingsStore.getState().hasHydrated).toBe(true);
    expect(useMediaStore.getState().hasHydrated).toBe(true);
    expect(canWriteEncryptedStorage('settings', 'photoapp-settings')).toBe(true);
    expect(canWriteEncryptedStorage('records', 'photoapp-media-progress')).toBe(true);

    await act(async () => {
      useSettingsStore.getState().setLanguage('en');
      await flushSettings();
    });
    expect(mockAsyncStorageMap.get('photoapp-settings.encrypted-v1')).toMatch(/^PKLOCAL1:/);
  });
});
