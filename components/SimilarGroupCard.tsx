/**
 * SimilarGroupCard - Card component showing stacked similar photos
 */

import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

interface SimilarGroupCardProps {
    groupId: string;
    memberCount: number;
    memberAssetIds: string[];
    isProcessed?: boolean;
    onPress: (layout?: { x: number; y: number; width: number; height: number }) => void;
}

export function SimilarGroupCard({
    memberCount,
    memberAssetIds,
    isProcessed = false,
    onPress,
}: SimilarGroupCardProps) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const [thumbnails, setThumbnails] = useState<string[]>([]);
    const containerRef = React.useRef<View>(null);
    const loadRequestIdRef = React.useRef(0);

    const handlePress = () => {
        containerRef.current?.measureInWindow((x, y, width, height) => {
            onPress({ x, y, width, height });
        });
    };

    const loadThumbnails = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        const uris: string[] = [];
        // Keep the existing small thumbnail lookup snapshot.
        const idsToLoad = memberAssetIds.slice(0, 4);
        for (const assetId of idsToLoad) {
            try {
                const info = await MediaLibrary.getAssetInfoAsync(assetId);
                if (info.localUri || info.uri) {
                    uris.push(info.localUri || info.uri);
                }
            } catch {
                // Skip failed loads
            }
        }
        if (requestId === loadRequestIdRef.current) {
            setThumbnails(uris);
        }
    }, [memberAssetIds]);

    useEffect(() => {
        loadThumbnails();
        return () => {
            loadRequestIdRef.current += 1;
        };
    }, [loadThumbnails]);

    return (
        <Pressable
            ref={containerRef}
            collapsable={false}
            accessibilityRole="button"
            accessibilityLabel={`${t('similar_group_detail_title')}, ${t('scan_photo_count', { count: memberCount })}${isProcessed ? `, ${t('similar_group_processed')}` : ''}`}
            style={({ pressed }) => [styles.container, { borderBottomColor: colors.divider, backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
            onPress={handlePress}
        >
            <View style={styles.previews}>
                {[0, 1].map(index => (
                    <View key={index} style={[styles.thumbnail, { backgroundColor: colors.surfaceHover }]}>
                        {thumbnails[index] && <Image source={{ uri: thumbnails[index] }} style={styles.image} resizeMode="cover" />}
                    </View>
                ))}
            </View>
            <View style={styles.info}>
                <Text style={[styles.title, { color: colors.text }]}>{t('similar_group_detail_title')}</Text>
                <Text style={[styles.count, { color: colors.textSecondary }]}>{t('scan_photo_count', { count: memberCount })}</Text>
                {isProcessed && (
                    <View style={styles.processed}>
                        <Ionicons name="checkmark" size={14} color={colors.success} />
                        <Text style={[styles.count, { color: colors.success }]}>{t('similar_group_processed')}</Text>
                    </View>
                )}
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: UI_METRICS.touchTarget,
        paddingVertical: 16,
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    previews: { flexDirection: 'row', gap: 4, flexShrink: 0 },
    thumbnail: { width: 48, height: 64, borderRadius: 8, overflow: 'hidden' },
    image: { width: '100%', height: '100%' },
    info: { flex: 1, minWidth: 0, gap: 4 },
    title: { ...TYPOGRAPHY.button },
    count: { ...TYPOGRAPHY.secondary },
    processed: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
