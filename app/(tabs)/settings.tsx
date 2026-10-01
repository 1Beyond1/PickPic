import { Feather, Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlbumSelector } from '../../components/AlbumSelector';
import { ConfirmationSheet } from '../../components/ConfirmationSheet';
import { GlassContainer } from '../../components/GlassContainer';
import { ScanBatchModal } from '../../components/ScanBatchModal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { SettingsRow } from '../../components/SettingsRow';
import { SettingsChoiceSheet } from '../../components/SettingsChoiceSheet';
import { SPACING, TYPOGRAPHY, UI_METRICS } from '../../constants/theme';

import { useAIScanner } from '../../hooks/useAIScanner';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { APP_VERSION, useSettingsStore } from '../../stores/useSettingsStore';

const SettingItem = ({ label, value, onValueChange, type = 'switch', options = [], colors, isDark, fonts, formatOption = (option: any) => option }: any) => {
    return (
        <View style={styles.item}>
            <Text style={[styles.label, { color: colors.text, fontFamily: fonts?.ui }]}>{label}</Text>
            {type === 'switch' ? (
                <Switch
                    value={value}
                    onValueChange={onValueChange}
                    trackColor={{ false: colors.surfaceHover, true: colors.actionBackground }}
                    thumbColor={value && isDark ? colors.actionForeground : '#FFF'}
                />
            ) : (
                <SegmentedControl
                    label={label}
                    value={value}
                    options={options.map((opt: string | number) => ({ value: opt, label: String(formatOption(opt)) }))}
                    onChange={onValueChange}
                />
            )}
        </View>
    );
};

