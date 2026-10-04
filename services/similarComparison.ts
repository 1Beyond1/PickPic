/** Pure geometry shared by linked image panes. Relative image coordinates
 * align the same approximate region, not objects from different viewpoints. */
export function comparisonTransform(width: number, height: number, viewWidth: number, viewHeight: number,
    scale: number, focusX: number, focusY: number) {
    'worklet';
    const fit = width > 0 && height > 0 ? Math.min(viewWidth / width, viewHeight / height) : 0;
    const fittedWidth = width * fit, fittedHeight = height * fit;
    const maxX = Math.max(0, (fittedWidth * scale - viewWidth) / 2);
    const maxY = Math.max(0, (fittedHeight * scale - viewHeight) / 2);
    const x = Math.max(-maxX, Math.min(maxX, (0.5 - focusX) * fittedWidth * scale));
    const y = Math.max(-maxY, Math.min(maxY, (0.5 - focusY) * fittedHeight * scale));
    return { fittedWidth, fittedHeight, x, y };
}

export function clampComparisonScale(value: number) {
    'worklet';
    return Math.max(1, Math.min(5, value));
}

/** Store the region actually visible, not an offscreen target. Otherwise a
 * reverse drag first has to consume invisible overscroll at an image edge. */
export function comparisonFocus(width: number, height: number, viewWidth: number, viewHeight: number,
    scale: number, focusX: number, focusY: number) {
    'worklet';
    const fit = comparisonTransform(width, height, viewWidth, viewHeight, scale, focusX, focusY);
    return {
        x: fit.fittedWidth > 0 ? 0.5 - fit.x / (fit.fittedWidth * scale) : 0.5,
        y: fit.fittedHeight > 0 ? 0.5 - fit.y / (fit.fittedHeight * scale) : 0.5,
    };
}
