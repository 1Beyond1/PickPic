import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ScalablePressable } from '../components/ScalablePressable'; // Import ScalablePressable
import { BORDER_RADIUS, SPACING } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';

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
    const { colors, isDark } = useThemeColor();

    const resolveShareUri = useCallback(async () => {
        if (!assetId || !needsLocalUri) return uri;

        const info = await MediaLibrary.getAssetInfoAsync(assetId);
        return info?.localUri || info?.uri || uri;
    }, [assetId, needsLocalUri, uri]);

    useEffect(() => {
        let mounted = true;
        setShareUri(needsLocalUri ? null : uri);

        if (!assetId || !needsLocalUri) {
            return () => {
                mounted = false;
            };
        }

        void resolveShareUri()
            .then((resolvedUri) => {
                if (mounted) setShareUri(resolvedUri);
            })
            .catch((error) => {
                if (mounted) {
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
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <Image
                source={{ uri }}
                style={styles.image}
                contentFit="contain"
            />

            {/* Top Bar with Back Button */}
            <View style={styles.topBar}>
                <ScalablePressable
                    style={styles.iconButton}
                    onPress={() => router.back()}
                >
                    <BlurView intensity={30} tint={isDark ? "dark" : "light"} style={styles.blurButton}>
                        <Ionicons name="chevron-back" size={28} color={colors.text} />
                    </BlurView>
                </ScalablePressable>
            </View>

            {/* Bottom Bar with Share Button */}
            <View style={styles.bottomBar}>
                <View style={{ flex: 1 }} />
                <ScalablePressable
                    style={styles.iconButton}
                    onPress={handleShare}
                >
                    <BlurView intensity={30} tint={isDark ? "dark" : "light"} style={styles.blurButton}>
                        <Ionicons name="share-outline" size={24} color={colors.text} />
                    </BlurView>
                </ScalablePressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    image: {
        width: '100%',
        height: '100%',
    },
    topBar: {
        position: 'absolute',
        top: 50,
        left: SPACING.m,
        zIndex: 10
    },
    bottomBar: {
        position: 'absolute',
        bottom: 40,
        right: SPACING.m,
        flexDirection: 'row',
        zIndex: 10
    },
    iconButton: {
        borderRadius: BORDER_RADIUS.full,
        overflow: 'hidden',
    },
    blurButton: {
        padding: SPACING.s + 4,
        borderRadius: BORDER_RADIUS.full,
        alignItems: 'center',
        justifyContent: 'center'
    }
});
