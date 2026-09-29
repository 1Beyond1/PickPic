import { COLORS, COLORS_DARK } from '../constants/theme';

function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => {
    const components = [1, 3, 5].map(index => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
  };

  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('dual-theme visual tokens', () => {
  it.each([COLORS, COLORS_DARK])('keeps text and primary actions legible', palette => {
    expect(contrastRatio(palette.background, palette.text)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.background, palette.textSecondary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.actionBackground, palette.actionForeground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dangerBackground, palette.dangerForeground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.successBackground, palette.successForeground)).toBeGreaterThanOrEqual(4.5);
  });

  it('uses the same semantic color roles in both themes', () => {
    expect(Object.keys(COLORS_DARK).sort()).toEqual(Object.keys(COLORS).sort());
    expect(COLORS_DARK.background).not.toBe(COLORS.background);
  });
});
