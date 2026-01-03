import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassContainer } from '../../components/GlassContainer';
import { COLORS, SPACING } from '../../constants/theme';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { APP_VERSION, useSettingsStore } from '../../stores/useSettingsStore';

const SettingItem = ({ label, value, onValueChange, type = 'switch', options = [], colors, isDark }: any) => {
    return (
        <View style={styles.item}>
            <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
            {type === 'switch' ? (
                <Switch
                    value={value}
                    onValueChange={onValueChange}
                    trackColor={{ false: isDark ? '#333' : '#E0E0E0', true: '#0A84FF' }}
                    thumbColor={isDark ? '#FFF' : '#FFF'}
                />
            ) : (
                <View style={styles.optionsContainer}>
                    {options.map((opt: any) => {
                        const isSelected = value === opt;
                        return (
                            <Pressable
                                key={opt}
                                onPress={() => onValueChange(opt)}
                                style={[
                                    styles.optionButton,
                                    isSelected && { backgroundColor: '#0A84FF' },
                                    !isSelected && { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.optionText,
                                        { color: isSelected ? '#FFF' : colors.textSecondary },
                                        isSelected && { fontWeight: 'bold' }
                                    ]}
                                >
                                    {opt}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            )}
        </View>
    );
};

export default function SettingsScreen() {
    const insets = useSafeAreaInsets();
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();

    const {
        groupSize, setGroupSize,
        enableRandomDisplay, toggleRandomDisplay,
        theme, setTheme,
        language, setLanguage
    } = useSettingsStore();

    const {
        photoProcessedIds, videoProcessedIds,
        resetPhotoProgress, resetVideoProgress,
        totalPhotos, totalVideos
    } = useMediaStore();

    const handleResetPhotoProgress = () => {
        Alert.alert(
            t('settings_reset_photos'),
            t('settings_reset_desc'),
            [
                { text: t('cancel'), style: "cancel" },
                { text: t('confirm'), onPress: resetPhotoProgress, style: "destructive" }
            ]
        );
    };

    const handleResetVideoProgress = () => {
        Alert.alert(
            t('settings_reset_videos'),
            t('settings_reset_desc'),
            [
                { text: t('cancel'), style: "cancel" },
                { text: t('confirm'), onPress: resetVideoProgress, style: "destructive" }
            ]
        );
    };

    const handleOpenGitHub = () => {
        Linking.openURL('https://github.com/1Beyond1');
    };

    const glassTint = isDark ? 'dark' : 'light';

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>{t('settings_title')}</Text>

            <ScrollView contentContainerStyle={styles.content}>
                {/* Group Size */}
                <GlassContainer style={styles.section} tint={glassTint}>
                    <SettingItem
                        label={t('settings_group_size')}
                        type="select"
                        value={groupSize}
                        onValueChange={setGroupSize}
                        options={[10, 20, 30]}
                        colors={colors}
                        isDark={isDark}
                    />
                </GlassContainer>

                {/* Random Display */}
                <GlassContainer style={styles.section} tint={glassTint}>
                    <SettingItem
                        label={t('settings_random')}
                        value={enableRandomDisplay}
                        onValueChange={toggleRandomDisplay}
                        colors={colors}
                        isDark={isDark}
                    />
                    <Text style={[styles.hintText, { color: colors.textSecondary }]}>
                        {t('random_display_hint')}
                    </Text>
                </GlassContainer>

                {/* Theme */}
                <GlassContainer style={styles.section} tint={glassTint}>
                    <SettingItem
                        label={t('settings_theme')}
                        type="select"
                        value={theme}
                        onValueChange={setTheme}
                        options={['light', 'dark', 'auto']}
                        colors={colors}
                        isDark={isDark}
                    />
                </GlassContainer>

                {/* Language */}
                <GlassContainer style={styles.section} tint={glassTint}>
                    <SettingItem
                        label={t('settings_language')}
                        type="select"
                        value={language}
                        onValueChange={setLanguage}
                        options={['zh', 'en']}
                        colors={colors}
                        isDark={isDark}
                    />
                </GlassContainer>

                {/* Photo Progress */}
                <GlassContainer style={styles.section} tint={glassTint}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('tab_photos')} {t('photos_header')}</Text>
                    <View style={styles.progressRow}>
                        <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                            {t('settings_progress_photos', { processed: photoProcessedIds.length, total: totalPhotos })}
                        </Text>
                    </View>
                    <Pressable
                        style={({ pressed }) => [
                            styles.resetButton,
                            pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] }
                        ]}
                        onPress={handleResetPhotoProgress}
                    >
                        <Text style={styles.resetButtonText}>{t('settings_reset_photos')}</Text>
                    </Pressable>
                </GlassContainer>

                {/* Video Progress */}
                <GlassContainer style={styles.section} tint={glassTint}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('tab_videos')} {t('photos_header')}</Text>
                    <View style={styles.progressRow}>
                        <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                            {t('settings_progress_videos', { processed: videoProcessedIds.length, total: totalVideos })}
                        </Text>
                    </View>
                    <Pressable
                        style={({ pressed }) => [
                            styles.resetButton,
                            pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] }
                        ]}
                        onPress={handleResetVideoProgress}
                    >
                        <Text style={styles.resetButtonText}>{t('settings_reset_videos')}</Text>
                    </Pressable>
                </GlassContainer>

                {/* Footer: Author & Version */}
                <View style={styles.footer}>
                    <Pressable style={styles.githubLink} onPress={handleOpenGitHub}>
                        <Ionicons name="logo-github" size={22} color={colors.textSecondary} style={{ marginRight: 8 }} />
                        <Text style={[styles.footerText, { color: colors.textSecondary, fontWeight: '600' }]}>
                            1Beyond1
                        </Text>
                    </Pressable>
                    <Text style={[styles.versionText, { color: colors.textSecondary }]}>
                        {APP_VERSION}
                    </Text>
                    <Text style={[styles.footerSubText, { color: colors.textSecondary }]}>
                        Open Source Project
                    </Text>
                </View>

            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    headerTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        paddingHorizontal: SPACING.l,
        marginVertical: SPACING.m,
    },
    content: {
        padding: SPACING.m,
        paddingBottom: 120,
    },
    section: {
        padding: SPACING.m,
        marginBottom: SPACING.l,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 10,
    },
    item: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: SPACING.s,
    },
    label: {
        fontSize: 16,
        fontWeight: '500'
    },
    hintText: {
        fontSize: 12,
        marginTop: 4,
        opacity: 0.7,
    },
    optionsContainer: {
        flexDirection: 'row',
        gap: 6,
        backgroundColor: 'transparent',
    },
    optionButton: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 20,
        overflow: 'hidden'
    },
    optionText: {
        fontSize: 12,
    },
    progressRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    progressText: {
        fontSize: 15,
    },
    resetButton: {
        backgroundColor: COLORS.danger,
        padding: 12,
        borderRadius: 12,
        alignItems: 'center',
    },
    resetButtonText: {
        color: '#FFFFFF',
        fontWeight: '600'
    },
    footer: {
        alignItems: 'center',
        marginTop: SPACING.xl,
        marginBottom: 20
    },
    githubLink: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 10,
    },
    footerText: {
        fontSize: 16
    },
    versionText: {
        fontSize: 14,
        marginTop: 8,
        fontWeight: '500',
    },
    footerSubText: {
        fontSize: 11,
        marginTop: 4,
        opacity: 0.6,
    }
});
