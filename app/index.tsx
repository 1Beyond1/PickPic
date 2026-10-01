import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';

export default function Index() {
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const [permissionResponse, requestPermission, getPermission] = MediaLibrary.usePermissions({
        // Photo organizing and AI scanning are the app's required core path.
        // Video access is requested separately when the video tab is opened;
        // denying it must not block the photo workflow on Android 13+.
        granularPermissions: ['photo'],
    });
    const [checking, setChecking] = useState(true);
    const [requesting, setRequesting] = useState(false);
    const [actionError, setActionError] = useState<'permission_request_failed' | 'permission_settings_failed' | null>(null);
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();

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
                void getPermission().catch(error => {
                    console.error('Failed to refresh media permission', error);
                });
            }
        });

        return () => subscription.remove();
    }, [getPermission]);

    const handleRequestPermission = async () => {
        setActionError(null);
        if (permissionResponse?.canAskAgain === false) {
            try {
                await Linking.openSettings();
            } catch (error) {
                console.error('Failed to open system settings', error);
                setActionError('permission_settings_failed');
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
            setActionError('permission_request_failed');
        } finally {
            setRequesting(false);
        }
    };

    const canAskAgain = permissionResponse?.canAskAgain !== false;
    const buttonLabel = requesting
        ? t('permission_requesting')
        : canAskAgain ? t('permission_btn') : t('permission_open_settings');

    if (checking || !permissionResponse) {
        return (
            <View style={[styles.container, styles.loading, { backgroundColor: colors.background }]}>
                <StatusBar style={isDark ? 'light' : 'dark'} />
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <StatusBar style={isDark ? 'light' : 'dark'} />
            <ScrollView
                contentContainerStyle={[styles.scrollContent, {
                    paddingTop: insets.top + 24,
                    paddingBottom: insets.bottom + 24,
                    paddingLeft: UI_METRICS.pageInset + insets.left,
                    paddingRight: UI_METRICS.pageInset + insets.right,
                }]}
            >
                <View style={styles.content}>
                    <Text style={[styles.brand, { color: colors.textSecondary }]}>PickPic</Text>
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('permission_title')}</Text>
                    <Text style={[styles.description, { color: colors.textSecondary }]}>
                        {canAskAgain
                            ? t('permission_desc')
                            : t('permission_denied_desc')}
                    </Text>
                    {actionError && (
                        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.error, { color: colors.danger }]}>
                            {t(actionError)}
                        </Text>
                    )}
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={buttonLabel}
                        accessibilityState={{ disabled: requesting, busy: requesting }}
                        style={({ pressed }) => [
                            styles.button,
                            { opacity: pressed || requesting ? 0.8 : 1, backgroundColor: colors.actionBackground },
                        ]}
                        onPress={handleRequestPermission}
                        disabled={requesting}
                    >
                        <Text style={[styles.buttonText, { color: colors.actionForeground }]}>
                            {buttonLabel}
                        </Text>
                    </Pressable>
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    loading: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    scrollContent: {
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    content: {
        width: '100%',
        maxWidth: 480,
    },
    brand: { ...TYPOGRAPHY.secondary, marginBottom: 16 },
    title: {
        ...TYPOGRAPHY.pageTitle,
        marginBottom: 12,
    },
    description: {
        ...TYPOGRAPHY.body,
        marginBottom: 24,
    },
    error: { ...TYPOGRAPHY.secondary, marginBottom: 16 },
    button: {
        minHeight: UI_METRICS.buttonHeight,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderRadius: UI_METRICS.buttonRadius,
        width: '100%',
        alignItems: 'center',
    },
    buttonText: {
        ...TYPOGRAPHY.button,
        textAlign: 'center',
    },
});
