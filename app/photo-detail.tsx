import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { ScalablePressable } from '../components/ScalablePressable'; // Import ScalablePressable
import { BORDER_RADIUS, SPACING } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';

export default function PhotoDetailScreen() {
    const router = useRouter();
    const params = useLocalSearchParams();
    const uri = params.uri as string;
    const { colors, isDark } = useThemeColor();

    const handleShare = async () => {
        if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(uri);
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
