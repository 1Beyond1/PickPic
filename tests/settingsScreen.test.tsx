import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, BackHandler, Linking, Modal, Switch } from 'react-native';

const mockSettings = {
  groupSize: 10, displayOrder: 'random', theme: 'light', language: 'zh',
  selectedAlbumIds: ['album-one'], showDevOptions: false, enableAIClassification: false,
  hasHydrated: true, setGroupSize: jest.fn(), setDisplayOrder: jest.fn(),
  setTheme: jest.fn(), setLanguage: jest.fn(), setSelectedAlbums: jest.fn(),
  setEnableAIClassification: jest.fn(), toggleDevOptions: jest.fn(),
  dismissAnnouncement: jest.fn(), dismissAIGuide: jest.fn(),
};
const mockMedia = {
  photoProcessedIds: ['photo'], videoProcessedIds: ['video'],
  resetPhotoProgress: jest.fn(), resetVideoProgress: jest.fn(),
  totalPhotos: 7, totalVideos: 3, refreshTotalCounts: jest.fn().mockResolvedValue(undefined),
  hasHydrated: true, getVisibleProcessedCounts: jest.fn().mockResolvedValue({ photos: 2, videos: 1 }),
  mediaLibraryRefreshVersion: 0, isConfirmingDeletion: false, isConfirmingVideoTrash: false,
};
const mockScanner = {
  progress: { totalPending: 0, totalDone: 7, totalError: 0, currentBatch: 0 },
  isRunning: false, isFinalizing: false, lastError: null,
  start: jest.fn(), stop: jest.fn(), resumeOnce: jest.fn(), resetScan: jest.fn().mockResolvedValue(undefined),
};
let mockBack: () => boolean;

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null, Ionicons: () => null }));
jest.mock('../components/AlbumSelector', () => ({ AlbumSelector: () => null }));
jest.mock('../components/ScanBatchModal', () => ({ ScanBatchModal: () => null }));
jest.mock('../hooks/useAIScanner', () => ({ useAIScanner: () => mockScanner }));
jest.mock('../stores/useSettingsStore', () => ({
  APP_VERSION: 'v0.4.0', useSettingsStore: Object.assign(() => mockSettings, { getState: () => mockSettings }),
}));
jest.mock('../stores/useMediaStore', () => ({ useMediaStore: () => mockMedia }));
jest.mock('../hooks/useThemeColor', () => ({
  useThemeColor: () => {
    const palette = require('../constants/theme');
    return { colors: mockSettings.theme === 'dark' ? palette.COLORS_DARK : palette.COLORS, isDark: mockSettings.theme === 'dark' };
  },
}));
jest.mock('../hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, string | number>) => {
    const messages = mockSettings.language === 'zh' ? require('../i18n/zh').default : require('../i18n/en').default;
    return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), messages[key]);
  } }),
}));

import SettingsScreen from '../app/(tabs)/settings';
import zh from '../i18n/zh';

const openData = () => fireEvent.press(screen.getByRole('button', { name: zh.settings_data_management }));
const visibleModal = () => screen.UNSAFE_getAllByType(Modal).find(modal => modal.props.visible)!;
const expectNoReset = () => {
  expect(mockMedia.resetPhotoProgress).not.toHaveBeenCalled();
  expect(mockMedia.resetVideoProgress).not.toHaveBeenCalled();
  expect(mockScanner.resetScan).not.toHaveBeenCalled();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  Object.assign(mockSettings, { theme: 'light', language: 'zh', displayOrder: 'random', hasHydrated: true, enableAIClassification: false, showDevOptions: false });
  Object.assign(mockMedia, { isConfirmingDeletion: false, isConfirmingVideoTrash: false });
  Object.assign(mockScanner, { isRunning: false, isFinalizing: false });
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    mockBack = handler as () => boolean;
    return { remove: jest.fn() };
  });
});

it('exposes ordinary preferences and classification without putting destructive actions on the main page', async () => {
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  expect(screen.getByText(zh.settings_organizing_preferences)).toBeTruthy();
  expect(screen.getByRole('radio', { name: '10 张', checked: true })).toBeTruthy();
  fireEvent.press(screen.getByRole('radio', { name: '20 张' }));
  expect(mockSettings.setGroupSize).toHaveBeenCalledWith(20);
  expect(screen.getByLabelText(zh.settings_enable_ai_classification)).toBeTruthy();
  expect(screen.queryByText(zh.settings_reset_photos)).toBeNull();
  expect(screen.queryByText(zh.ai_scanner_start)).toBeNull();
  expectNoReset();
});

