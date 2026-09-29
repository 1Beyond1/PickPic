import { COLORS, COLORS_DARK } from '../constants/theme';
import { useSettingsStore } from '../stores/useSettingsStore';

export function useThemeColor() {
    const isDark = useSettingsStore((state) => state.theme === 'dark');
    const palette = isDark ? COLORS_DARK : COLORS;

    return {
        isDark,
        colors: {
            ...palette,
            card: palette.surface,
        },
    };
}
