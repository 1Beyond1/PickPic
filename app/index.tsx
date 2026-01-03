import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { GlassContainer } from '../components/GlassContainer';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';

export default function Index() {
    const router = useRouter();
    const [permissionResponse, requestPermission] = MediaLibrary.usePermissions();
    const [checking, setChecking] = useState(true);

    useEffect(() => {
        checkPermissions();
    }, [permissionResponse]);

    const checkPermissions = async () => {
        if (!permissionResponse) {
            // Permissions are still loading
            return;
        }

        if (permissionResponse.granted) {
            // Small delay for smooth transition
            setTimeout(() => {
                router.replace('/(tabs)/photos');
            }, 500);
        } else {
            setChecking(false);
        }
    };

    const handleRequestPermission = async () => {
        const { granted } = await requestPermission();
        if (granted) {
            router.replace('/(tabs)/photos');
        }
    };

    if (checking || !permissionResponse) {
        return (
            <View style={styles.container}>
                <StatusBar style="light" />
                <ActivityIndicator size="large" color={COLORS.primary} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <StatusBar style="light" />
            <GlassContainer style={styles.card} intensity={40}>
                <Text style={styles.title}>需访问权限</Text>
                <Text style={styles.description}>
                    PickPic 需要访问您的照片库以帮助您整理照片和视频。
                </Text>
                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        { opacity: pressed ? 0.8 : 1 },
                    ]}
                    onPress={handleRequestPermission}
                >
                    <Text style={styles.buttonText}>授予权限</Text>
                </Pressable>
            </GlassContainer>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
        justifyContent: 'center',
        alignItems: 'center',
        padding: SPACING.l,
    },
    card: {
        padding: SPACING.xl,
        width: '100%',
        alignItems: 'center',
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: COLORS.white,
        marginBottom: SPACING.m,
    },
    description: {
        fontSize: 16,
        color: COLORS.textSecondary,
        textAlign: 'center',
        marginBottom: SPACING.xl,
        lineHeight: 24,
    },
    button: {
        backgroundColor: COLORS.primary,
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.xl,
        borderRadius: BORDER_RADIUS.full,
        width: '100%',
        alignItems: 'center',
    },
    buttonText: {
        color: COLORS.white,
        fontSize: 16,
        fontWeight: '600',
    },
});
