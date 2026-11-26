import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking, Platform, Switch, TextInput } from 'react-native';

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 16, bottom: 16, left: 0, right: 0 }),
}));
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
jest.mock('../../services/backup/files', () => ({ pickEncryptedFile: jest.fn() }));
jest.mock('../../services/backup/records', () => ({ decryptAndParseBackup: jest.fn() }));

import * as MediaLibrary from 'expo-media-library';
import { PrivacyRecoveryScreen } from '../../components/PrivacyRecoveryScreen';
import { pickEncryptedFile } from '../../services/backup/files';
import { decryptAndParseBackup } from '../../services/backup/records';
import { BackupError } from '../../services/backup/crypto';

describe('PrivacyRecoveryScreen actionable self-rescue wizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  });

  it.each([
    ['keystore_unavailable', 'Keystore', /系统密钥库（Keystore）暂时不可用/],
    ['cipher_decrypt_failed', 'SQLCipher', /本地密库（SQLCipher）解密失败/],
    ['schema_corrupt', 'Schema', /本地隐私索引结构（Schema）异常/],
  ] as const)('accurately renders domain-specific diagnostics for %s', (domain, badge, titleRegex) => {
    render(
      <PrivacyRecoveryScreen
        failure="read"
        failureDomain={domain}
        busy={false}
        onRetry={jest.fn()}
        onResetLocalIndex={jest.fn().mockResolvedValue(undefined)}
        onRecoverFromBackup={jest.fn().mockResolvedValue({} as any)}
      />,
    );

    expect(screen.getByTestId('privacy-failure-domain-badge')).toBeTruthy();
    expect(screen.getByText(badge)).toBeTruthy();
    expect(screen.getByText(titleRegex)).toBeTruthy();
  });

  it('verifies .pickpic backup before triggering recovery and erases encrypted bytes after decryption', async () => {
    const encryptedBytes = new Uint8Array([9, 8, 7, 6]);
    const v2Payload = {
      version: 2 as const,
      platform: 'android' as const,
      records: [],
      protectedAlbums: [{ albumId: 'alb-1', title: 'Docs', createdAt: 1 }],
      reviewIgnores: [],
    };
    const onRecoverFromBackup = jest.fn().mockResolvedValue({
      kept: 1, collected: 0, pendingDeletion: 0, skipped: 0, existing: 0,
      rebound: 0, ambiguousSkipped: 0, protectedAlbums: 1, reviewIgnores: 0,
    });
    const onResetLocalIndex = jest.fn();

    jest.mocked(pickEncryptedFile).mockResolvedValue(encryptedBytes);
    jest.mocked(decryptAndParseBackup)
      .mockRejectedValueOnce(new BackupError('invalid'))
      .mockResolvedValueOnce(v2Payload);

    render(
      <PrivacyRecoveryScreen
        failure="read"
        failureDomain="cipher_decrypt_failed"
        busy={false}
        onRetry={jest.fn()}
        onResetLocalIndex={onResetLocalIndex}
        onRecoverFromBackup={onRecoverFromBackup}
      />,
    );

    fireEvent.press(screen.getByTestId('privacy-wizard-open-import'));
    fireEvent.press(screen.getByTestId('privacy-import-choose-file'));
    await waitFor(() => expect(screen.getByLabelText('备份密码')).toBeTruthy());

    // Wrong password shows error and does NOT wipe or reset anything.
    const input = screen.UNSAFE_getByType(TextInput);
    expect(input.props.secureTextEntry).toBe(true);
    fireEvent.changeText(input, 'wrong-passphrase-123');
    fireEvent.press(screen.getByTestId('privacy-import-decrypt-btn'));
    await waitFor(() => expect(screen.getByText(/密码不正确/)).toBeTruthy());
    expect(onRecoverFromBackup).not.toHaveBeenCalled();
    expect(onResetLocalIndex).not.toHaveBeenCalled();

    // Correct password decrypts, zeroizes ciphertext buffer, shows summary, and leaves pending unchecked.
    fireEvent.changeText(screen.getByLabelText('备份密码'), 'correct-long-passphrase');
    fireEvent.press(screen.getByTestId('privacy-import-decrypt-btn'));
    await waitFor(() => expect(screen.getByTestId('privacy-import-verified-summary')).toBeTruthy());
    expect([...encryptedBytes]).toEqual([0, 0, 0, 0]);
    expect(screen.UNSAFE_getByType(Switch).props.value).toBe(false);
    expect(onRecoverFromBackup).not.toHaveBeenCalled();

    // Explicit confirmation invokes recovery callback and presents restore summary before closing.
    fireEvent.press(screen.getByTestId('privacy-import-confirm-btn'));
    await waitFor(() => expect(onRecoverFromBackup).toHaveBeenCalledWith(v2Payload, false, expect.any(Function)));
    await waitFor(() => expect(screen.getByTestId('privacy-import-restore-result')).toBeTruthy());
    fireEvent.press(screen.getByTestId('privacy-import-finish-btn'));
    await waitFor(() => expect(screen.queryByTestId('privacy-import-restore-result')).toBeNull());
  });

  it('prevents closing the reset sheet via backdrop while working is true', async () => {
    let resolveReset!: () => void;
    const onResetLocalIndex = jest.fn(() => new Promise<void>(resolve => { resolveReset = resolve; }));
    render(
      <PrivacyRecoveryScreen
        failure="read"
        failureDomain="schema_corrupt"
        busy={false}
        onRetry={jest.fn()}
        onResetLocalIndex={onResetLocalIndex}
      />,
    );

    fireEvent.press(screen.getByTestId('privacy-wizard-open-reset'));
    fireEvent.press(screen.getByTestId('privacy-wizard-reset-ack'));
    fireEvent.press(screen.getByTestId('privacy-wizard-reset-confirm'));
    await waitFor(() => expect(onResetLocalIndex).toHaveBeenCalledTimes(1));

    // Backdrop must not be a dismissible Pressable while working.
    const backdrop = screen.getByTestId('sheet-backdrop', { includeHiddenElements: true });
    expect(backdrop.props.onPress).toBeUndefined();

    await act(async () => {
      resolveReset();
    });
    await waitFor(() => expect(screen.queryByTestId('privacy-wizard-reset-confirm')).toBeNull());
  });

  it('requires explicit secondary checkbox acknowledgment before resetting local privacy index', async () => {
    const onResetLocalIndex = jest.fn().mockResolvedValue(undefined);
    render(
      <PrivacyRecoveryScreen
        failure="read"
        failureDomain="schema_corrupt"
        busy={false}
        onRetry={jest.fn()}
        onResetLocalIndex={onResetLocalIndex}
      />,
    );

    fireEvent.press(screen.getByTestId('privacy-wizard-open-reset'));
    const confirmBtn = screen.getByTestId('privacy-wizard-reset-confirm');
    expect(confirmBtn).toBeDisabled();

    // Pressing disabled confirm button does nothing.
    fireEvent.press(confirmBtn);
    expect(onResetLocalIndex).not.toHaveBeenCalled();

    // Checking explicit acknowledgment enables final confirmation.
    fireEvent.press(screen.getByTestId('privacy-wizard-reset-ack'));
    expect(screen.getByTestId('privacy-wizard-reset-confirm')).toBeEnabled();

    fireEvent.press(screen.getByTestId('privacy-wizard-reset-confirm'));
    await waitFor(() => expect(onResetLocalIndex).toHaveBeenCalledTimes(1));
  });

  it('P1-3: distinguishes unreadable backup file errors from missing media permissions without falsely blaming album permissions', async () => {
    jest.mocked(pickEncryptedFile).mockRejectedValueOnce(new BackupError('unavailable'));

    render(
      <PrivacyRecoveryScreen
        failure="read"
        failureDomain="cipher_decrypt_failed"
        busy={false}
        onRetry={jest.fn()}
        onRecoverFromBackup={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByTestId('privacy-wizard-open-import'));
    fireEvent.press(screen.getByTestId('privacy-import-choose-file'));

    await waitFor(() => expect(screen.getByText(/暂时无法读取所选备份文件/)).toBeTruthy());
    expect(screen.queryByText(/未获得所需的照片或视频访问权限/)).toBeNull();
    expect(screen.queryByTestId('privacy-import-grant-permission-btn')).toBeNull();
  });

  it('P1-3: breaks Android 13+ video permission deadlock by offering in-wizard photo+video grant and system settings fallback', async () => {
    const encryptedBytes = new Uint8Array([1, 2, 3, 4]);
    const mixedPayload = {
      version: 2 as const,
      platform: 'android' as const,
      records: [
        {
          id: 'v1',
          kind: 'video' as const,
          decision: 'keep' as const,
          fingerprint: 'd'.repeat(64),
          contentFingerprint: { signature: 'e'.repeat(64), baseSignature: 'f'.repeat(64), creationTime: 2, hasFileSize: false },
        },
      ],
      protectedAlbums: [],
      reviewIgnores: [],
    };
    const onRecoverFromBackup = jest.fn()
      .mockRejectedValueOnce(new BackupError('permission'))
      .mockResolvedValueOnce({
        kept: 1, collected: 0, pendingDeletion: 0, skipped: 0, existing: 0,
        rebound: 0, ambiguousSkipped: 0, protectedAlbums: 0, reviewIgnores: 0,
      });

    jest.mocked(pickEncryptedFile).mockResolvedValueOnce(encryptedBytes);
    jest.mocked(decryptAndParseBackup).mockResolvedValueOnce(mixedPayload);
    jest.mocked(MediaLibrary.requestPermissionsAsync)
      .mockResolvedValueOnce({ granted: false, canAskAgain: false, accessPrivileges: 'none' } as any)
      .mockResolvedValueOnce({ granted: true, canAskAgain: true, accessPrivileges: 'all' } as any);
    jest.mocked(MediaLibrary.getPermissionsAsync)
      .mockResolvedValueOnce({ granted: false, accessPrivileges: 'none' } as any)
      .mockResolvedValue({ granted: true, accessPrivileges: 'all' } as any);
    const openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);

    try {
      render(
        <PrivacyRecoveryScreen
          failure="read"
          failureDomain="keystore_unavailable"
          busy={false}
          onRetry={jest.fn()}
          onRecoverFromBackup={onRecoverFromBackup}
        />,
      );

      fireEvent.press(screen.getByTestId('privacy-wizard-open-import'));
      fireEvent.press(screen.getByTestId('privacy-import-choose-file'));
      await waitFor(() => expect(screen.getByLabelText('备份密码')).toBeTruthy());

      fireEvent.changeText(screen.getByLabelText('备份密码'), 'valid-recovery-passphrase');
      fireEvent.press(screen.getByTestId('privacy-import-decrypt-btn'));
      await waitFor(() => expect(screen.getByTestId('privacy-import-confirm-btn')).toBeTruthy());

      // First restore fails with BackupError('permission') -> shows grant + open settings controls while keeping payload.
      fireEvent.press(screen.getByTestId('privacy-import-confirm-btn'));
      await waitFor(() => expect(screen.getByTestId('privacy-import-grant-permission-btn')).toBeTruthy());
      expect(screen.getByTestId('privacy-import-open-settings-btn')).toBeTruthy();

      // First grant attempt returns permanently denied -> hides in-app prompt button and guides to system settings.
      fireEvent.press(screen.getByTestId('privacy-import-grant-permission-btn'));
      await waitFor(() => expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(false, ['photo', 'video']));
      await waitFor(() => expect(screen.getByText(/前往系统设置开启照片与视频权限/)).toBeTruthy());
      expect(screen.queryByTestId('privacy-import-grant-permission-btn')).toBeNull();

      fireEvent.press(screen.getByTestId('privacy-import-open-settings-btn'));
      await waitFor(() => expect(openSettingsSpy).toHaveBeenCalledTimes(1));

      // Retry restore after granting permission in system settings succeeds cleanly without re-selecting file!
      fireEvent.press(screen.getByTestId('privacy-import-confirm-btn'));
      await waitFor(() => expect(screen.getByTestId('privacy-import-restore-result')).toBeTruthy());
      expect(onRecoverFromBackup).toHaveBeenCalledTimes(2);
    } finally {
      openSettingsSpy.mockRestore();
    }
  });
});
