import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, TextInput } from 'react-native';

const mockCloseDatabase = jest.fn().mockResolvedValue(undefined);
const mockGetDatabase = jest.fn().mockResolvedValue({});
const mockResetDbFiles = jest.fn().mockResolvedValue(undefined);
const mockDeleteDeviceKey = jest.fn().mockResolvedValue(undefined);
const mockProbeDeviceKeystore = jest.fn().mockResolvedValue(undefined);
const mockPickEncryptedFile = jest.fn();
const mockDecryptBackup = jest.fn();

const mockPhoto = {
  id: 'photo-restored-1',
  filename: 'IMG_RESTORED.jpg',
  uri: 'file:///IMG_RESTORED.jpg',
  mediaType: 'photo' as const,
  width: 1600,
  height: 1200,
  creationTime: 1700000000000,
  modificationTime: 1700000000000,
  duration: 0,
};

const mockRouter = { replace: jest.fn() };
const mockPermissionState = { granted: true, accessPrivileges: 'all' };
const mockRequestPermission = jest.fn();
const mockGetPermission = jest.fn().mockResolvedValue(mockPermissionState);

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
jest.mock('../../services/privacy/deviceKey', () => ({
  deleteDeviceKey: (...args: unknown[]) => mockDeleteDeviceKey(...args),
  probeDeviceKeystore: (...args: unknown[]) => mockProbeDeviceKeystore(...args),
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
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-media-library', () => ({
  usePermissions: () => [
    mockPermissionState,
    mockRequestPermission,
    mockGetPermission,
  ],
  addListener: () => ({ remove: jest.fn() }),
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, accessPrivileges: 'all' }),
  getAlbumsAsync: jest.fn().mockResolvedValue([{ id: 'alb-docs', title: 'Docs', assetCount: 1 }]),
  getAssetsAsync: jest.fn(),
  deleteAssetsAsync: jest.fn(),
}));
jest.mock('../../services/backup/files', () => ({
  pickEncryptedFile: (...args: unknown[]) => mockPickEncryptedFile(...args),
}));
jest.mock('../../services/backup/crypto', () => {
  const actual = jest.requireActual('../../services/backup/crypto');
  return {
    ...actual,
    decryptBackup: (...args: unknown[]) => mockDecryptBackup(...args),
  };
});

import * as MediaLibrary from 'expo-media-library';
import RootLayout from '../../app/_layout';
import { buildContentFingerprint, mediaFingerprint, type BackupPayloadV2 } from '../../services/backup/payload';
import * as protectedAlbumsService from '../../services/protectedAlbums';
import * as reviewIgnoresService from '../../services/reviewIgnores';
import { useMediaStore } from '../../stores/useMediaStore';
import { usePrivacyStore } from '../../stores/usePrivacyStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

