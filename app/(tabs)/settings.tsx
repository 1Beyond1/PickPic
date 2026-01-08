import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlbumSelector } from '../../components/AlbumSelector';
import { GlassContainer } from '../../components/GlassContainer';
import { COLORS, SPACING } from '../../constants/theme';

import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { APP_VERSION, useSettingsStore } from '../../stores/useSettingsStore';

const SettingItem = ({ label, value, onValueChange, type = 'switch', options = [], colors, isDark, fonts }: any) => {
    return (
        <View style={styles.item}>
            <Text style={[styles.label, { color: colors.text, fontFamily: fonts?.ui }]}>{label}</Text>
            {type === 'switch' ? (
                <Switch
                    value={value}
                    onValueChange={onValueChange}
                    trackColor={{ false: isDark ? '#333' : '#E0E0E0', true: colors.primary }}
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
                                    isSelected && { backgroundColor: colors.primary },
                                    !isSelected && { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.optionText,
                                        { color: isSelected ? '#FFF' : colors.textSecondary, fontFamily: fonts?.ui },
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
    const fonts = undefined; // Custom fonts feature removed

    const {
        groupSize, setGroupSize,
        displayOrder, setDisplayOrder,
        theme, setTheme,
        language, setLanguage,
        selectedAlbumIds, setSelectedAlbums
    } = useSettingsStore();

    const {
        photoProcessedIds, videoProcessedIds,
        resetPhotoProgress, resetVideoProgress,
        totalPhotos, totalVideos
    } = useMediaStore();

    const [showAlbumSelector, setShowAlbumSelector] = useState(false);

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

    const handleAlbumConfirm = (ids: string[]) => {
        setSelectedAlbums(ids);
        setShowAlbumSelector(false);
    };

    const glassTint = isDark ? 'dark' : 'light';

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>{t('settings_title')}</Text>

            <ScrollView contentContainerStyle={styles.content}>
                {/* Group Size */}
                <GlassContainer style={styles.section}>
                    <SettingItem
                        label={t('settings_group_size')}
                        type="select"
                        value={groupSize}
                        onValueChange={setGroupSize}
                        options={[10, 20, 30]}
                        colors={colors}
                        isDark={isDark}
                        fonts={fonts}
                    />
                </GlassContainer>

                {/* Album Filter */}
                <GlassContainer style={styles.section}>
                    <Pressable style={styles.item} onPress={() => setShowAlbumSelector(true)}>
                        <Text style={[styles.label, { color: colors.text }]}>{t('settings_album_filter' as any)}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={[styles.optionText, { color: colors.textSecondary, marginRight: 4 }]}>
                                {selectedAlbumIds.length === 0
                                    ? t('album_filter_all' as any)
                                    : t('album_filter_selected' as any, { count: selectedAlbumIds.length })}
                            </Text>
                            <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                        </View>
                    </Pressable>
                </GlassContainer>

                {/* Display Order */}
                <GlassContainer style={styles.section}>
                    <View style={styles.item}>
                        <Text style={[styles.label, { color: colors.text }]}>{t('settings_display_order')}</Text>
                    </View>
                    <View style={styles.optionsContainer}>
                        {(['newest', 'oldest', 'random'] as const).map((order) => {
                            const isSelected = displayOrder === order;
                            const labelKey = order === 'newest' ? 'display_order_newest'
                                : order === 'oldest' ? 'display_order_oldest'
                                    : 'display_order_random';
                            return (
                                <Pressable
                                    key={order}
                                    onPress={() => setDisplayOrder(order)}
                                    style={[
                                        styles.optionButton,
                                        isSelected && { backgroundColor: colors.primary },
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
                                        {t(labelKey as any)}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </GlassContainer>

                {/* Theme */}
                <GlassContainer style={styles.section}>
                    <SettingItem
                        label={t('settings_theme')}
                        type="select"
                        value={theme}
                        onValueChange={setTheme}
                        options={['WarmTerra', 'light', 'dark']}
                        colors={colors}
                        isDark={isDark}
                        fonts={fonts}
                    />
                </GlassContainer>

                {/* Language */}
                <GlassContainer style={styles.section}>
                    <SettingItem
                        label={t('settings_language')}
                        type="select"
                        value={language}
                        onValueChange={setLanguage}
                        options={['zh', 'en']}
                        colors={colors}
                        isDark={isDark}
                        fonts={fonts}
                    />
                </GlassContainer>

                {/* Photo Progress */}
                <GlassContainer style={styles.section}>
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
                <GlassContainer style={styles.section}>
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

                {/* Developer Options */}
                <GlassContainer style={styles.section}>
                    <Pressable
                        style={styles.devOptionsHeader}
                        onPress={() => useSettingsStore.getState().toggleDevOptions()}
                    >
                        <View>
                            <Text style={[styles.label, { color: colors.text }]}>{t('settings_dev_options' as any)}</Text>
                            <Text style={[styles.hintText, { color: colors.textTertiary }]}>{t('settings_dev_options_hint' as any)}</Text>
                        </View>
                        <Ionicons
                            name={useSettingsStore.getState().showDevOptions ? "chevron-up" : "chevron-down"}
                            size={20}
                            color={colors.textSecondary}
                        />
                    </Pressable>

                    {useSettingsStore.getState().showDevOptions && (
                        <View style={styles.devOptionsContent}>
                            <View style={styles.divider} />
                            {/* Developer options content removed */}
                        </View>
                    )}
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

            {/* Album Selector Modal */}
            <AlbumSelector
                visible={showAlbumSelector}
                onClose={() => setShowAlbumSelector(false)}
                onConfirm={handleAlbumConfirm}
                initialSelection={selectedAlbumIds}
            />
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
    },
    devOptionsHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 4,
    },
    devOptionsContent: {
        marginTop: SPACING.s,
    },
    divider: {
        height: 1,
        backgroundColor: 'rgba(0,0,0,0.1)',
        marginVertical: SPACING.s,
    },
});
