import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlbumSelector } from '../../components/AlbumSelector';
import { GlassContainer } from '../../components/GlassContainer';
import { ScanBatchModal } from '../../components/ScanBatchModal';
import { COLORS, SPACING } from '../../constants/theme';

import { useAIScanner } from '../../hooks/useAIScanner';
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
        selectedAlbumIds, setSelectedAlbums,
        showDevOptions, enableAIClassification, setEnableAIClassification
    } = useSettingsStore();

    const {
        photoProcessedIds, videoProcessedIds,
        resetPhotoProgress, resetVideoProgress,
        totalPhotos, totalVideos
    } = useMediaStore();

    const [showAlbumSelector, setShowAlbumSelector] = useState(false);
    const [showScanBatchModal, setShowScanBatchModal] = useState(false);

    // AI Scanner hook
    const { progress, isRunning, lastError, start, stop, resumeOnce, resetScan, refreshStatus } = useAIScanner();

    const handleResetPhotoProgress = () => {
        setShowResetPhotosConfirm(true);
    };

    const handleResetVideoProgress = () => {
        setShowResetVideosConfirm(true);
    };

    const handleOpenGitHub = () => {
        Linking.openURL('https://github.com/1Beyond1');
    };

    const handleAlbumConfirm = (ids: string[]) => {
        setSelectedAlbums(ids);
        setShowAlbumSelector(false);
    };

    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [showAIWarningModal, setShowAIWarningModal] = useState(false);
    const [showResetModalStatusConfirm, setShowResetModalStatusConfirm] = useState(false);
    const [showResetSuccess, setShowResetSuccess] = useState(false);
    const [showResetPhotosConfirm, setShowResetPhotosConfirm] = useState(false);
    const [showResetVideosConfirm, setShowResetVideosConfirm] = useState(false);

    const handleResetScanner = () => {
        setShowResetConfirm(true);
    };

    const confirmResetScanner = () => {
        setShowResetConfirm(false);
        resetScan();
    };

    const glassTint = isDark ? 'dark' : 'light';

    const handleScanBatch = (options: { mode: 'album' | 'count'; albumIds?: string[]; count?: number }) => {
        // Start scan with options
        // For now, just call resumeOnce - full implementation can use options.count
        console.log('[Settings] Scan batch with options:', options);
        resumeOnce();
    };

    const handleToggleAIClassification = (value: boolean) => {
        if (value) {
            setShowAIWarningModal(true);
        } else {
            setEnableAIClassification(false);
        }
    };

    const confirmEnableAIClassification = () => {
        setShowAIWarningModal(false);
        setEnableAIClassification(true);
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>{t('settings_title')}</Text>

            <ScrollView contentContainerStyle={styles.content}>
                {/* ... existing content ... */}
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

                {/* AI Scanner Engine */}
                <GlassContainer style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>AI 扫描引擎</Text>

                    {/* Progress Stats */}
                    <View style={styles.scannerStats}>
                        <View style={styles.statItem}>
                            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>待扫描</Text>
                            <Text style={[styles.statValue, { color: colors.text }]}>{progress.totalPending}</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>已完成</Text>
                            <Text style={[styles.statValue, { color: colors.primary }]}>{progress.totalDone}</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('ai_scanner_failed' as any)}</Text>
                            <Text style={[styles.statValue, { color: colors.danger }]}>{progress.totalError}</Text>
                        </View>
                    </View>

                    {/* Status */}
                    {isRunning && (
                        <View style={styles.statusRow}>
                            <Ionicons name="sync" size={16} color={colors.primary} />
                            <Text style={[styles.statusText, { color: colors.primary }]}>
                                扫描中... (批次 {progress.currentBatch})
                            </Text>
                        </View>
                    )}

                    {lastError && (
                        <View style={styles.errorRow}>
                            <Ionicons name="warning" size={16} color={colors.danger} />
                            <Text style={[styles.errorText, { color: colors.danger }]}>
                                {lastError.message}
                            </Text>
                        </View>
                    )}

                    {/* Action Buttons */}
                    <View style={styles.scannerActions}>
                        <Pressable
                            style={({ pressed }) => [
                                styles.scanButton,
                                { backgroundColor: isRunning ? colors.danger : colors.primary },
                                pressed && { opacity: 0.8 }
                            ]}
                            onPress={isRunning ? stop : start}
                            disabled={isRunning && progress.currentBatch === 0}
                        >
                            <Ionicons
                                name={isRunning ? "stop" : "play"}
                                size={18}
                                color="#FFF"
                                style={{ marginRight: 6 }}
                            />
                            <Text style={styles.scanButtonText}>
                                {isRunning ? '停止扫描' : '开始扫描'}
                            </Text>
                        </Pressable>

                        <Pressable
                            style={({ pressed }) => [
                                styles.scanButton,
                                { backgroundColor: colors.surface, flex: 0.4 },
                                pressed && { opacity: 0.8 }
                            ]}
                            onPress={() => setShowScanBatchModal(true)}
                            disabled={isRunning}
                        >
                            <Text style={[styles.scanButtonText, { color: colors.text }]}>{t('scan_batch' as any)}</Text>
                        </Pressable>
                    </View>

                    <Pressable
                        style={({ pressed }) => [
                            styles.resetButton,
                            pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] }
                        ]}
                        onPress={handleResetScanner}
                    >
                        <Text style={styles.resetButtonText}>重置扫描进度</Text>
                    </Pressable>
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
                            name={showDevOptions ? "chevron-up" : "chevron-down"}
                            size={20}
                            color={colors.textSecondary}
                        />
                    </Pressable>

                    {showDevOptions && (
                        <View style={styles.devOptionsContent}>
                            <View style={styles.divider} />
                            {/* AI Classification Toggle */}
                            <View style={styles.item}>
                                <View style={{ flex: 1 }}>
                                    <Text style={[styles.label, { color: colors.text }]}>{t('settings_enable_ai_classification' as any)}</Text>
                                    <Text style={[styles.hintText, { color: colors.textTertiary, fontSize: 12, marginTop: 2 }]}>
                                        {t('settings_enable_ai_classification_hint' as any)}
                                    </Text>
                                </View>
                                <Switch
                                    value={enableAIClassification}
                                    onValueChange={handleToggleAIClassification}
                                    trackColor={{ false: isDark ? '#333' : '#E0E0E0', true: colors.primary }}
                                    thumbColor={isDark ? '#FFF' : '#FFF'}
                                />
                            </View>

                            {/* Reset Modal State Button */}
                            <Pressable
                                style={({ pressed }) => [
                                    styles.item,
                                    { marginTop: 8 },
                                    pressed && { opacity: 0.7 }
                                ]}
                                onPress={() => setShowResetModalStatusConfirm(true)}
                            >
                                <View style={{ flex: 1 }}>
                                    <Text style={[styles.label, { color: colors.text }]}>
                                        {language === 'zh' ? '重置弹窗已读状态' : 'Reset Modal Read Status'}
                                    </Text>
                                    <Text style={[styles.hintText, { color: colors.textTertiary, fontSize: 12, marginTop: 2 }]}>
                                        {language === 'zh' ? '让公告和引导弹窗再次显示' : 'Make announcement and guide show again'}
                                    </Text>
                                </View>
                                <Ionicons name="refresh-circle" size={24} color={colors.primary} />
                            </Pressable>
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

            {/* Scan Batch Modal */}
            <ScanBatchModal
                visible={showScanBatchModal}
                onClose={() => setShowScanBatchModal(false)}
                onStartScan={handleScanBatch}
            />

            {/* Custom AI Warning Modal */}
            {showAIWarningModal && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }]}>
                    <View style={{ width: '80%', backgroundColor: colors.surface, borderRadius: 20, padding: 25, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84, elevation: 5 }}>
                        <View style={{ marginBottom: 15, alignItems: 'center' }}>
                            <Ionicons name="warning" size={48} color={colors.warning} />
                        </View>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text, marginBottom: 10, textAlign: 'center' }}>
                            {t('ai_classification_warning_title' as any)}
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 25, textAlign: 'center', lineHeight: 22 }}>
                            {t('ai_classification_warning_message' as any)}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 12 }}>
                            <Pressable
                                style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F0F0F0', alignItems: 'center' }}
                                onPress={() => setShowAIWarningModal(false)}
                            >
                                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('ai_classification_warning_cancel' as any)}</Text>
                            </Pressable>
                            <Pressable
                                style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center' }}
                                onPress={confirmEnableAIClassification}
                            >
                                <Text style={{ color: '#FFF', fontWeight: 'bold' }}>{t('ai_classification_warning_confirm' as any)}</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            )}

            {/* Custom Reset Confirm Modal */}
            {showResetConfirm && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }]}>
                    <View style={{ width: '80%', backgroundColor: colors.surface, borderRadius: 20, padding: 20, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84, elevation: 5 }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text, marginBottom: 10, textAlign: 'center' }}>
                            {language === 'zh' ? '重置 AI 扫描进度' : 'Reset AI Scanning Progress'}
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 20, textAlign: 'center', lineHeight: 20 }}>
                            {language === 'zh' ? '确定要重置所有扫描进度吗？这将清空所有智能分类结果，需要重新扫描。' : 'Are you sure you want to reset all scanning progress? This will clear all AI categories and require a rescan.'}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            <Pressable
                                style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F0F0F0', alignItems: 'center' }}
                                onPress={() => setShowResetConfirm(false)}
                            >
                                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('cancel')}</Text>
                            </Pressable>
                            <Pressable
                                style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: colors.danger, alignItems: 'center' }}
                                onPress={confirmResetScanner}
                            >
                                <Text style={{ color: 'white', fontWeight: '600' }}>{t('confirm')}</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            )}

            {/* Reset Modal Status Confirm Modal */}
            {showResetModalStatusConfirm && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }]}>
                    <View style={{ width: '80%', backgroundColor: colors.surface, borderRadius: 20, padding: 20, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84, elevation: 5 }}>

                        {!showResetSuccess ? (
                            <>
                                <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text, marginBottom: 10, textAlign: 'center' }}>
                                    {language === 'zh' ? '重置弹窗状态' : 'Reset Modal Status'}
                                </Text>
                                <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 20, textAlign: 'center', lineHeight: 20 }}>
                                    {language === 'zh' ? '确定要重置公告和 AI 引导弹窗的状态吗？下次启动 App 时它们将重新显示。' : 'Reset status for announcement and AI guide? They will reappear on next launch.'}
                                </Text>
                                <View style={{ flexDirection: 'row', gap: 10 }}>
                                    <Pressable
                                        style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F0F0F0', alignItems: 'center' }}
                                        onPress={() => setShowResetModalStatusConfirm(false)}
                                    >
                                        <Text style={{ color: colors.text, fontWeight: '600' }}>{t('cancel')}</Text>
                                    </Pressable>
                                    <Pressable
                                        style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center' }}
                                        onPress={() => {
                                            useSettingsStore.getState().dismissAnnouncement(null as any);
                                            useSettingsStore.getState().dismissAIGuide(null as any);
                                            setShowResetSuccess(true);
                                            setTimeout(() => {
                                                setShowResetSuccess(false);
                                                setShowResetModalStatusConfirm(false);
                                            }, 1500);
                                        }}
                                    >
                                        <Text style={{ color: 'white', fontWeight: '600' }}>{t('confirm')}</Text>
                                    </Pressable>
                                </View>
                            </>
                        ) : (
                            <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                                <Ionicons name="checkmark-circle" size={48} color={colors.primary} style={{ marginBottom: 10 }} />
                                <Text style={{ fontSize: 16, fontWeight: 'bold', color: colors.text }}>
                                    {language === 'zh' ? '重置成功' : 'Reset Successful'}
                                </Text>
                            </View>
                        )}

                    </View>
                </View>
            )}

            {/* Reset Photos Confirm Modal */}
            {showResetPhotosConfirm && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }]}>
                    <View style={{ width: '80%', backgroundColor: colors.surface, borderRadius: 20, padding: 20, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84, elevation: 5 }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text, marginBottom: 10, textAlign: 'center' }}>
                            {t('settings_reset_photos')}
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 20, textAlign: 'center', lineHeight: 20 }}>
                            {t('settings_reset_desc')}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            <Pressable
                                style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F0F0F0', alignItems: 'center' }}
                                onPress={() => setShowResetPhotosConfirm(false)}
                            >
                                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('cancel')}</Text>
                            </Pressable>
                            <Pressable
                                style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: colors.danger, alignItems: 'center' }}
                                onPress={() => {
                                    resetPhotoProgress();
                                    setShowResetPhotosConfirm(false);
                                }}
                            >
                                <Text style={{ color: 'white', fontWeight: '600' }}>{t('confirm')}</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            )}

            {/* Reset Videos Confirm Modal */}
            {showResetVideosConfirm && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }]}>
                    <View style={{ width: '80%', backgroundColor: colors.surface, borderRadius: 20, padding: 20, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84, elevation: 5 }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text, marginBottom: 10, textAlign: 'center' }}>
                            {t('settings_reset_videos')}
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 20, textAlign: 'center', lineHeight: 20 }}>
                            {t('settings_reset_desc')}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            <Pressable
                                style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#F0F0F0', alignItems: 'center' }}
                                onPress={() => setShowResetVideosConfirm(false)}
                            >
                                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('cancel')}</Text>
                            </Pressable>
                            <Pressable
                                style={{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: colors.danger, alignItems: 'center' }}
                                onPress={() => {
                                    resetVideoProgress();
                                    setShowResetVideosConfirm(false);
                                }}
                            >
                                <Text style={{ color: 'white', fontWeight: '600' }}>{t('confirm')}</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            )}
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
        marginTop: SPACING.m,
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
    // AI Scanner styles
    scannerStats: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        marginVertical: SPACING.m,
        gap: SPACING.s,
    },
    statItem: {
        alignItems: 'center',
        flex: 1,
    },
    statLabel: {
        fontSize: 12,
        marginBottom: 4,
    },
    statValue: {
        fontSize: 24,
        fontWeight: 'bold',
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: SPACING.s,
        backgroundColor: 'rgba(0,122,255,0.1)',
        borderRadius: 8,
        marginBottom: SPACING.s,
    },
    statusText: {
        fontSize: 14,
        fontWeight: '500',
    },
    errorRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: SPACING.s,
        backgroundColor: 'rgba(255,59,48,0.1)',
        borderRadius: 8,
        marginBottom: SPACING.s,
    },
    errorText: {
        fontSize: 12,
        flex: 1,
    },
    scannerActions: {
        flexDirection: 'row',
        gap: SPACING.s,
        marginTop: SPACING.s,
    },
    scanButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 14,
        borderRadius: 12,
    },
    scanButtonText: {
        color: '#FFFFFF',
        fontWeight: '600',
        fontSize: 15,
    },
});