describe('RootLayout + PrivacyRecoveryScreen + recovery.ts real integration (P0-1 regression)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    (protectedAlbumsService as any).__resetMockProtectedAlbums?.();
    (reviewIgnoresService as any).__resetMockReviewIgnores?.();

    usePrivacyStore.setState({ failures: {}, reasons: {}, recoveryDepth: 0, recovering: false });
    useSettingsStore.setState({ hasHydrated: true });
    useMediaStore.setState({
      hasHydrated: true,
      photoProcessedIds: [],
      videoProcessedIds: [],
      deleteQueue: [],
      collectionQueue: [],
      videoTrashBin: [],
      pendingDeletionInfo: {},
      protectedAlbums: [],
      protectedAssetIds: [],
      recentDecisions: [],
      isConfirmingDeletion: false,
      isConfirmingVideoTrash: false,
    });

    // Simulate real asynchronous asset enumeration delay during restoreEncryptedRecords
    // so any premature RootLayout gate flip would unmount PrivacyRecoveryScreen mid-flight.
    jest.mocked(MediaLibrary.getAssetsAsync).mockImplementation(async (options?: any) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (options?.album === 'alb-docs') {
        return { assets: [], hasNextPage: false, endCursor: '', totalCount: 0 } as any;
      }
      return {
        assets: [mockPhoto],
        hasNextPage: false,
        endCursor: '',
        totalCount: 1,
      } as any;
    });
  });

  it('keeps PrivacyRecoveryScreen mounted through reset + restoreEncryptedRecords without suicide cancellation, restores all v2 data, shows summary, then enters main app', async () => {
    // 1. Block privacy gate with a real SQLCipher decryption failure (no mock of usePrivacyStore).
    usePrivacyStore.getState().block('scanner', 'read', 'cipher_decrypt_failed');

    const v2Payload: BackupPayloadV2 = {
      version: 2,
      platform: 'android',
      records: [
        {
          id: mockPhoto.id,
          kind: 'photo',
          decision: 'keep',
          fingerprint: mediaFingerprint(mockPhoto as MediaLibrary.Asset),
          contentFingerprint: buildContentFingerprint(mockPhoto as MediaLibrary.Asset, null),
        },
      ],
      protectedAlbums: [{ albumId: 'alb-docs', title: 'Docs', createdAt: 100 }],
      reviewIgnores: [{ ignoreType: 'similar_group', targetKey: 'snap-e2e-1', createdAt: 200 }],
    };

    mockPickEncryptedFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    mockDecryptBackup.mockResolvedValue(v2Payload);

    render(<RootLayout />);

    // Gate must show PrivacyRecoveryScreen, NOT main app.
    await waitFor(() => expect(screen.getByTestId('privacy-wizard-open-import')).toBeTruthy());
    expect(screen.queryByTestId('main-app-stack')).toBeNull();

    // 2. Open import wizard, select file, decrypt & verify payload.
    fireEvent.press(screen.getByTestId('privacy-wizard-open-import'));
    fireEvent.press(screen.getByTestId('privacy-import-choose-file'));
    await waitFor(() => expect(screen.getByLabelText('备份密码')).toBeTruthy());

    fireEvent.changeText(screen.UNSAFE_getByType(TextInput), 'valid-recovery-passphrase-2026');
    fireEvent.press(screen.getByTestId('privacy-import-decrypt-btn'));
    await waitFor(() => expect(screen.getByTestId('privacy-import-verified-summary')).toBeTruthy());

    // 3. Confirm self-rescue restore: MUST NOT unmount mid-restore or throw BackupError('cancelled').
    fireEvent.press(screen.getByTestId('privacy-import-confirm-btn'));

    // Restore summary must appear while PrivacyRecoveryScreen is still mounted!
    await waitFor(() => expect(screen.getByTestId('privacy-import-restore-result')).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByTestId('main-app-stack')).toBeNull();
    expect(usePrivacyStore.getState().failures).toEqual({});
    expect(usePrivacyStore.getState().recovering).toBe(true);

    // Verify all v2 records, protected albums, and review ignores were genuinely restored!
    expect(useMediaStore.getState().photoProcessedIds).toEqual([mockPhoto.id]);
    expect(await protectedAlbumsService.loadProtectedAlbums()).toEqual([
      { albumId: 'alb-docs', title: 'Docs', createdAt: 100 },
    ]);
    expect(await reviewIgnoresService.getIgnoredReviewKeys('similar_group')).toEqual(new Set(['snap-e2e-1']));
    expect(MediaLibrary.deleteAssetsAsync).not.toHaveBeenCalled();

    // 4. User taps "进入应用" -> releases UI recovery lock -> RootLayout mounts main app stack!
    await act(async () => {
      fireEvent.press(screen.getByTestId('privacy-import-finish-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('main-app-stack')).toBeTruthy());
    expect(usePrivacyStore.getState().recovering).toBe(false);
    expect(usePrivacyStore.getState().recoveryDepth).toBe(0);
  });
});
