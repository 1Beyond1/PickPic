import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { PhotoReadFeedback } from '../components/PhotoReadFeedback';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { usePhotoPreviewSource } from '../hooks/usePhotoPreviewSource';
import { useMediaStore } from '../stores/useMediaStore';

export default function PhotoDetailScreen() {
    const router = useRouter();
    const params = useLocalSearchParams();
    const rawUri = params.uri;
    const rawAssetId = params.assetId;
    const uri = (Array.isArray(rawUri) ? rawUri[0] : rawUri) ?? '';
    const assetId = (Array.isArray(rawAssetId) ? rawAssetId[0] : rawAssetId) ?? '';
    const needsLocalUri = /^(ph|assets-library):\/\//.test(uri);
    const [shareUri, setShareUri] = useState<string | null>(() => (
        needsLocalUri ? null : uri
    ));
    const shareRequestIdRef = useRef(0);
    const handleResolvedUri = useCallback((resolvedUri: string) => {
        // An explicit recovery is newer than an initial Apple URI lookup.
        ++shareRequestIdRef.current;
        setShareUri(resolvedUri);
    }, []);
    const permissionScope = useMediaStore(state => state.permissionScope);
    const permissionRefreshVersion = useMediaStore(state => state.permissionRefreshVersion);
    const mediaLibraryRefreshVersion = useMediaStore(state => state.mediaLibraryRefreshVersion);
    const previousPermissionRefreshVersionRef = useRef(permissionRefreshVersion);
    const previousMediaLibraryRefreshVersionRef = useRef(mediaLibraryRefreshVersion);
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const insets = useSafeAreaInsets();

    useEffect(() => {
        if (permissionRefreshVersion === previousPermissionRefreshVersionRef.current) return;
        previousPermissionRefreshVersionRef.current = permissionRefreshVersion;

        // The URI in the route may refer to a photo that was removed from a
        // limited grant. Leave the detail screen before it can keep showing
        // that old route snapshot.
        router.replace(permissionScope === 'none' ? '/' : '/(tabs)/photos');
    }, [permissionRefreshVersion, permissionScope, router]);

    useEffect(() => {
        if (mediaLibraryRefreshVersion === previousMediaLibraryRefreshVersionRef.current) return;
        previousMediaLibraryRefreshVersionRef.current = mediaLibraryRefreshVersion;
        if (!assetId) return;

        let active = true;
        void MediaLibrary.getAssetInfoAsync(assetId, {
            shouldDownloadFromNetwork: false,
        })
            .then(info => {
                if (!active || info) return;

                // A regular media-library change may have removed the asset
                // shown by this route. Do not leave a stale URI on screen or
                // available to the share action after that deletion.
                router.replace(permissionScope === 'none' ? '/' : '/(tabs)/photos');
            })
            .catch(error => {
                if (active) {
                    console.warn('[PhotoDetail] Failed to verify asset after media-library refresh:', error);
                }
            });

        return () => {
            active = false;
        };
    }, [assetId, mediaLibraryRefreshVersion, permissionScope, router]);

    const resolveShareUri = useCallback(async () => {
        if (!assetId || !needsLocalUri) return uri;

        const info = await MediaLibrary.getAssetInfoAsync(assetId);
        return info?.localUri || info?.uri || uri;
    }, [assetId, needsLocalUri, uri]);

    useEffect(() => {
        let mounted = true;
        const requestId = ++shareRequestIdRef.current;
        setShareUri(needsLocalUri ? null : uri);

        if (!assetId || !needsLocalUri) {
            return () => {
                mounted = false;
            };
        }

        void resolveShareUri()
            .then((resolvedUri) => {
                if (mounted && requestId === shareRequestIdRef.current) setShareUri(resolvedUri);
            })
            .catch((error) => {
                if (mounted && requestId === shareRequestIdRef.current) {
                    console.warn('[PhotoDetail] Failed to resolve local photo URI:', error);
                    setShareUri(uri);
                }
            });

        return () => {
            mounted = false;
        };
    }, [assetId, needsLocalUri, resolveShareUri, uri]);

    const handleShare = async () => {
        try {
            if (await Sharing.isAvailableAsync()) {
                await Sharing.shareAsync(shareUri || await resolveShareUri());
            }
        } catch (error) {
            console.error('[PhotoDetail] Failed to share photo:', error);
        }
    };

    return (
        <View testID="photo-detail" style={[styles.container, {
            backgroundColor: colors.background,
            paddingTop: insets.top + 8,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
        }]}>
            <View style={styles.toolbar}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('photo_detail_back')}
                    style={({ pressed }) => [styles.iconButton, {
                        backgroundColor: pressed ? colors.surfaceHover : 'transparent',
                    }]}
                    onPress={() => router.back()}
                >
                    <Ionicons name="chevron-back" size={24} color={colors.text} />
                </Pressable>
                <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
                    {t('photo_detail_title')}
                </Text>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('photo_detail_share')}
                    style={({ pressed }) => [styles.iconButton, {
                        backgroundColor: pressed ? colors.surfaceHover : 'transparent',
                    }]}
                    onPress={handleShare}
                >
                    <Ionicons name="share-outline" size={22} color={colors.text} />
                </Pressable>
            </View>
            <View testID="photo-detail-media" style={styles.media}>
                <PhotoDetailMedia key={`${assetId}:${uri}`} uri={uri} assetId={assetId} onResolvedUri={handleResolvedUri} />
            </View>
        </View>
    );
}

function PhotoDetailMedia({ uri, assetId, onResolvedUri }: { uri: string; assetId: string; onResolvedUri: (uri: string) => void }) {
    const image = usePhotoPreviewSource(uri, assetId);
    const { colors } = useThemeColor();
    useEffect(() => {
        if (image.attempt > 0 && image.uri && !image.failed) onResolvedUri(image.uri);
    }, [image.attempt, image.uri, image.failed, onResolvedUri]);
    if (image.loading) return <ActivityIndicator size="large" color={colors.primary} />;
    if (image.failed) return <PhotoReadFeedback onRetry={image.retry} />;
    return <Image key={image.attempt} source={{ uri: image.uri }} style={styles.image} contentFit="contain" onError={image.onError} />;
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    image: {
        width: '100%',
        height: '100%',
    },
    toolbar: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    title: {
        ...TYPOGRAPHY.sectionTitle,
        flex: 1,
        minWidth: 0,
        textAlign: 'center',
    },
    media: {
        flex: 1,
        minHeight: 0,
    },
    iconButton: {
        width: UI_METRICS.touchTarget,
        height: UI_METRICS.touchTarget,
        flexShrink: 0,
        borderRadius: UI_METRICS.buttonRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
