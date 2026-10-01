import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ActivityIndicator, AppState, AppStateStatus, Linking, ScrollView } from 'react-native';
import Index from '../app/index';

const mockRouter = { replace: jest.fn() };
const mockRequest = jest.fn();
const mockGet = jest.fn().mockResolvedValue({ granted: false, canAskAgain: true });
let mockPermission: { granted: boolean; canAskAgain: boolean } | null;
let mockActive: (state: AppStateStatus) => void;
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-media-library', () => ({ usePermissions: () => [mockPermission, mockRequest, mockGet] }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 60, bottom: 24, left: 0, right: 0 }) }));
jest.mock('../hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../hooks/useThemeColor', () => ({ useThemeColor: () => ({ colors: require('../constants/theme').COLORS, isDark: false }) }));

beforeEach(() => {
  mockPermission = { granted: false, canAskAgain: true };
  mockRequest.mockResolvedValue({ granted: false });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockActive = listener;
    return { remove: jest.fn() };
  });
});

it('waits for the permission snapshot without requesting access automatically', () => {
  mockPermission = null;
  render(<Index />);
  expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  expect(screen.queryByText('permission_btn')).toBeNull();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('requests only after a tap and stays on the gate when access is refused', async () => {
  render(<Index />);
  await act(async () => { fireEvent.press(screen.getByText('permission_btn')); });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(screen.getByText('permission_btn')).toBeTruthy();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('disables repeated requests while the OS prompt is pending, then enters photos on grant', async () => {
  let finish!: (result: { granted: boolean }) => void;
  mockRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<Index />);
  fireEvent.press(screen.getByText('permission_btn'));
  fireEvent.press(screen.getByText('permission_requesting'));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ granted: true }); });
  expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/photos');
});

it('opens system settings rather than asking again after a permanent refusal', async () => {
  mockPermission = { granted: false, canAskAgain: false };
  const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
  render(<Index />);
  await act(async () => { fireEvent.press(screen.getByText('permission_open_settings')); });
  expect(settings).toHaveBeenCalledTimes(1);
  expect(mockRequest).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('refreshes permission when the app returns to the foreground, not on backgrounding', async () => {
  render(<Index />);
  await act(async () => { mockActive('background'); });
  expect(mockGet).not.toHaveBeenCalled();
  await act(async () => { mockActive('active'); });
  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(mockRequest).not.toHaveBeenCalled();
});

it('cancels the delayed redirect if a granted gate unmounts', () => {
  jest.useFakeTimers();
  try {
    mockPermission = { granted: true, canAskAgain: true };
    const view = render(<Index />);
    view.unmount();
    act(() => { jest.runOnlyPendingTimers(); });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('enters photos after the existing delay when access was already granted', () => {
  jest.useFakeTimers();
  try {
    mockPermission = { granted: true, canAskAgain: true };
    render(<Index />);
    act(() => { jest.advanceTimersByTime(499); });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1); });
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/photos');
    expect(mockRequest).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('keeps complete copy scrollable within safe areas and exposes a named permission button', () => {
  render(<Index />);
  expect(screen.UNSAFE_getByType(ScrollView).props.contentContainerStyle).toEqual(expect.arrayContaining([
    expect.objectContaining({ paddingTop: 84, paddingBottom: 48, paddingLeft: 20, paddingRight: 20 }),
  ]));
  expect(screen.getByRole('header', { name: 'permission_title' }).props.numberOfLines).toBeUndefined();
  expect(screen.getByRole('button', { name: 'permission_btn' })).toHaveStyle({ minHeight: 50, borderRadius: 12 });
  expect(mockRequest).not.toHaveBeenCalled();
});

it('shows a recoverable permission-request failure without treating it as refusal or entering photos', async () => {
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockRequest.mockRejectedValueOnce(new Error('Permission service temporarily unavailable'));
    render(<Index />);
    await act(async () => { fireEvent.press(screen.getByText('permission_btn')); });
    expect(screen.getByText('permission_request_failed')).toBeTruthy();
    expect(screen.queryByText('permission_denied_desc')).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(screen.getByText('permission_btn')); });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('permission_request_failed')).toBeNull();
  } finally {
    errorLog.mockRestore();
  }
});

it('shows a system-settings failure and leaves its action available for retry', async () => {
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockPermission = { granted: false, canAskAgain: false };
    jest.spyOn(Linking, 'openSettings').mockRejectedValueOnce(new Error('Settings unavailable'));
    render(<Index />);
    await act(async () => { fireEvent.press(screen.getByText('permission_open_settings')); });
    expect(screen.getByText('permission_settings_failed')).toBeTruthy();
    expect(screen.getByText('permission_open_settings')).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  } finally {
    errorLog.mockRestore();
  }
});
