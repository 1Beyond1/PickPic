export const MIN_ZOOM_SCALE = 1;
export const DOUBLE_TAP_ZOOM_SCALE = 2.5;
export const MAX_ZOOM_SCALE = 5;

export interface ZoomTransformState {
    scale: number;
    x: number;
    y: number;
}

export function clampZoomScale(
    value: number,
    minScale: number = MIN_ZOOM_SCALE,
    maxScale: number = MAX_ZOOM_SCALE,
): number {
    'worklet';
    if (!Number.isFinite(value)) return minScale;
    return Math.max(minScale, Math.min(maxScale, value));
}

export function computeFittedSize(
    viewWidth: number,
    viewHeight: number,
    imgWidth: number = 0,
    imgHeight: number = 0,
): { width: number; height: number } {
    'worklet';
    if (viewWidth <= 0 || viewHeight <= 0) {
        return { width: 0, height: 0 };
    }
    if (imgWidth > 0 && imgHeight > 0) {
        const fit = Math.min(viewWidth / imgWidth, viewHeight / imgHeight);
        return { width: imgWidth * fit, height: imgHeight * fit };
    }
    return { width: viewWidth, height: viewHeight };
}

export function computePanBounds(
    viewWidth: number,
    viewHeight: number,
    scale: number,
    imgWidth: number = 0,
    imgHeight: number = 0,
): { maxX: number; maxY: number } {
    'worklet';
    const clampedScale = clampZoomScale(scale);
    if (clampedScale <= MIN_ZOOM_SCALE || viewWidth <= 0 || viewHeight <= 0) {
        return { maxX: 0, maxY: 0 };
    }
    const fitted = computeFittedSize(viewWidth, viewHeight, imgWidth, imgHeight);
    return {
        maxX: Math.max(0, (fitted.width * clampedScale - viewWidth) / 2),
        maxY: Math.max(0, (fitted.height * clampedScale - viewHeight) / 2),
    };
}

export function clampZoomTranslation(
    x: number,
    y: number,
    viewWidth: number,
    viewHeight: number,
    scale: number,
    imgWidth: number = 0,
    imgHeight: number = 0,
): { x: number; y: number } {
    'worklet';
    const { maxX, maxY } = computePanBounds(viewWidth, viewHeight, scale, imgWidth, imgHeight);
    const safeX = Number.isFinite(x) ? x : 0;
    const safeY = Number.isFinite(y) ? y : 0;
    const clampedX = Math.max(-maxX, Math.min(maxX, safeX));
    const clampedY = Math.max(-maxY, Math.min(maxY, safeY));
    return {
        x: clampedX === 0 ? 0 : clampedX,
        y: clampedY === 0 ? 0 : clampedY,
    };
}

export function computeDoubleTapZoom(
    tapX: number,
    tapY: number,
    viewWidth: number,
    viewHeight: number,
    currentScale: number,
    targetScale: number = DOUBLE_TAP_ZOOM_SCALE,
    imgWidth: number = 0,
    imgHeight: number = 0,
): ZoomTransformState {
    'worklet';
    if (currentScale > MIN_ZOOM_SCALE + 0.05) {
        return { scale: MIN_ZOOM_SCALE, x: 0, y: 0 };
    }
    const nextScale = clampZoomScale(targetScale);
    if (viewWidth <= 0 || viewHeight <= 0) {
        return { scale: nextScale, x: 0, y: 0 };
    }
    const offsetFromCenterX = tapX - viewWidth / 2;
    const offsetFromCenterY = tapY - viewHeight / 2;
    const desiredX = -offsetFromCenterX * (nextScale - 1);
    const desiredY = -offsetFromCenterY * (nextScale - 1);
    const clamped = clampZoomTranslation(desiredX, desiredY, viewWidth, viewHeight, nextScale, imgWidth, imgHeight);
    return { scale: nextScale, x: clamped.x, y: clamped.y };
}

export function computePinchZoom(
    focalX: number,
    focalY: number,
    viewWidth: number,
    viewHeight: number,
    startScale: number,
    startX: number,
    startY: number,
    pinchScale: number,
    imgWidth: number = 0,
    imgHeight: number = 0,
): ZoomTransformState {
    'worklet';
    const safeStartScale = clampZoomScale(startScale);
    const nextScale = clampZoomScale(safeStartScale * pinchScale);
    if (nextScale <= MIN_ZOOM_SCALE + 0.01) {
        return { scale: MIN_ZOOM_SCALE, x: 0, y: 0 };
    }
    if (viewWidth <= 0 || viewHeight <= 0) {
        return { scale: nextScale, x: 0, y: 0 };
    }
    const focalOffsetX = focalX - viewWidth / 2;
    const focalOffsetY = focalY - viewHeight / 2;
    const ratio = nextScale / safeStartScale;
    const desiredX = focalOffsetX - (focalOffsetX - startX) * ratio;
    const desiredY = focalOffsetY - (focalOffsetY - startY) * ratio;
    const clamped = clampZoomTranslation(desiredX, desiredY, viewWidth, viewHeight, nextScale, imgWidth, imgHeight);
    return { scale: nextScale, x: clamped.x, y: clamped.y };
}
