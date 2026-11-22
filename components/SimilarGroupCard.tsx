/**
 * SimilarGroupCard - Card component showing stacked similar photos
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { getReadableMediaInfos } from '../services/readableMedia';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

interface SimilarGroupCardProps {
    groupId: string;
    memberCount: number;
    memberAssetIds: string[];
    previewUris?: readonly string[];
    isProcessed?: boolean;
    protectedCount?: number;
    onIgnore?: () => void;
    onPress: (layout?: { x: number; y: number; width: number; height: number }) => void;
}

export function SimilarGroupCard({
    memberCount,
    memberAssetIds,
    previewUris,
    isProcessed = false,
    protectedCount = 0,
    onIgnore,
    onPress,
}: SimilarGroupCardProps) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const thumbnailKey = JSON.stringify(memberAssetIds.slice(0, 4));
    const [thumbnailSnapshot, setThumbnailSnapshot] = useState<{ key: string; uris: string[] } | null>(null);
    const thumbnails = previewUris !== undefined
        ? previewUris.slice(0, 2)
        : thumbnailSnapshot?.key === thumbnailKey ? thumbnailSnapshot.uris : [];
    const containerRef = React.useRef<View>(null);
    const loadRequestIdRef = React.useRef(0);

    const handlePress = () => {
        containerRef.current?.measureInWindow((x, y, width, height) => {
            onPress({ x, y, width, height });
        });
    };

    const loadThumbnails = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        if (previewUris !== undefined) return;
        setThumbnailSnapshot(null);
        // Keep the existing small thumbnail lookup snapshot, resolved in one batch.
        const idsToLoad = memberAssetIds.slice(0, 4);
        const infos = await getReadableMediaInfos(idsToLoad, 'photo', { shouldDownloadFromNetwork: false });
        const uris: string[] = [];
        for (const assetId of idsToLoad) {
            const info = infos.get(assetId);
            if (info?.id === assetId && info.mediaType === 'photo' && (info.localUri || info.uri)) {
                uris.push(info.localUri || info.uri);
            }
        }
        if (requestId === loadRequestIdRef.current) {
            setThumbnailSnapshot({ key: thumbnailKey, uris });
        }
    }, [memberAssetIds, previewUris, thumbnailKey]);

    useEffect(() => {
        loadThumbnails();
        return () => {
            loadRequestIdRef.current += 1;
        };
    }, [loadThumbnails]);

    const cardButton = (
        <Pressable
            ref={containerRef}
            collapsable={false}
            accessibilityRole="button"
            accessibilityLabel={`${t('similar_group_detail_title')}, ${t('scan_photo_count', { count: memberCount })}${isProcessed ? `, ${t('similar_group_processed')}` : ''}`}
            style={({ pressed }) => [
                styles.container,
                onIgnore ? styles.containerInRow : { borderBottomColor: colors.divider },
                { backgroundColor: pressed ? colors.surfaceHover : 'transparent' },
            ]}
            onPress={handlePress}
        >
            <View style={styles.previews}>
                {[0, 1].map(index => (
                    <View key={index} style={[styles.thumbnail, { backgroundColor: colors.surfaceHover }]}>
                        {thumbnails[index] && <Image source={{ uri: thumbnails[index] }} cachePolicy="memory" contentFit="cover" style={styles.image} />}
                    </View>
                ))}
            </View>
            <View style={styles.info}>
                <Text style={[styles.title, { color: colors.text }]}>{t('similar_group_detail_title')}</Text>
                <Text style={[styles.count, { color: colors.textSecondary }]}>{t('scan_photo_count', { count: memberCount })}</Text>
                {protectedCount > 0 && (
                    <View style={styles.processed}>
                        <Ionicons name="shield-checkmark-outline" size={14} color={colors.primary} />
                        <Text style={[styles.count, { color: colors.primary }]}>{t('similar_protected_count', { count: protectedCount })}</Text>
                    </View>
                )}
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

    if (!onIgnore) {
        return cardButton;
    }

    return (
        <View style={[styles.rowWrapper, { borderBottomColor: colors.divider }]}>
            {cardButton}
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('similar_not_similar_hide')}
                onPress={onIgnore}
                style={({ pressed }) => [
                    styles.ignoreButton,
                    { backgroundColor: pressed ? colors.surfaceHover : colors.surface },
                ]}
            >
                <Ionicons name="eye-off-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.ignoreLabel, { color: colors.textSecondary }]}>{t('similar_not_similar_short')}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    rowWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: UI_METRICS.touchTarget,
        paddingVertical: 16,
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    containerInRow: {
        flex: 1,
        minWidth: 0,
        borderBottomWidth: 0,
    },
    ignoreButton: {
        minHeight: UI_METRICS.touchTarget,
        minWidth: UI_METRICS.touchTarget,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        flexShrink: 0,
    },
    ignoreLabel: {
        ...TYPOGRAPHY.caption,
    },
    previews: { flexDirection: 'row', gap: 4, flexShrink: 0 },
    thumbnail: { width: 48, height: 64, borderRadius: 8, overflow: 'hidden' },
    image: { width: '100%', height: '100%' },
    info: { flex: 1, minWidth: 0, gap: 4 },
    title: { ...TYPOGRAPHY.button },
    count: { ...TYPOGRAPHY.secondary },
    processed: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
