import { COLORS } from '../constants/theme';
import { useSettingsStore } from '../stores/useSettingsStore';

// Google-style blue colors (for light/dark theme options)
const GOOGLE_COLORS = {
    primary: '#1A73E8',         // Google Blue
    primaryLight: '#4285F4',
    background: '#FFFFFF',
    surface: '#F8F9FA',
    surfaceHover: '#E8EAED',
    text: '#202124',
    textSecondary: '#5F6368',
    textTertiary: '#9AA0A6',
    danger: '#EA4335',          // Google Red
    warning: '#FBBC04',         // Google Yellow
    success: '#34A853',         // Google Green
    white: '#FFFFFF',
    black: '#000000',
    transparent: 'transparent',
    overlay: 'rgba(32, 33, 36, 0.4)',
    border: '#DADCE0',
    divider: '#E8EAED',
};

const GOOGLE_COLORS_DARK = {
    primary: '#8AB4F8',         // Google Blue (light for dark mode)
    primaryLight: '#A8C7FA',
    background: '#202124',
    surface: '#303134',
    surfaceHover: '#3C4043',
    text: '#E8EAED',
    textSecondary: '#9AA0A6',
    textTertiary: '#5F6368',
    danger: '#F28B82',
    warning: '#FDD663',
    success: '#81C995',
    white: '#FFFFFF',
    black: '#000000',
    transparent: 'transparent',
    overlay: 'rgba(0, 0, 0, 0.6)',
    border: '#5F6368',
    divider: '#3C4043',
};

export function useThemeColor() {
    const themeSetting = useSettingsStore((state) => state.theme);

    let isDark = false;
    let palette: typeof COLORS;

    switch (themeSetting) {
        case 'WarmTerra':
            // Warm Terra theme: 米白色背景 + 橙色强调 (always light mode)
            isDark = false;
            palette = COLORS; // Warm Terra colors from theme.ts
            break;
        case 'dark':
            // Dark mode with Google Blue accent
            isDark = true;
            palette = GOOGLE_COLORS_DARK;
            break;
        case 'light':
        default:
            // Light mode with Google Blue accent
            isDark = false;
            palette = GOOGLE_COLORS;
            break;
    }

    return {
        isDark,
        colors: {
            ...palette,
            card: palette.surface,
        }
    };
}
