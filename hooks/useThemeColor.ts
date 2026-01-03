import { useColorScheme } from 'react-native';
import { COLORS } from '../constants/theme';
import { useSettingsStore } from '../stores/useSettingsStore';

export function useThemeColor() {
    const systemScheme = useColorScheme();
    const themeSetting = useSettingsStore((state) => state.theme);

    const isDark =
        themeSetting === 'auto'
            ? systemScheme === 'dark'
            : themeSetting === 'dark';

    return {
        isDark,
        colors: {
            ...COLORS,
            background: isDark ? '#000000' : '#F2F2F7', // Deep Black vs iOS Light Gray
            surface: isDark ? 'rgba(30, 30, 30, 0.6)' : 'rgba(255, 255, 255, 0.6)',
            text: isDark ? '#FFFFFF' : '#000000',
            textSecondary: isDark ? '#8E8E93' : '#8E8E93',
            card: isDark ? '#1C1C1E' : '#FFFFFF',
            border: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
        }
    };
}