it.each([
  ['theme', zh.settings_theme, zh.theme_light, zh.theme_dark, 'dark', mockSettings.setTheme],
  ['order', zh.settings_display_order, zh.display_order_random, zh.display_order_newest, 'newest', mockSettings.setDisplayOrder],
  ['language', zh.settings_language, '中文', 'English', 'en', mockSettings.setLanguage],
] as const)('writes the selected %s value only after an explicit choice', async (_kind, label, initial, next, value, setter) => {
  const view = render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  fireEvent.press(screen.getByRole('button', { name: `${label}, ${initial}` }));
  expect(screen.getByRole('radio', { name: initial, checked: true })).toBeTruthy();
  expect(setter).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('radio', { name: next }));
  expect(setter).toHaveBeenCalledTimes(1);
  expect(setter).toHaveBeenCalledWith(value);
  expect(screen.queryByRole('radio', { name: next })).toBeNull();
  Object.assign(mockSettings, _kind === 'order' ? { displayOrder: value } : { [_kind]: value });
  view.rerender(<SettingsScreen />);
  const newLabel = _kind === 'language' ? 'Language' : label;
  expect(screen.getByRole('button', { name: `${newLabel}, ${next}` })).toBeTruthy();
});

it('closes a choice with cancel or native back without changing the saved preference', async () => {
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  const openTheme = () => fireEvent.press(screen.getByRole('button', { name: `${zh.settings_theme}, ${zh.theme_light}` }));
  openTheme();
  fireEvent.press(screen.getByRole('button', { name: zh.cancel }));
  openTheme();
  fireEvent(visibleModal(), 'requestClose');
  expect(screen.queryByRole('radio', { name: zh.theme_dark })).toBeNull();
  expect(mockSettings.setTheme).not.toHaveBeenCalled();
});

it.each([
  [zh.settings_reset_photos, zh.settings_reset_photos_desc, mockMedia.resetPhotoProgress],
  [zh.settings_reset_videos, zh.settings_reset_videos_desc, mockMedia.resetVideoProgress],
  [zh.ai_scanner_reset, zh.settings_reset_scan_desc, mockScanner.resetScan],
] as const)('requires confirmation before %s and resets only the chosen record type', async (label, description, target) => {
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  openData();
  expect(screen.getByText('已整理: 2 张 / 共 7 张')).toBeTruthy();
  expect(screen.getByText('已整理: 1 个 / 共 3 个')).toBeTruthy();
  const openReset = () => fireEvent.press(screen.getByRole('button', { name: label }));
  openReset();
  expect(screen.getByText(description)).toBeTruthy();
  expectNoReset();
  fireEvent.press(screen.getByText(zh.cancel));
  expectNoReset();
  openReset();
  fireEvent(visibleModal(), 'requestClose');
  expect(screen.queryByText(description)).toBeNull();
  expect(screen.getByRole('header', { name: zh.settings_data_management })).toBeTruthy();
  expectNoReset();
  openReset();
  fireEvent.press(screen.getByText(zh.settings_confirm_reset));
  await waitFor(() => expect(target).toHaveBeenCalledTimes(1));
  for (const reset of [mockMedia.resetPhotoProgress, mockMedia.resetVideoProgress, mockScanner.resetScan]) {
    if (reset !== target) expect(reset).not.toHaveBeenCalled();
  }
});

it('retains deletion-in-progress guards on reset entries', async () => {
  mockMedia.isConfirmingDeletion = true;
  mockMedia.isConfirmingVideoTrash = true;
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  openData();
  for (const label of [zh.settings_reset_photos, zh.settings_reset_videos]) {
    const button = screen.getByRole('button', { name: label, disabled: true });
    fireEvent.press(button);
  }
  expect(screen.queryByText(zh.settings_confirm_reset)).toBeNull();
  expectNoReset();
});

it.each([
  [zh.settings_reset_photos, 'isConfirmingDeletion'],
  [zh.settings_reset_videos, 'isConfirmingVideoTrash'],
] as const)('keeps %s cancellable if deletion starts while its confirmation is open', async (label, lock) => {
  const view = render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  openData();
  fireEvent.press(screen.getByRole('button', { name: label }));
  mockMedia[lock] = true;
  view.rerender(<SettingsScreen />);
  fireEvent.press(screen.getByText(zh.settings_confirm_reset));
  expectNoReset();
  fireEvent(visibleModal(), 'requestClose');
  expect(screen.queryByText(zh.settings_confirm_reset)).toBeNull();
  expectNoReset();
});

