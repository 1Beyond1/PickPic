
// Shared semantic palette for the same layout in light and dark mode.

export const COLORS = {
  primary: '#1B231D',
  primaryLight: '#39433C',
  background: '#F7F8F7',
  surface: '#FFFFFF',
  surfaceHover: '#ECEFEC',
  text: '#1B211D',
  textSecondary: '#626B64',
  textTertiary: '#737D75',
  danger: '#A23E35',
  warning: '#956018',
  success: '#326D4F',
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
  overlay: 'rgba(0, 0, 0, 0.45)',
  border: '#DEE3DE',
  divider: '#DEE3DE',
  actionBackground: '#1B231D',
  actionForeground: '#FAFCF8',
  selectionBackground: '#E2E8E2',
  dangerBackground: '#A23E35',
  dangerForeground: '#FFFFFF',
  successBackground: '#326D4F',
  successForeground: '#FFFFFF',
};

export const COLORS_DARK = {
  primary: '#EFF2ED',
  primaryLight: '#DCE3D9',
  background: '#111212',
  surface: '#1D1E1E',
  surfaceHover: '#232524',
  text: '#F1F2EF',
  textSecondary: '#B1B8B0',
  textTertiary: '#969D97',
  danger: '#EAB0A4',
  warning: '#EFC682',
  success: '#9BCBA8',
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
  overlay: 'rgba(0, 0, 0, 0.65)',
  border: '#2B2D2B',
  divider: '#2B2D2B',
  actionBackground: '#EFF2ED',
  actionForeground: '#181B18',
  selectionBackground: '#282D29',
  dangerBackground: '#A7483F',
  dangerForeground: '#FFFFFF',
  successBackground: '#326D4F',
  successForeground: '#FFFFFF',
};

export const SPACING = {
  xs: 4,
  s: 8,
  m: 16,
  l: 24,
  xl: 32,
  xxl: 48,
};

export const BORDER_RADIUS = {
  s: 8,
  m: 12,
  l: 16,
  xl: 24,
  full: 9999,
};

export const SCREEN_PADDING = SPACING.m;

// Native UI hierarchy: system fonts, natural line wrapping, no fixed text heights.
export const TYPOGRAPHY = {
  pageTitle: { fontSize: 22, lineHeight: 30, fontWeight: '500' as const },
  sectionTitle: { fontSize: 17, lineHeight: 24, fontWeight: '500' as const },
  sheetTitle: { fontSize: 18, lineHeight: 26, fontWeight: '500' as const },
  body: { fontSize: 15, lineHeight: 22 },
  secondary: { fontSize: 13, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 18 },
  button: { fontSize: 15, lineHeight: 22, fontWeight: '500' as const },
};

export const UI_METRICS = {
  pageInset: 20,
  touchTarget: 44,
  rowHeight: 56,
  buttonHeight: 50,
  buttonRadius: 12,
  sheetRadius: 20,
  dockHeight: 65,
};
