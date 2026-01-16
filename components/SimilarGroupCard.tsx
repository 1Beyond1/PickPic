/**
 * SimilarGroupCard - Card component showing stacked similar photos
 */

import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
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
    groupId,
    memberCount,
    memberAssetIds,
    isProcessed = false,
    onPress,
}: SimilarGroupCardProps) {
    const { colors, isDark } = useThemeColor();
    const { t } = useI18n();
    const [thumbnails, setThumbnails] = useState<string[]>([]);
    const containerRef = React.useRef<View>(null);

    const handlePress = () => {
        containerRef.current?.measureInWindow((x, y, width, height) => {
            onPress({ x, y, width, height });
        });
    };

    useEffect(() => {
        loadThumbnails();
    }, [memberAssetIds]);

    const loadThumbnails = async () => {
        const uris: string[] = [];
        // Load up to 4 thumbnails for stacking effect
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
        setThumbnails(uris);
    };

    const renderStackedCards = () => {
        const stackCount = Math.min(thumbnails.length, 3);
        const cards = [];

        // Render stacked cards (back to front)
        for (let i = stackCount - 1; i >= 0; i--) {
            const offset = (stackCount - 1 - i) * 6;
            const rotation = (i - 1) * 3;
            cards.push(
                <View
                    key={i}
                    style={[
                        styles.stackedCard,
                        {
                            transform: [
                                { translateX: offset },
                                { rotate: `${rotation}deg` },
                            ],
                            zIndex: i,
                            backgroundColor: colors.surface,
                        },
                    ]}
                >
                    {thumbnails[i] && (
                        <Image
                            source={{ uri: thumbnails[i] }}
                            style={styles.stackedImage}
                            resizeMode="cover"
                        />
                    )}
                </View>
            );
        }

        return cards;
    };

    return (
        <Pressable
            ref={containerRef}
            collapsable={false}
            style={[
                styles.container,
                { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#F9F9F9' },
                isProcessed && styles.processedContainer,
            ]}
            onPress={handlePress}
        >
            {/* Stacked Cards */}
            <View style={styles.stackContainer}>
                {renderStackedCards()}
            </View>

            {/* Main Representative Card */}
            <View style={[styles.mainCard, { backgroundColor: colors.surface }]}>
                {thumbnails[0] && (
                    <Image
                        source={{ uri: thumbnails[0] }}
                        style={styles.mainImage}
                        resizeMode="cover"
                    />
                )}
                <View style={[styles.countBadge, { backgroundColor: colors.primary }]}>
                    <Text style={styles.countText}>{memberCount}</Text>
                </View>
            </View>

            {/* Processed Badge */}
            {isProcessed && (
                <View style={[styles.processedBadge, { backgroundColor: colors.success || '#4CAF50' }]}>
                    <Ionicons name="checkmark" size={12} color="#FFF" />
                    <Text style={styles.processedText}>
                        {t('similar_group_processed' as any)}
                    </Text>
                </View>
            )}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 16,
        marginHorizontal: 16,
        marginVertical: 6,
    },
    processedContainer: {
        opacity: 0.6,
    },
    stackContainer: {
        width: 80,
        height: 70,
        position: 'relative',
        marginRight: 16,
    },
    stackedCard: {
        position: 'absolute',
        width: 60,
        height: 70,
        borderRadius: 8,
        shadowColor: '#000',
        shadowOffset: { width: 1, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 3,
        elevation: 3,
        overflow: 'hidden',
    },
    stackedImage: {
        width: '100%',
        height: '100%',
    },
    mainCard: {
        width: 80,
        height: 80,
        borderRadius: 12,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 4,
    },
    mainImage: {
        width: '100%',
        height: '100%',
    },
    countBadge: {
        position: 'absolute',
        bottom: 4,
        right: 4,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
    },
    countText: {
        color: '#FFF',
        fontSize: 12,
        fontWeight: 'bold',
    },
    processedBadge: {
        position: 'absolute',
        top: 8,
        right: 8,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        gap: 4,
    },
    processedText: {
        color: '#FFF',
        fontSize: 11,
        fontWeight: '600',
    },
});