it('reports scanner reset failure instead of treating it as a successful reset', async () => {
  mockScanner.resetScan.mockRejectedValueOnce(new Error('busy'));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  openData();
  fireEvent.press(screen.getByRole('button', { name: zh.ai_scanner_reset }));
  fireEvent.press(screen.getByText(zh.settings_confirm_reset));
  await waitFor(() => expect(alert).toHaveBeenCalledWith('重置失败', expect.stringContaining('尚未重置')));
  expect(log).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: zh.ai_scanner_reset, disabled: false })).toBeTruthy();
  expect(mockMedia.resetPhotoProgress).not.toHaveBeenCalled();
});

it('requires classification consent and does not alter it when the consent is dismissed', async () => {
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  const toggle = screen.UNSAFE_getByType(Switch);
  fireEvent(toggle, 'valueChange', true);
  expect(screen.getByText(zh.ai_classification_warning_message)).toBeTruthy();
  expect(mockSettings.setEnableAIClassification).not.toHaveBeenCalled();
  fireEvent(visibleModal(), 'requestClose');
  expect(mockSettings.setEnableAIClassification).not.toHaveBeenCalled();
  fireEvent(toggle, 'valueChange', true);
  fireEvent.press(screen.getByText(zh.ai_classification_warning_confirm));
  expect(mockSettings.setEnableAIClassification).toHaveBeenCalledWith(true);
});

it('resets only onboarding read flags and shows success in the same modal before auto-closing', async () => {
  mockSettings.showDevOptions = true;
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  fireEvent.press(screen.getByText('重置弹窗已读状态'));
  fireEvent(visibleModal(), 'requestClose');
  expect(mockSettings.dismissAnnouncement).not.toHaveBeenCalled();
  expect(mockSettings.dismissAIGuide).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('重置弹窗已读状态'));
  const modal = visibleModal();
  jest.useFakeTimers();
  try {
    fireEvent.press(screen.getByText(zh.confirm));
    expect(mockSettings.dismissAnnouncement).toHaveBeenCalledWith(null);
    expect(mockSettings.dismissAIGuide).toHaveBeenCalledWith(null);
    expectNoReset();
    expect(screen.getByRole('header', { name: '重置成功' })).toBeTruthy();
    expect(visibleModal()).toBe(modal);
    expect(screen.queryByText(zh.confirm)).toBeNull();
    act(() => jest.advanceTimersByTime(1500));
    expect(screen.queryByText('重置成功')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

it.each(['isRunning', 'isFinalizing'] as const)('disables classification while the scanner %s', async flag => {
  mockScanner[flag] = true;
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  expect(screen.UNSAFE_getByType(Switch).props.disabled).toBe(true);
  expect(mockSettings.setEnableAIClassification).not.toHaveBeenCalled();
});

it('returns from second-level pages with visible back and Android back without resetting anything', async () => {
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  openData();
  act(() => { expect(mockBack()).toBe(true); });
  fireEvent.press(screen.getByRole('button', { name: `${zh.settings_scan_management}, 已扫描 7 张` }));
  expect(screen.getByText(zh.ai_scanner_start)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: zh.settings_back }));
  expect(screen.getByRole('header', { name: zh.settings_title })).toBeTruthy();
  expect(mockBack()).toBe(false);
  expectNoReset();
  expect(mockScanner.start).not.toHaveBeenCalled();
});

it('opens the repository only on request and keeps help available inside the app', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  expect(openURL).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: `${zh.settings_open_source}, GitHub` }));
  expect(openURL).toHaveBeenCalledWith('https://github.com/1Beyond1/PickPic');
  fireEvent.press(screen.getByRole('button', { name: zh.settings_help }));
  expect(screen.getByText(zh.announcement_notice_1)).toBeTruthy();
  expectNoReset();
});

it('does not expose preference controls or overwrite settings before hydration', async () => {
  mockSettings.hasHydrated = false;
  render(<SettingsScreen />);
  await act(async () => {});
  expect(screen.queryByRole('radio')).toBeNull();
  expect(mockSettings.setTheme).not.toHaveBeenCalled();
  expect(mockSettings.setLanguage).not.toHaveBeenCalled();
  expectNoReset();
});

