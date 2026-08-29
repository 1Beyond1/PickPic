/**
 * ImageOps module exports
 */

export * from './IImageOps';
export { getImageOpsJS, ImageOpsJS } from './ImageOpsJS';

import { IImageOps } from './IImageOps';
import { getImageOpsJS } from './ImageOpsJS';

/**
 * Get the current IImageOps implementation.
 * The current implementation performs real pixel analysis in JavaScript;
 * a native implementation can still replace it later for better throughput.
 */
export function getImageOps(): IImageOps {
    // TODO: Add native implementation detection
    // if (NativeModules.ImageOpsNative) {
    //   return new ImageOpsNative();
    // }
    return getImageOpsJS();
}
