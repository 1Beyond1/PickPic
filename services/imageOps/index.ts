/**
 * ImageOps module exports
 */

export * from './IImageOps';
export { getImageOpsJS, ImageOpsJS } from './ImageOpsJS';

import { IImageOps } from './IImageOps';
import { getImageOpsJS } from './ImageOpsJS';

/**
 * Get the current IImageOps implementation
 * Currently returns JS fallback; can be swapped for native implementation
 */
export function getImageOps(): IImageOps {
    // TODO: Add native implementation detection
    // if (NativeModules.ImageOpsNative) {
    //   return new ImageOpsNative();
    // }
    return getImageOpsJS();
}