it('does not let an old full-access progress response overwrite a newer permission snapshot', async () => {
  const oldCounts = deferred<{ photos: number; videos: number }>();
  mockMedia.getVisibleProcessedCounts.mockReturnValueOnce(oldCounts.promise)
    .mockResolvedValueOnce({ photos: 1, videos: 0 });
  const view = render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalledTimes(1));
  openData();
  mockMedia.mediaLibraryRefreshVersion += 1;
  view.rerender(<SettingsScreen />);
  await screen.findByText('已整理: 1 张 / 共 7 张');
  await act(async () => { oldCounts.resolve({ photos: 7, videos: 3 }); });
  expect(screen.getByText('已整理: 1 张 / 共 7 张')).toBeTruthy();
  expect(screen.getByText('已整理: 0 个 / 共 3 个')).toBeTruthy();
  expectNoReset();
});

it('clears stale visible progress after a media read failure and recovers on the next refresh', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const view = render(<SettingsScreen />);
  openData();
  await screen.findByText('已整理: 2 张 / 共 7 张');
  mockMedia.getVisibleProcessedCounts.mockRejectedValueOnce(new Error('Permission read failed'));
  mockMedia.mediaLibraryRefreshVersion += 1;
  view.rerender(<SettingsScreen />);
  await screen.findByText('已整理: 0 张 / 共 7 张');
  expectNoReset();
  mockMedia.mediaLibraryRefreshVersion += 1;
  view.rerender(<SettingsScreen />);
  await screen.findByText('已整理: 2 张 / 共 7 张');
  expectNoReset();
});

it.each([[320, 1, 'column'], [411, 1.4, 'column'], [411, 1, 'row']] as const)(
  'keeps scan controls and original counts without starting when opened at width %s, font %s', async (width, fontScale, direction) => {
    const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width, height: 800, scale: 3, fontScale });
    mockSettings.language = 'en';
    const en = require('../i18n/en').default;
    render(<SettingsScreen />);
    await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
    fireEvent.press(screen.getByRole('button', { name: `${en.settings_scan_management}, 7 scanned` }));
    expect(dimensions).toHaveBeenCalled();
    expect(screen.getByTestId('scanner-stats')).toHaveStyle({ flexDirection: direction });
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText(en.ai_scanner_done)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.ai_scanner_start })).toHaveStyle({ minHeight: 50 });
    expect(screen.getByRole('button', { name: en.scan_batch })).toHaveStyle({ minHeight: 50 });
    expect(mockScanner.start).not.toHaveBeenCalled();
    expect(mockScanner.resumeOnce).not.toHaveBeenCalled();
    expectNoReset();
  }
);

it('keeps a running scan stoppable while disabling batch selection', async () => {
  mockScanner.isRunning = true;
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  fireEvent.press(screen.getByRole('button', { name: `${zh.settings_scan_management}, ${zh.scan_organizing}` }));
  const stop = screen.getByRole('button', { name: zh.ai_scanner_stop });
  expect(stop).toBeEnabled();
  const batch = screen.getByRole('button', { name: zh.scan_batch });
  expect(batch).toBeDisabled();
  fireEvent.press(batch);
  fireEvent.press(stop);
  expect(mockScanner.stop).toHaveBeenCalledTimes(1);
  expect(mockScanner.start).not.toHaveBeenCalled();
  expect(mockScanner.resumeOnce).not.toHaveBeenCalled();
  expectNoReset();
});

it('does not start another scan from either control while finalizing', async () => {
  mockScanner.isFinalizing = true;
  render(<SettingsScreen />);
  await waitFor(() => expect(mockMedia.getVisibleProcessedCounts).toHaveBeenCalled());
  fireEvent.press(screen.getByRole('button', { name: `${zh.settings_scan_management}, ${zh.scan_organizing}` }));
  const start = screen.getByRole('button', { name: zh.ai_scanner_start });
  const batch = screen.getByRole('button', { name: zh.scan_batch });
  expect(start).toBeDisabled();
  expect(batch).toBeDisabled();
  fireEvent.press(start);
  fireEvent.press(batch);
  expect(mockScanner.start).not.toHaveBeenCalled();
  expect(mockScanner.resumeOnce).not.toHaveBeenCalled();
  expectNoReset();
});
