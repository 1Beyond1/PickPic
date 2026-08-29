import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { GlassContainer } from '../components/GlassContainer';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import { useThemeColor } from '../hooks/useThemeColor';

export default function Index() {
    const router = useRouter();
    const [permissionResponse, requestPermission, getPermission] = MediaLibrary.usePermissions({
        granularPermissions: ['photo', 'video'],
    });
    const [checking, setChecking] = useState(true);
    const [requesting, setRequesting] = useState(false);
    const { colors } = useThemeColor();

    const checkPermissions = useCallback(() => {
        if (!permissionResponse) {
            // Permissions are still loading
            return;
        }

        if (permissionResponse.granted) {
            // Small delay for smooth transition
            const timer = setTimeout(() => {
                router.replace('/(tabs)/photos');
            }, 500);
            return () => clearTimeout(timer);
        } else {
            setChecking(false);
        }
    }, [permissionResponse, router]);

    useEffect(() => checkPermissions(), [checkPermissions]);

    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') {
                void getPermission();
            }
        });

        return () => subscription.remove();
    }, [getPermission]);

    const handleRequestPermission = async () => {
        if (permissionResponse?.canAskAgain === false) {
            try {
                await Linking.openSettings();
            } catch (error) {
                console.error('Failed to open system settings', error);
            }
            return;
        }

        setRequesting(true);
        try {
            const { granted } = await requestPermission();
            if (granted) {
                router.replace('/(tabs)/photos');
            }
        } catch (error) {
            console.error('Failed to request media permission', error);
        } finally {
            setRequesting(false);
        }
    };

    const canAskAgain = permissionResponse?.canAskAgain !== false;

    if (checking || !permissionResponse) {
        return (
            <View style={styles.container}>
                <StatusBar style="light" />
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <StatusBar style="light" />
            <GlassContainer style={styles.card}>
                <Text style={styles.title}>需访问权限</Text>
                <Text style={styles.description}>
                    {canAskAgain
                        ? 'PickPic 需要访问您的照片库以帮助您整理照片和视频。'
                        : '照片权限已被系统拒绝，请在系统设置中重新开启。'}
                </Text>
                <Pressable
                    style={({ pressed }) => [
                        styles.button,
                        { opacity: pressed || requesting ? 0.8 : 1, backgroundColor: colors.primary },
                    ]}
                    onPress={handleRequestPermission}
                    disabled={requesting}
                >
                    <Text style={styles.buttonText}>
                        {requesting ? '请求中…' : canAskAgain ? '授予权限' : '打开系统设置'}
                    </Text>
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
