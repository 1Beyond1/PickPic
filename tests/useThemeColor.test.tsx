import { act, renderHook } from '@testing-library/react-native';
import { COLORS, COLORS_DARK } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';
import { useSettingsStore } from '../stores/useSettingsStore';

let mockScheme: 'light' | 'dark' | null = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
    __esModule: true, default: () => mockScheme,
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
    getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}),
}));

beforeEach(async () => {
    mockScheme = 'light';
    await act(async () => { await useSettingsStore.persist.rehydrate(); useSettingsStore.getState().setTheme('light'); });
});

it('follows system changes without rewriting the selected preference or changing other settings', () => {
    useSettingsStore.getState().setTheme('system');
    const before = useSettingsStore.getState();
    const view = renderHook(useThemeColor);
    expect(view.result.current).toMatchObject({ isDark: false, colors: { background: COLORS.background } });
    mockScheme = 'dark';
    view.rerender({});
    expect(view.result.current).toMatchObject({ isDark: true, colors: { background: COLORS_DARK.background, card: COLORS_DARK.surface } });
    expect(useSettingsStore.getState()).toBe(before);
    mockScheme = 'light';
    view.rerender({});
    expect(view.result.current.isDark).toBe(false);
});

it.each(['light', 'dark'] as const)('keeps explicit %s independent of the system', theme => {
    useSettingsStore.getState().setTheme(theme);
    mockScheme = theme === 'light' ? 'dark' : 'light';
    const view = renderHook(useThemeColor);
    expect(view.result.current.isDark).toBe(theme === 'dark');
    mockScheme = theme;
    view.rerender({});
    expect(view.result.current.isDark).toBe(theme === 'dark');
});

it('falls back to light when the OS has no reported appearance', () => {
    useSettingsStore.getState().setTheme('system'); mockScheme = null;
    expect(renderHook(useThemeColor).result.current.colors.background).toBe(COLORS.background);
});
