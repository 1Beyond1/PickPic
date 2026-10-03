import { COLORS, COLORS_DARK } from '../constants/theme';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useColorScheme } from 'react-native';

export function useThemeColor() {
    const theme = useSettingsStore((state) => state.theme);
    const systemScheme = useColorScheme();
    const isDark = theme === 'dark' || (theme === 'system' && systemScheme === 'dark');
    const palette = isDark ? COLORS_DARK : COLORS;

    return {
        isDark,
        colors: {
            ...palette,
            card: palette.surface,
        },
    };
}