export default function SettingsScreen() {
    const insets = useSafeAreaInsets();
    const { width, fontScale } = useWindowDimensions();
    const compactStats = width < 360 || fontScale >= 1.3;
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();
    const fonts = undefined; // Custom fonts feature removed
    const aiClassificationAvailable = Platform.OS !== 'web';

    const {
        groupSize, setGroupSize,
        displayOrder, setDisplayOrder,
        theme, setTheme,
        language, setLanguage,
        selectedAlbumIds, setSelectedAlbums,
        showDevOptions, enableAIClassification, setEnableAIClassification,
        hasHydrated: settingsHydrated,
    } = useSettingsStore();

    const {
        photoProcessedIds, videoProcessedIds,
        resetPhotoProgress, resetVideoProgress,
        totalPhotos, totalVideos, refreshTotalCounts,
        hasHydrated: mediaHydrated, getVisibleProcessedCounts, mediaLibraryRefreshVersion,
        isConfirmingDeletion, isConfirmingVideoTrash,
    } = useMediaStore();

    const [showAlbumSelector, setShowAlbumSelector] = useState(false);
    const [showScanBatchModal, setShowScanBatchModal] = useState(false);
    const [page, setPage] = useState<'main' | 'scanner' | 'data' | 'help'>('main');
    const [choice, setChoice] = useState<'order' | 'theme' | 'language' | null>(null);

    // AI Scanner hook
    const { progress, isRunning, isFinalizing, lastError, start, stop, resumeOnce, resetScan } = useAIScanner();
    const scannerBusy = isRunning || isFinalizing;

    const handleResetPhotoProgress = () => {
        setShowResetPhotosConfirm(true);
    };

    const handleResetVideoProgress = () => {
        setShowResetVideosConfirm(true);
    };

    const handleOpenGitHub = async (project = false) => {
        try {
            await Linking.openURL(project ? 'https://github.com/1Beyond1/PickPic' : 'https://github.com/1Beyond1');
        } catch (error) {
            console.error('[Settings] Failed to open GitHub:', error);
        }
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
    const [isResettingScanner, setIsResettingScanner] = useState(false);
    const [visibleProcessedCounts, setVisibleProcessedCounts] = useState({ photos: 0, videos: 0 });

    useFocusEffect(useCallback(() => {
        void refreshTotalCounts();
    }, [refreshTotalCounts]));

    useFocusEffect(useCallback(() => {
        let active = true;

        // These values intentionally participate in the callback identity:
        // a reset, media-library event, or permission change must trigger a
        // fresh intersection with the currently visible asset IDs.
        void mediaLibraryRefreshVersion;
        void photoProcessedIds;
        void videoProcessedIds;

        if (!mediaHydrated) {
            return () => {
                active = false;
            };
        }

        void getVisibleProcessedCounts()
            .then(counts => {
                if (active) setVisibleProcessedCounts(counts);
            })
            .catch(error => {
                if (!active) return;
                console.error('[Settings] Failed to refresh visible progress:', error);
                // Do not expose a stale count after a permission/read error.
                setVisibleProcessedCounts({ photos: 0, videos: 0 });
            });

        return () => {
            active = false;
        };
    }, [getVisibleProcessedCounts, mediaHydrated, mediaLibraryRefreshVersion, photoProcessedIds, videoProcessedIds]));

    useFocusEffect(useCallback(() => {
        const onBackPress = () => {
            // Close only the topmost custom overlay. Native Modal instances
            // handle their own Android back events through onRequestClose.
            if (showResetVideosConfirm) {
                setShowResetVideosConfirm(false);
                return true;
            }
            if (showResetPhotosConfirm) {
                setShowResetPhotosConfirm(false);
                return true;
            }
            if (showResetModalStatusConfirm) {
                setShowResetSuccess(false);
                setShowResetModalStatusConfirm(false);
                return true;
            }
            if (showResetConfirm) {
                setShowResetConfirm(false);
                return true;
            }
            if (showAIWarningModal) {
                setShowAIWarningModal(false);
                return true;
            }
            if (choice) {
                setChoice(null);
                return true;
            }
            if (page !== 'main') {
                setPage('main');
                return true;
            }
            return false;
        };

        const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
        return () => subscription.remove();
    }, [showAIWarningModal, showResetConfirm, showResetModalStatusConfirm, showResetPhotosConfirm, showResetVideosConfirm, choice, page]));

    const handleResetScanner = () => {
        setShowResetConfirm(true);
    };

    const confirmResetScanner = async () => {
        if (isResettingScanner) return;

        setShowResetConfirm(false);
        setIsResettingScanner(true);
        try {
            await resetScan();
        } catch (error) {
            console.error('[Settings] Failed to reset scanner', error);
            Alert.alert(
                language === 'zh' ? '重置失败' : 'Reset failed',
                language === 'zh'
                    ? '扫描器未能及时停止，进度尚未重置，请稍后重试。'
                    : 'The scanner did not stop in time, so progress was not reset. Please try again.'
            );
        } finally {
            setIsResettingScanner(false);
        }
    };

    const handleScanBatch = async (options: { mode: 'album' | 'count'; albumIds?: string[]; count?: number }) => {
        if (isResettingScanner || isFinalizing) return;
        console.log('[Settings] Scan batch with options:', options);
        await resumeOnce(options);
    };

    const handleToggleAIClassification = (value: boolean) => {
        if (!aiClassificationAvailable) return;
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

    const choiceTitle = choice === 'order' ? t('settings_display_order')
        : choice === 'theme' ? t('settings_theme') : t('settings_language');
    const choiceValue = choice === 'order' ? displayOrder : choice === 'theme' ? theme : language;
    const choiceOptions = choice === 'order'
        ? (['newest', 'oldest', 'random'] as const).map(value => ({ value, label: t(`display_order_${value}`) }))
        : choice === 'theme'
            ? (['light', 'dark'] as const).map(value => ({ value, label: t(`theme_${value}`) }))
            : [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }];
    const handleChoice = (value: string) => {
        if (choice === 'order' && (value === 'newest' || value === 'oldest' || value === 'random')) setDisplayOrder(value);
        if (choice === 'theme' && (value === 'light' || value === 'dark')) setTheme(value);
        if (choice === 'language' && (value === 'zh' || value === 'en')) setLanguage(value);
        setChoice(null);
    };

    if (!settingsHydrated || !mediaHydrated) {
        return (
            <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
            <View style={styles.pageHeader}>
                {page !== 'main' && <Pressable accessibilityRole="button" accessibilityLabel={t('settings_back')} onPress={() => setPage('main')} style={styles.backButton}>
                    <Feather name="chevron-left" size={23} color={colors.text} />
                </Pressable>}
                <Text accessibilityRole="header" style={[styles.headerTitle, { color: colors.text }]}>{t(page === 'main' ? 'settings_title' : page === 'scanner' ? 'settings_scan_management' : page === 'data' ? 'settings_data_management' : 'settings_help')}</Text>
            </View>

            <ScrollView key={page} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + UI_METRICS.dockHeight + 24 }]} showsVerticalScrollIndicator={false}>
                {page === 'main' && <>
                <Text style={[styles.groupCaption, { color: colors.textSecondary }]}>{t('settings_organizing_preferences')}</Text>
                <GlassContainer style={styles.section} elevated={false}>
                    <SettingItem
                        label={t('settings_group_size')}
                        type="select"
                        value={groupSize}
                        onValueChange={setGroupSize}
                        options={[10, 20, 30]}
                        formatOption={(count: number) => t('settings_group_count', { count })}
                        colors={colors}
                        isDark={isDark}
                        fonts={fonts}
                    />
                    <View style={[styles.preferenceDivider, { backgroundColor: colors.divider }]} />
                    <SettingsRow label={t('settings_album_filter')} value={selectedAlbumIds.length === 0 ? t('album_filter_all') : t('album_filter_selected', { count: selectedAlbumIds.length })} onPress={() => setShowAlbumSelector(true)} />
                    <View style={[styles.preferenceDivider, { backgroundColor: colors.divider }]} />
                    <SettingsRow label={t('settings_display_order')} value={t(`display_order_${displayOrder}`)} onPress={() => setChoice('order')} />
                </GlassContainer>

                <Text style={[styles.groupCaption, { color: colors.textSecondary }]}>{t('settings_appearance_language')}</Text>
                <GlassContainer style={styles.section} elevated={false}>
                    <SettingsRow label={t('settings_theme')} value={t(`theme_${theme}`)} onPress={() => setChoice('theme')} />
                    <View style={[styles.preferenceDivider, { backgroundColor: colors.divider }]} />
                    <SettingsRow label={t('settings_language')} value={language === 'zh' ? '中文' : 'English'} onPress={() => setChoice('language')} />
                </GlassContainer>

                <Text style={[styles.groupCaption, { color: colors.textSecondary }]}>{t('settings_intelligent_analysis')}</Text>
                <GlassContainer style={styles.section} elevated={false}>
                    <View style={styles.item}>
                        <View style={{ flex: 1, minWidth: 180 }}>
                            <Text style={[styles.label, { color: colors.text }]}>{t('settings_enable_ai_classification')}</Text>
                            <Text style={[styles.hintText, { color: colors.textSecondary }]}>{t(aiClassificationAvailable ? 'settings_enable_ai_classification_hint' : 'settings_classification_native_only')}</Text>
                        </View>
                        <Switch accessibilityLabel={t('settings_enable_ai_classification')} value={enableAIClassification} onValueChange={handleToggleAIClassification} disabled={scannerBusy || !aiClassificationAvailable} trackColor={{ false: colors.surfaceHover, true: colors.actionBackground }} thumbColor={enableAIClassification && isDark ? colors.actionForeground : '#FFF'} />
                    </View>
                    <View style={[styles.preferenceDivider, { backgroundColor: colors.divider }]} />
                    <SettingsRow label={t('settings_scan_management')} value={scannerBusy ? t('scan_organizing') : t('settings_scanned_count', { count: progress.totalDone })} onPress={() => setPage('scanner')} />
                </GlassContainer>

                <Text style={[styles.groupCaption, { color: colors.textSecondary }]}>{t('settings_records_maintenance')}</Text>
                <GlassContainer style={styles.section} elevated={false}>
                    <SettingsRow label={t('settings_data_management')} detail={t('settings_data_management_hint')} onPress={() => setPage('data')} />
                </GlassContainer>
                </>}

                {/* AI Scanner Engine */}
                {page === 'scanner' && <>
                <GlassContainer style={styles.section} elevated={false}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('ai_scanner_engine')}</Text>

                    {/* Progress Stats */}
                    <View testID="scanner-stats" style={[styles.scannerStats, compactStats && styles.scannerStatsCompact]}>
                        <View style={[styles.statItem, compactStats && styles.statItemCompact]}>
                            <Text style={[styles.statValue, { color: colors.text }]}>{progress.totalPending}</Text>
                            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('ai_scanner_pending')}</Text>
                        </View>
                        <View style={[styles.statItem, compactStats && styles.statItemCompact]}>
                            <Text style={[styles.statValue, { color: colors.text }]}>{progress.totalDone}</Text>
                            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('ai_scanner_done')}</Text>
                        </View>
                        <View style={[styles.statItem, compactStats && styles.statItemCompact]}>
                            <Text style={[styles.statValue, { color: progress.totalError > 0 ? colors.danger : colors.text }]}>{progress.totalError}</Text>
                            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('ai_scanner_failed' as any)}</Text>
                        </View>
                    </View>

                    {/* Status */}
                    {scannerBusy && (
                        <View style={styles.statusRow}>
                            <Ionicons name="sync" size={16} color={colors.primary} />
                            <Text style={[styles.statusText, { color: colors.primary }]}>
                                {isFinalizing
                                    ? (language === 'zh' ? '正在完成扫描…' : 'Finishing scan…')
                                    : t('ai_scanner_scanning_batch', { batch: progress.currentBatch })}
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
                            accessibilityRole="button"
                            accessibilityLabel={isRunning ? t('ai_scanner_stop') : t('ai_scanner_start')}
                            accessibilityState={{ disabled: isResettingScanner || isFinalizing, busy: isResettingScanner || isFinalizing }}
                            style={({ pressed }) => [
                                styles.scanButton,
                                { backgroundColor: isRunning ? colors.dangerBackground : colors.actionBackground },
                                (pressed || isResettingScanner || isFinalizing) && { opacity: 0.5 }
                            ]}
                            onPress={isRunning ? stop : start}
                            disabled={isResettingScanner || isFinalizing}
                        >
                            <Ionicons
                                name={isRunning ? "stop" : "play"}
                                size={18}
                                color={isRunning ? colors.dangerForeground : colors.actionForeground}
                                style={{ marginRight: 6 }}
                            />
                            <Text style={[styles.scanButtonText, { color: isRunning ? colors.dangerForeground : colors.actionForeground }]}>
                                {isRunning ? t('ai_scanner_stop') : t('ai_scanner_start')}
                            </Text>
                        </Pressable>

                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ disabled: scannerBusy || isResettingScanner }}
                            style={({ pressed }) => [
                                styles.scanButton,
                                { backgroundColor: colors.surface },
                                (pressed || isResettingScanner || isFinalizing) && { opacity: 0.5 }
                            ]}
                            onPress={() => setShowScanBatchModal(true)}
                            disabled={scannerBusy || isResettingScanner}
                        >
                            <Text style={[styles.scanButtonText, { color: colors.text }]}>{t('scan_batch' as any)}</Text>
                        </Pressable>
                    </View>

                </GlassContainer>
                </>}

                {/* Photo Progress */}
                {page === 'data' && <>
                <Text style={[styles.pageHint, { color: colors.textSecondary }]}>{t('settings_data_management_hint')}</Text>
                <GlassContainer style={styles.section} elevated={false}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings_photo_records')}</Text>
                    <View style={styles.progressRow}>
                        <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                            {t('settings_progress_photos', { processed: visibleProcessedCounts.photos, total: totalPhotos })}
                        </Text>
                    </View>
                    <SettingsRow label={t('settings_reset_photos')} danger onPress={handleResetPhotoProgress} disabled={isConfirmingDeletion} />
                </GlassContainer>

                {/* Video Progress */}
                <GlassContainer style={styles.section} elevated={false}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings_video_records')}</Text>
                    <View style={styles.progressRow}>
                        <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                            {t('settings_progress_videos', { processed: visibleProcessedCounts.videos, total: totalVideos })}
                        </Text>
                    </View>
                    <SettingsRow label={t('settings_reset_videos')} danger onPress={handleResetVideoProgress} disabled={isConfirmingVideoTrash} />
                </GlassContainer>

                <GlassContainer style={styles.section} elevated={false}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings_scan_records')}</Text>
                    <Text style={[styles.progressText, { color: colors.textSecondary }]}>{t('settings_scanned_count', { count: progress.totalDone })}</Text>
                    <SettingsRow label={t(isResettingScanner ? 'ai_scanner_resetting' : 'ai_scanner_reset')} danger onPress={handleResetScanner} disabled={isResettingScanner} />
                </GlassContainer>
                </>}

                {/* Developer Options */}
                {page === 'main' && <>
                <Text style={[styles.groupCaption, { color: colors.textSecondary }]}>{t('settings_about')}</Text>
                <GlassContainer style={styles.section} elevated={false}>
                    <SettingsRow label={t('settings_version')} value={APP_VERSION} />
                    <View style={[styles.preferenceDivider, { backgroundColor: colors.divider }]} />
                    <SettingsRow label={t('settings_help')} onPress={() => setPage('help')} />
                    <View style={[styles.preferenceDivider, { backgroundColor: colors.divider }]} />
                    <SettingsRow label={t('settings_open_source')} value="GitHub" onPress={() => { void handleOpenGitHub(true); }} />
                    <View style={[styles.preferenceDivider, { backgroundColor: colors.divider }]} />
                    <SettingsRow label={t('announcement_author_title')} value="1Beyond1" onPress={() => { void handleOpenGitHub(); }} />
                </GlassContainer>

                <GlassContainer style={styles.section} elevated={false}>
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

                </>}

                {page === 'help' && <GlassContainer style={styles.section} elevated={false}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('announcement_notice_title')}</Text>
                    {(['announcement_notice_1', 'announcement_notice_2', 'announcement_notice_3'] as const).map(key => <Text key={key} style={[styles.helpText, { color: colors.textSecondary }]}>{t(key)}</Text>)}
                </GlassContainer>}

            </ScrollView>

            <SettingsChoiceSheet visible={choice !== null} title={choiceTitle} value={choiceValue} options={choiceOptions} onSelect={handleChoice} onClose={() => setChoice(null)} />

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

            {showAIWarningModal && (
                <ConfirmationSheet
                    title={t('ai_classification_warning_title')}
                    message={t('ai_classification_warning_message')}
                    cancelLabel={t('ai_classification_warning_cancel')}
                    confirmLabel={t('ai_classification_warning_confirm')}
                    onCancel={() => setShowAIWarningModal(false)}
                    onConfirm={confirmEnableAIClassification}
                />
            )}

            {showResetConfirm && (
                <ConfirmationSheet
                    title={language === 'zh' ? '重置 AI 扫描进度' : 'Reset AI Scanning Progress'}
                    message={t('settings_reset_scan_desc')}
                    confirmLabel={t('settings_confirm_reset')}
                    destructive
                    onCancel={() => setShowResetConfirm(false)}
                    onConfirm={confirmResetScanner}
                />
            )}

            {showResetModalStatusConfirm && (
                <ConfirmationSheet
                    title={showResetSuccess
                        ? (language === 'zh' ? '重置成功' : 'Reset Successful')
                        : (language === 'zh' ? '重置弹窗状态' : 'Reset Modal Status')}
                    message={showResetSuccess ? '' : (language === 'zh' ? '确定要重置公告和 AI 引导弹窗的状态吗？下次启动 App 时它们将重新显示。' : 'Reset status for announcement and AI guide? They will reappear on next launch.')}
                    hideActions={showResetSuccess}
                    confirmLabel={t('confirm')}
                    onCancel={() => { setShowResetSuccess(false); setShowResetModalStatusConfirm(false); }}
                    onConfirm={() => {
                        useSettingsStore.getState().dismissAnnouncement(null as any);
                        useSettingsStore.getState().dismissAIGuide(null as any);
                        setShowResetSuccess(true);
                        setTimeout(() => {
                            setShowResetSuccess(false);
                            setShowResetModalStatusConfirm(false);
                        }, 1500);
                    }}
                />
            )}

            {showResetPhotosConfirm && (
                <ConfirmationSheet
                    title={t('settings_reset_photos')}
                    message={t('settings_reset_photos_desc')}
                    confirmLabel={t('settings_confirm_reset')}
                    destructive
                    confirmDisabled={isConfirmingDeletion}
                    onCancel={() => setShowResetPhotosConfirm(false)}
                    onConfirm={() => {
                        resetPhotoProgress();
                        setShowResetPhotosConfirm(false);
                    }}
                />
            )}

            {showResetVideosConfirm && (
                <ConfirmationSheet
                    title={t('settings_reset_videos')}
                    message={t('settings_reset_videos_desc')}
                    confirmLabel={t('settings_confirm_reset')}
                    destructive
                    confirmDisabled={isConfirmingVideoTrash}
                    onCancel={() => setShowResetVideosConfirm(false)}
                    onConfirm={() => {
                        resetVideoProgress();
                        setShowResetVideosConfirm(false);
                    }}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    headerTitle: {
        ...TYPOGRAPHY.pageTitle,
        flex: 1,
        minWidth: 0,
    },
    pageHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: UI_METRICS.pageInset, paddingVertical: 12, minHeight: 68, gap: 8 },
    backButton: { width: UI_METRICS.touchTarget, height: UI_METRICS.touchTarget, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
    groupCaption: { ...TYPOGRAPHY.secondary, marginTop: 12, marginBottom: 8, marginLeft: 4 },
    pageHint: { ...TYPOGRAPHY.secondary, marginBottom: 18 },
    helpText: { ...TYPOGRAPHY.body, marginBottom: 16 },
    content: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingTop: SPACING.s,
        paddingBottom: 120,
    },
    section: {
        padding: SPACING.m,
        marginBottom: 12,
        borderWidth: 0,
        borderRadius: 18,
    },
    sectionTitle: {
        ...TYPOGRAPHY.sectionTitle,
        marginBottom: 10,
    },
    preferenceDivider: {
        height: StyleSheet.hairlineWidth,
        marginVertical: 0,
    },
    item: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        paddingVertical: SPACING.s,
    },
    label: {
        ...TYPOGRAPHY.body,
    },
    hintText: {
        ...TYPOGRAPHY.secondary,
        marginTop: 4,
    },
    progressRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    progressText: {
        ...TYPOGRAPHY.body,
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
        gap: 4,
    },
    scannerStatsCompact: { flexDirection: 'column', gap: 12 },
    statItemCompact: { flex: 0, flexDirection: 'row-reverse', justifyContent: 'space-between', gap: 12 },
    statLabel: {
        ...TYPOGRAPHY.secondary,
        flexShrink: 1,
    },
    statValue: {
        fontSize: 24,
        lineHeight: 32,
        fontWeight: '500',
        fontVariant: ['tabular-nums'],
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: SPACING.s,
        marginBottom: SPACING.s,
    },
    statusText: {
        ...TYPOGRAPHY.secondary,
        flex: 1,
    },
    errorRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: SPACING.s,
        marginBottom: SPACING.s,
    },
    errorText: {
        ...TYPOGRAPHY.secondary,
        flex: 1,
    },
    scannerActions: {
        flexDirection: 'column',
        gap: SPACING.s,
        marginTop: SPACING.s,
    },
    scanButton: {
        minHeight: UI_METRICS.buttonHeight,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: UI_METRICS.buttonRadius,
    },
    scanButtonText: {
        ...TYPOGRAPHY.button,
        flexShrink: 1,
        textAlign: 'center',
    },
});
