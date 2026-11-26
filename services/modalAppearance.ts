import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/** Only correct the independent Android RN dialog windows. Root StatusBar
 * remains declarative. Missing support in old builds is not a data failure. */
export async function syncModalAppearance(isDark: boolean): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
        const module = requireOptionalNativeModule<{ syncModalAppearance(dark: boolean): Promise<void> }>('PickPicSystemUI');
        await module?.syncModalAppearance(isDark);
    } catch {
        // Cosmetic native support must never interfere with privacy recovery.
    }
}
