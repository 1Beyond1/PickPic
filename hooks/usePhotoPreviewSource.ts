import * as MediaLibrary from 'expo-media-library';
import { useEffect, useState } from 'react';

/** Callers key the preview by asset/URI. Normal display uses the supplied URI;
 * only an explicit retry re-reads the asset. No organizing state is touched. */
export function usePhotoPreviewSource(uri: string, assetId?: string) {
    const [attempt, setAttempt] = useState(0);
    const [image, setImage] = useState<{ uri: string; failed: boolean; attempt: number } | null>({ uri, failed: !uri, attempt: 0 });

    useEffect(() => {
        if (attempt === 0) return;
        let active = true;
        setImage(null);
        void (assetId ? MediaLibrary.getAssetInfoAsync(assetId) : Promise.resolve({ uri, localUri: undefined })).then(info => {
            const nextUri = info?.localUri || info?.uri || '';
            if (active) setImage({ uri: nextUri, failed: !nextUri, attempt });
        }).catch(() => {
            if (active) setImage({ uri: '', failed: true, attempt });
        });
        return () => { active = false; };
    }, [uri, assetId, attempt]);

    const currentUri = image?.uri;
    return {
        uri: currentUri,
        failed: image?.failed ?? false,
        loading: image === null,
        attempt,
        retry: () => setAttempt(value => value + 1),
        onError: () => setImage(previous => previous?.attempt === attempt && previous.uri === currentUri
            ? { ...previous, failed: true } : previous),
    };
}
