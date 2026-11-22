import {
  DOUBLE_TAP_ZOOM_SCALE,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  clampZoomScale,
  clampZoomTranslation,
  computeDoubleTapZoom,
  computeFittedSize,
  computePanBounds,
  computePinchZoom,
} from '../services/zoomMath';

describe('zoomMath pure worklet geometry', () => {
  it('clamps scale strictly within [MIN_ZOOM_SCALE, MAX_ZOOM_SCALE]', () => {
    expect(clampZoomScale(0.2)).toBe(MIN_ZOOM_SCALE);
    expect(clampZoomScale(1)).toBe(1);
    expect(clampZoomScale(2.5)).toBe(2.5);
    expect(clampZoomScale(12)).toBe(MAX_ZOOM_SCALE);
    expect(clampZoomScale(Number.NaN)).toBe(MIN_ZOOM_SCALE);
  });

  it('computes fitted dimensions and accurate pan bounds without excess overscroll', () => {
    const fitted = computeFittedSize(400, 800, 2000, 1000);
    expect(fitted).toEqual({ width: 400, height: 200 });

    // At 1x scale, no pan is allowed.
    expect(computePanBounds(400, 800, 1, 2000, 1000)).toEqual({ maxX: 0, maxY: 0 });

    // At 2x scale, landscape fitted height is 400 (< 800), so Y stays locked at 0 while X can pan 200px.
    expect(computePanBounds(400, 800, 2, 2000, 1000)).toEqual({ maxX: 200, maxY: 0 });

    const clamped = clampZoomTranslation(500, -500, 400, 800, 2, 2000, 1000);
    expect(clamped).toEqual({ x: 200, y: 0 });
  });

  it('toggles between 1x and DOUBLE_TAP_ZOOM_SCALE on double-tap while clamping to edges', () => {
    const zoomedIn = computeDoubleTapZoom(380, 760, 400, 800, 1);
    expect(zoomedIn.scale).toBe(DOUBLE_TAP_ZOOM_SCALE);
    const bounds = computePanBounds(400, 800, DOUBLE_TAP_ZOOM_SCALE);
    expect(Math.abs(zoomedIn.x)).toBeLessThanOrEqual(bounds.maxX);
    expect(Math.abs(zoomedIn.y)).toBeLessThanOrEqual(bounds.maxY);
    expect(zoomedIn.x).toBeLessThan(0);
    expect(zoomedIn.y).toBeLessThan(0);

    // Double-tapping while zoomed in resets cleanly back to 1x center.
    const reset = computeDoubleTapZoom(200, 400, 400, 800, zoomedIn.scale);
    expect(reset).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('anchors pinch zoom around focal point and snaps to origin near 1x', () => {
    const zoomed = computePinchZoom(300, 400, 400, 800, 1, 0, 0, 2);
    expect(zoomed.scale).toBe(2);
    expect(zoomed.x).toBeCloseTo(-100);
    expect(zoomed.y).toBeCloseTo(0);

    const reset = computePinchZoom(300, 400, 400, 800, 2, -100, 0, 0.4);
    expect(reset).toEqual({ scale: 1, x: 0, y: 0 });
  });
});
