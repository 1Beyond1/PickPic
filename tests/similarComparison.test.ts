import { comparisonTransform, comparisonFocus, clampComparisonScale } from '../services/similarComparison';

it('fits mixed-aspect photos fully at 1x without showing neighboring content', () => {
    const landscape = comparisonTransform(1200, 800, 200, 300, 1, 0, 1);
    expect(landscape.fittedWidth).toBeCloseTo(200);
    expect(landscape.fittedHeight).toBeCloseTo(800 / 6);
    expect(landscape.x).toBeCloseTo(0); expect(landscape.y).toBeCloseTo(0);
    const portrait = comparisonTransform(800, 1200, 200, 300, 1, 0, 1);
    expect(portrait.fittedWidth).toBeCloseTo(200); expect(portrait.fittedHeight).toBeCloseTo(300);
    expect(portrait.x).toBeCloseTo(0); expect(portrait.y).toBeCloseTo(0);
});
it('keeps focus at the visible edge so a small reverse drag moves immediately', () => {
    const focus = comparisonFocus(800, 1200, 200, 300, 3, 0, 1);
    expect(focus.x).toBeCloseTo(1 / 6);
    expect(focus.y).toBeCloseTo(5 / 6);
    const before = comparisonTransform(800, 1200, 200, 300, 3, focus.x, focus.y);
    const reverse = comparisonFocus(800, 1200, 200, 300, 3, focus.x + 10 / 600, focus.y - 10 / 900);
    const after = comparisonTransform(800, 1200, 200, 300, 3, reverse.x, reverse.y);
    expect(after.x).toBeCloseTo(before.x - 10);
    expect(after.y).toBeCloseTo(before.y + 10);
    expect(comparisonFocus(1200, 800, 200, 300, 1, 0, 1)).toEqual({ x: 0.5, y: 0.5 });
});
it('links normalized image regions and clamps translations to real image edges', () => {
    expect(comparisonTransform(1200, 800, 200, 300, 3, 0.75, 0.5)).toMatchObject({ x: -150, y: 0 });
    expect(comparisonTransform(800, 1200, 200, 300, 3, 0.75, 0.5)).toMatchObject({ x: -150, y: 0 });
    expect(comparisonTransform(800, 1200, 200, 300, 3, 1, 1)).toMatchObject({ x: -200, y: -300 });
});
it('bounds zoom and does not fabricate dimensions for an unknown image', () => {
    expect(clampComparisonScale(0.1)).toBe(1);
    expect(clampComparisonScale(8)).toBe(5);
    const unknown = comparisonTransform(0, 0, 200, 300, 5, 1, 1);
    expect(unknown.fittedWidth).toBe(0); expect(unknown.fittedHeight).toBe(0);
    expect(unknown.x).toBeCloseTo(0); expect(unknown.y).toBeCloseTo(0);
});
