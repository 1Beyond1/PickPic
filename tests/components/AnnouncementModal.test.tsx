import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Modal, ScrollView } from 'react-native';
import zh from '../../i18n/zh';
import en from '../../i18n/en';
import { AnnouncementModal } from '../../components/AnnouncementModal';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 60, bottom: 24, left: 0, right: 0 }) }));
jest.mock('../../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => require('../../i18n/zh').default[key] }) }));
jest.mock('../../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: require('../../constants/theme').COLORS }) }));
jest.mock('../../stores/useSettingsStore', () => ({ APP_VERSION: 'v0.4.0' }));

it('keeps closing once distinct from dismissing for the version, including system back', () => {
  const once = jest.fn();
  const version = jest.fn();
  const view = render(<AnnouncementModal visible onDismissOnce={once} onDismissForVersion={version} />);
  expect(once).not.toHaveBeenCalled();
  expect(version).not.toHaveBeenCalled();
  fireEvent.press(view.getByText(zh.announcement_close_once));
  expect(once).toHaveBeenCalledTimes(1);
  expect(version).not.toHaveBeenCalled();
  fireEvent(view.UNSAFE_getByType(Modal), 'requestClose');
  expect(once).toHaveBeenCalledTimes(2);
  expect(version).not.toHaveBeenCalled();
  fireEvent.press(view.getByText(zh.announcement_close_version));
  expect(version).toHaveBeenCalledTimes(1);
});

it('names the two dismissal actions so their persistence is distinguishable', () => {
  const view = render(<AnnouncementModal visible onDismissOnce={jest.fn()} onDismissForVersion={jest.fn()} />);
  expect(view.getByRole('button', { name: zh.announcement_close_once })).toBeTruthy();
  expect(view.getByRole('button', { name: zh.announcement_close_version })).toBeTruthy();
});

it('preserves the deletion warning and keeps closing actions outside the long scrolling text', () => {
  const once = jest.fn();
  const version = jest.fn();
  const view = render(<AnnouncementModal visible onDismissOnce={once} onDismissForVersion={version} />);
  expect(view.getByText(zh.announcement_notice_1)).toBeTruthy();
  expect(view.getByText(zh.announcement_notice_2)).toBeTruthy();
  expect(view.UNSAFE_getByType(ScrollView).findAll((node: { props: { onPress?: unknown } }) => node.props.onPress)).toHaveLength(0);
  expect(view.getByRole('button', { name: zh.announcement_close_version })).toHaveStyle({ minHeight: 50 });
  expect(view.getByTestId('sheet-backdrop', { includeHiddenElements: true }).props.onPress).toBeUndefined();
  fireEvent.press(view.getByRole('button', { name: zh.close }));
  expect(once).toHaveBeenCalledTimes(1);
  expect(version).not.toHaveBeenCalled();
});

it('points classification instructions to the actual settings group, not obsolete developer options', () => {
  expect(zh.update_v030_1).toContain(zh.settings_intelligent_analysis);
  expect(zh.update_v030_1).toContain(zh.settings_enable_ai_classification);
  expect(zh.update_v030_1).not.toMatch(/开发者选项/);
});

it('renders the updated review, recovery and video notes without calling dismissal actions', () => {
  const once = jest.fn();
  const version = jest.fn();
  const view = render(<AnnouncementModal visible onDismissOnce={once} onDismissForVersion={version} />);
  for (const key of ['update_v030_1', 'update_v030_2', 'update_v030_3', 'announcement_update_recovery', 'announcement_update_video'] as const) {
    expect(view.getByText(zh[key])).toBeTruthy();
    expect(en[key]).toBeTruthy();
  }
  expect(zh.update_v030_3).toContain('仍算已整理');
  expect(en.update_v030_3).toContain('staying in review');
  expect(once).not.toHaveBeenCalled();
  expect(version).not.toHaveBeenCalled();
});
