import { Image } from 'expo-image';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { LocalPrivacyError, usePrivacyStore } from '../../stores/usePrivacyStore';

/** Remove only Expo Image's application cache, never library originals. Local
 * previews use memory caching going forward; this is not secure erasure. */
export async function clearLegacyMediaCache(): Promise<void> {
    if (Platform.OS === 'web') return;
    try {
        if (!await Image.clearDiskCache()) throw new LocalPrivacyError();
        const base = FileSystem.cacheDirectory;
        if (!base || !base.startsWith('file://') || /\/\.\.?\//.test(base)) throw new LocalPrivacyError();
        // ImageOps uses only this SDK-owned directory for generated crops and
        // resizes. Clean abandoned copies after a killed process, before any
        // scanner starts. Never clear the whole cache or a media-provider URI.
        await FileSystem.deleteAsync(`${base.replace(/\/?$/, '/')}ImageManipulator/`, { idempotent: true });
        usePrivacyStore.getState().clear('cache');
    } catch {
        usePrivacyStore.getState().block('cache', 'read');
        throw new LocalPrivacyError();
    }
}
