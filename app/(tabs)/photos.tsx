import { Feather, Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OrganizingScopeModal } from '../../components/OrganizingScopeModal';
import { PhotoCard } from '../../components/PhotoCard';
import { PendingDeletionButton, PendingDeletionReview } from '../../components/PendingDeletionReview';
import { RecentDecisionsButton, RecentUndoButton } from '../../components/RecentDecisionControls';
import { BORDER_RADIUS, SPACING, TYPOGRAPHY, UI_METRICS } from '../../constants/theme';
import { useI18n } from '../../hooks/useI18n';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useMediaStore } from '../../stores/useMediaStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useShallow } from 'zustand/react/shallow';


export default function PhotosScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { width, height } = useWindowDimensions();
    const previewHeight = Math.min(334, Math.max(230, Math.min(width - 48, (height - insets.top - insets.bottom - 65) * 0.4)));
    const { t } = useI18n();
    const { colors, isDark } = useThemeColor();

    const {
        photos, loadPhotos, isLoading, photoLoadFailed, hasHydrated,
        photoProcessedIds,
        markForDeletion, markAsSkipped,
        deleteQueue, resetBatch, loadAlbums,
        permissionScope, mediaLibraryRefreshVersion,
        permissionRefreshVersion, organizingSessions, startOrganizingSession,
        resumeOrganizingSession, deferSessionMedia, revisitSessionDeferred,
        photoSessionRecoveryStatus, photoSessionUnavailableCount,
    } = useMediaStore(useShallow(state => ({
        photos: state.photos,
        loadPhotos: state.loadPhotos,
        isLoading: state.isLoading,
        photoLoadFailed: state.photoLoadFailed,
        hasHydrated: state.hasHydrated,
        photoProcessedIds: state.photoProcessedIds,
        markForDeletion: state.markForDeletion,
        markAsSkipped: state.markAsSkipped,
        deleteQueue: state.deleteQueue,
        resetBatch: state.resetBatch,
        loadAlbums: state.loadAlbums,
        permissionScope: state.permissionScope,
        mediaLibraryRefreshVersion: state.mediaLibraryRefreshVersion,
        permissionRefreshVersion: state.permissionRefreshVersion,
        organizingSessions: state.organizingSessions,
        startOrganizingSession: state.startOrganizingSession,
        resumeOrganizingSession: state.resumeOrganizingSession,
        deferSessionMedia: state.deferSessionMedia,
        revisitSessionDeferred: state.revisitSessionDeferred,
        photoSessionRecoveryStatus: state.photoSessionRecoveryStatus,
        photoSessionUnavailableCount: state.photoSessionUnavailableCount,
    })));

    const {
        groupSize,
        displayOrder,
        selectedAlbumIds,
        hasHydrated: settingsHydrated,
    } = useSettingsStore();

    const [managingPhotoAccess, setManagingPhotoAccess] = useState(false);
    const [showHome, setShowHome] = useState(true);
    const [showScopeSelector, setShowScopeSelector] = useState(false);
    const [reviewDismissed, setReviewDismissed] = useState(false);
    const [keptAllReviewPhotos, setKeptAllReviewPhotos] = useState(false);
    const [deckSize, setDeckSize] = useState({ width: 0, height: 0 });
    const sessionActionRef = useRef(false);
    const photosFocusedRef = useRef(true);
    const session = organizingSessions.photo;

    useFocusEffect(useCallback(() => {
        photosFocusedRef.current = true;
        if (!hasHydrated || !settingsHydrated) return;
        setKeptAllReviewPhotos(false);
        void loadPhotos(groupSize, displayOrder, selectedAlbumIds);
        void loadAlbums();
        return () => { photosFocusedRef.current = false; };
    }, [
        groupSize,
        displayOrder,
        selectedAlbumIds,
        hasHydrated,
        settingsHydrated,
        loadPhotos,
        loadAlbums,
    ]));

    const handleManagePhotoAccess = useCallback(async () => {
        if (managingPhotoAccess) return;

        setManagingPhotoAccess(true);
        try {
            // Android 14 can report a global limited grant even when the
            // requested media type has no selected assets. The picker lets
            // the user add photos without repeatedly showing a permission
            // prompt for users who already selected some media.
            await MediaLibrary.presentPermissionsPickerAsync(['photo']);
            const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
            const scope = !permission.granted
                ? 'none'
                : permission.accessPrivileges === 'limited'
                    ? 'limited'
                    : 'full';
            const mediaStore = useMediaStore.getState();
            mediaStore.setPermissionScope(scope);
            mediaStore.refreshQueuedAssetVisibility(scope, 'photo');
            mediaStore.pruneUnavailableQueuedAssets(scope, 'photo');
            mediaStore.notifyPermissionRefresh();
            if (!permission.granted) {
                router.replace('/');
                return;
            }
            await Promise.all([
                loadPhotos(groupSize, displayOrder, selectedAlbumIds),
                loadAlbums(),
            ]);
        } catch {
            console.error('[Photos] Failed to manage photo access.');
        } finally {
            setManagingPhotoAccess(false);
        }
    }, [displayOrder, groupSize, loadAlbums, loadPhotos, managingPhotoAccess, router, selectedAlbumIds]);

    const processedIds = new Set(photoProcessedIds);
    const deferredIds = new Set(session?.deferredIds ?? []);
    const visiblePhotos = photos.filter(p => !processedIds.has(p.id) && !deferredIds.has(p.id));
    const deckTotal = session?.assetIds.length ?? photos.length;
    const deckPosition = session ? Math.max(0, session.assetIds.indexOf(visiblePhotos[0]?.id)) + 1 : photos.length - visiblePhotos.length + 1;
    const unresolvedCount = session?.assetIds.slice(session.position).filter(id => !processedIds.has(id) && !deferredIds.has(id)).length ?? 0;
    const sessionUnavailable = photoSessionRecoveryStatus === 'unavailable'
        || (session?.phase === 'organizing' && !isLoading && visiblePhotos.length === 0 && unresolvedCount > 0);
    const sessionReadFailed = photoLoadFailed || photoSessionRecoveryStatus === 'failed';
    const sessionPermissionRequired = photoSessionRecoveryStatus === 'permission';
    const emptyTitle = sessionReadFailed ? 'photos_load_failed' : sessionPermissionRequired ? 'session_permission'
        : sessionUnavailable ? 'session_unavailable' : session?.phase === 'review' ? 'photos_finished' : session?.phase === 'complete'
            ? session.deferredIds.length > 0 ? 'session_rest_complete' : session.scope.order === 'largest' ? 'session_size_complete' : session.scope.albumIds.length > 0 || session.scope.date !== undefined ? 'session_scope_complete' : permissionScope === 'limited' ? 'session_accessible_complete' : 'session_library_complete'
            : permissionScope === 'limited' ? 'photos_limited_access_desc' : 'photos_empty';

    const openSession = async (action: 'start' | 'resume' | 'new' | 'next' | 'deferred') => {
        // Per-session filters must not silently revert to legacy defaults.
        if (action === 'new' && session && (session.scope.date !== undefined || session.scope.order === 'largest')) { setShowScopeSelector(true); return; }
        if (sessionActionRef.current) return;
        sessionActionRef.current = true;
        try {
            if (action === 'start' && !session && visiblePhotos.length > 0) {
                const created = startOrganizingSession('photo', { albumIds: selectedAlbumIds, order: displayOrder }, visiblePhotos.map(photo => photo.id));
                if (!created) return;
            } else if (action === 'resume') {
                const result = await resumeOrganizingSession('photo');
                if (result.status === 'busy' || result.status === 'stale') return;
            } else if (action === 'deferred') {
                if (!revisitSessionDeferred('photo')) return;
                const result = await resumeOrganizingSession('photo');
                if (result.status === 'busy' || result.status === 'stale') return;
            } else {
                await loadPhotos(groupSize, displayOrder, selectedAlbumIds, action === 'next' ? 'continue' : 'new');
            }
            setReviewDismissed(false);
            setShowHome(false);
        } catch {
            showToast(t('session_preserved_hint'));
        } finally { sessionActionRef.current = false; }
    };

    const homeAction = session?.phase === 'organizing' ? 'resume' : session?.phase === 'review' && !reviewDismissed && deleteQueue.length > 0 ? 'resume'
        : session ? 'next' : 'start';
    const homeActionTitle = session?.phase === 'organizing' ? 'session_continue' : session?.phase === 'review' && !reviewDismissed && deleteQueue.length > 0 ? 'session_review'
        : session ? 'session_next_batch' : visiblePhotos.length > 0 ? 'photos_home_start' : 'photos_reload';
    const scopeCaption = session ? t(session.scope.albumIds.length ? 'session_album_scope' : 'session_all_scope', {
        count: session.scope.albumIds.length, order: t(`session_order_${session.scope.order}`),
    }) + (session.scope.date !== undefined ? ` · ${session.scope.date === 'unknown' ? t('scope_unknown_date') : t('scope_month_value', { year: session.scope.date.year, month: session.scope.date.month })}` : '') : t('photos_home_scope');


    useEffect(() => {
        if (visiblePhotos.length > 0) {
            setKeptAllReviewPhotos(false);
        }
    }, [visiblePhotos.length]);

    const previousMediaLibraryRefreshVersionRef = useRef(mediaLibraryRefreshVersion);
    const previousPermissionRefreshVersionRef = useRef(permissionRefreshVersion);
    useEffect(() => {
        if (mediaLibraryRefreshVersion === previousMediaLibraryRefreshVersionRef.current
            && permissionRefreshVersion === previousPermissionRefreshVersionRef.current) return;
        previousMediaLibraryRefreshVersionRef.current = mediaLibraryRefreshVersion;
        previousPermissionRefreshVersionRef.current = permissionRefreshVersion;

        // A library or permission change invalidates the local preview and
        // collection dialog, whose route/asset snapshot may no longer be
        // accessible. Persisted review queues are kept for recovery, but are
        // filtered separately by the permission-aware queue projection.
        setKeptAllReviewPhotos(false);
        if (hasHydrated && settingsHydrated && useMediaStore.getState().organizingSessions.photo) {
            void loadPhotos(groupSize, displayOrder, selectedAlbumIds);
        }
    }, [mediaLibraryRefreshVersion, permissionRefreshVersion, hasHydrated, settingsHydrated, loadPhotos, groupSize, displayOrder, selectedAlbumIds]);

    const handleSwipeUp = (photo: any) => {
        markForDeletion(photo);
    };

    const [toastMessage, setToastMessage] = useState<string | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

    const showToast = (message: string) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToastMessage(message);
        toastTimerRef.current = setTimeout(() => setToastMessage(null), 1500);
    };

    // Batch review returns before the deck; feedback must exist in both.
    // Text-only feedback also avoids showing a success icon for failures.
    const toast = toastMessage && (
        <View pointerEvents="none" style={styles.toastContainer}>
            <View style={[styles.toast, { backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)' }]}>
                <Text accessibilityLiveRegion="polite" style={[styles.toastText, { color: colors.text }]}>{toastMessage}</Text>
            </View>
        </View>
    );

    const handleSwipeDown = async (photo: any): Promise<boolean> => {
        markAsSkipped(photo);
        return true;
    };

    const handleTap = (photo: any) => {
        router.push({
            pathname: "/photo-detail",
            params: { assetId: photo.id, uri: photo.uri }
        });
    };

    const handleBatchFinished = () => (
        <PendingDeletionReview initialFilter="photo" onKeep={() => setKeptAllReviewPhotos(true)} onContinue={() => {
            setKeptAllReviewPhotos(false);
            setReviewDismissed(true);
            setShowHome(true);
            if (!session) {
                resetBatch([]); // Legacy batches still retain pending decisions.
                void loadPhotos(groupSize, displayOrder, selectedAlbumIds);
            }
        }} />
    );
    const afterUndo = () => {
        if (!photosFocusedRef.current) return;
        setReviewDismissed(false); setKeptAllReviewPhotos(false); setShowHome(false);
        showToast(t('recent_result_changed'));
        if (useMediaStore.getState().organizingSessions.photo) void resumeOrganizingSession('photo');
    };

    if (isLoading && !showScopeSelector) {
        return (
            <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    // A persisted delete queue can outlive the in-memory review batch. Keep
    // the confirmation screen reachable after a restart, even when there
    // are no remaining photos to load.
    if (!reviewDismissed && ((session?.phase === 'review' && !showHome && (deleteQueue.length > 0 || keptAllReviewPhotos))
        || (!session && visiblePhotos.length === 0 && (photos.length > 0 || deleteQueue.length > 0 || (keptAllReviewPhotos && permissionScope !== 'none'))))) {
        return (
            <View testID="photo-review" style={[styles.container, {
                paddingTop: insets.top,
                paddingBottom: UI_METRICS.dockHeight + insets.bottom,
                paddingLeft: insets.left,
                paddingRight: insets.right,
                backgroundColor: colors.background,
            }]}>
                <View style={styles.recentRow}><RecentDecisionsButton kind="photo" /><RecentUndoButton kind="photo" onChanged={afterUndo} /></View>
                {handleBatchFinished()}
                {toast}

            </View>
        )
    }

    if (visiblePhotos.length === 0 && !showHome) {
        const hasLimitedPhotoAccess = permissionScope === 'limited';
        return (
            <View testID="photos-end" style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
                <View style={[styles.endHeader, { paddingHorizontal: UI_METRICS.pageInset }]}><PendingDeletionButton /></View>
                <ScrollView contentContainerStyle={[styles.endContent, { paddingBottom: UI_METRICS.dockHeight + insets.bottom + 24,
                    paddingLeft: UI_METRICS.pageInset + insets.left, paddingRight: UI_METRICS.pageInset + insets.right }]}>
                <Text accessibilityRole={sessionReadFailed || sessionUnavailable || sessionPermissionRequired ? 'alert' : undefined} style={[styles.emptyText, { color: colors.text }]}>
                    {t(emptyTitle)}
                </Text>
                {session?.scope.order === 'largest' && session.phase === 'complete' && <Text style={[styles.readErrorDescription, { color: colors.textSecondary }]}>{t('scope_size_unknown_hint')}</Text>}
                {(sessionReadFailed || sessionUnavailable || sessionPermissionRequired) && <Text style={[styles.readErrorDescription, { color: colors.textSecondary }]}>{t('session_preserved_hint')}</Text>}
                {(hasLimitedPhotoAccess || sessionPermissionRequired) && (
                    <Pressable
                        onPress={handleManagePhotoAccess}
                        disabled={managingPhotoAccess}
                        style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: managingPhotoAccess ? 0.6 : 1 }]}
                    >
                        <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>
                            {managingPhotoAccess ? t('permission_requesting') : t('photos_manage_access')}
                        </Text>
                    </Pressable>
                )}
                <Pressable
                    accessibilityRole="button"
                    onPress={() => session?.phase === 'organizing' ? void openSession('resume') : void openSession(session ? 'next' : 'start')}
                    disabled={managingPhotoAccess}
                    style={[styles.actionButton, { backgroundColor: colors.actionBackground, opacity: managingPhotoAccess ? 0.6 : 1, marginTop: hasLimitedPhotoAccess ? 10 : 0 }]}
                >
                    <Text style={[styles.actionButtonText, { color: colors.actionForeground }]}>{t(session?.phase === 'review' || session?.phase === 'complete' ? 'session_next_batch' : 'photos_reload')}</Text>
                </Pressable>
                {!!session?.deferredIds.length && <Pressable accessibilityRole="button" onPress={() => void openSession('deferred')}
                    style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: SPACING.m }]}>
                    <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('session_deferred_count', { count: session.deferredIds.length })}</Text>
                </Pressable>}
                <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowHome(true)}
                    style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: SPACING.m }]}
                >
                    <Text style={[styles.actionButtonText, { color: colors.text }]}>{t('photos_back_home')}</Text>
                </Pressable>
                <View style={styles.recentRow}><RecentDecisionsButton kind="photo" /><RecentUndoButton kind="photo" onChanged={afterUndo} /></View>
                </ScrollView>
                {toast}
            </View>
        )
    }

    // Home is reachable during a session without undoing any decisions.
    if (showHome) {
        const previewPhotos = visiblePhotos.slice(0, 3);
        return (
            <View testID="photos-home" style={[styles.container, {
                backgroundColor: colors.background, paddingTop: insets.top,
                paddingBottom: UI_METRICS.dockHeight + insets.bottom,
                paddingLeft: insets.left, paddingRight: insets.right,
            }]}>
                <ScrollView
                    contentContainerStyle={[styles.homeContent, { paddingTop: 16, paddingBottom: 24 }]}
                    showsVerticalScrollIndicator={false}
                >
                    <View style={styles.homeBrandRow}>
                        <View style={styles.homeBrand}>
                            <Text style={[styles.homeBrandText, { color: colors.text }]}>PickPic</Text>
                        </View>
                        <PendingDeletionButton />
                    </View>

                    <View style={styles.homeHero}>
                        <Text accessibilityRole="header" style={[styles.homeTitle, { color: colors.text }]}>{t('photos_home_title')}</Text>
                        <View style={styles.homeCountRow}>
                            <Text style={[styles.homeScope, { color: colors.textSecondary }]}>{scopeCaption}</Text>
                            {session?.scope.order === 'largest' && session.phase === 'complete' && <Text style={[styles.homeScope, { color: colors.textSecondary }]}>{t('scope_size_unknown_hint')}</Text>}
                            <View style={styles.homeCountSummary}>
                                <Text style={[styles.homeCount, { color: colors.text }]}>{photoLoadFailed ? '—' : visiblePhotos.length}</Text>
                                <Text style={[styles.homeCountLabel, { color: colors.textSecondary }]}>{t('photos_home_pending')}</Text>
                            </View>
                        </View>
                    </View>

                    <Pressable
                        onPress={() => void openSession(homeAction)}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.homeStart, {
                            backgroundColor: colors.actionBackground,
                            opacity: pressed ? 0.8 : 1,
                            transform: [{ scale: pressed ? 0.985 : 1 }],
                        }]}
                    >
                        <Text style={[styles.homeStartLabel, { color: colors.actionForeground }]}>{t(homeActionTitle)}</Text>
                        <Feather name={visiblePhotos.length > 0 ? 'arrow-right' : 'refresh-cw'} size={19} color={colors.actionForeground} />
                    </Pressable>

                    <View style={styles.homePreviewSection}>
                        {previewPhotos.length > 0 ? <View accessibilityLabel={t('photos_home_preview')} style={[styles.homeMosaic, { height: previewHeight }]}>
                            <Image source={{ uri: previewPhotos[0].uri }} cachePolicy="memory" contentFit="cover" style={[styles.homeMosaicLarge, { backgroundColor: colors.surfaceHover }]} />
                            {previewPhotos.length > 1 && (
                                <View style={styles.homeMosaicSide}>
                                    {previewPhotos.slice(1).map(photo => (
                                        <Image key={photo.id} source={{ uri: photo.uri }} cachePolicy="memory" contentFit="cover" style={[styles.homeMosaicSmall, { backgroundColor: colors.surfaceHover }]} />
                                    ))}
                                </View>
                            )}
                        </View> : <View style={styles.homeEmpty}>
                            <Text accessibilityRole={sessionReadFailed || sessionUnavailable || sessionPermissionRequired ? 'alert' : undefined} style={[{ color: colors.textSecondary, textAlign: 'center', fontSize: 15, lineHeight: 22 }, sessionReadFailed && styles.readErrorTitle]}>
                                {t(session?.phase === 'review' && !sessionReadFailed && !sessionPermissionRequired && !sessionUnavailable ? 'photos_finished' : emptyTitle)}
                            </Text>
                            {(sessionReadFailed || sessionUnavailable || sessionPermissionRequired) && <Text style={[styles.readErrorDescription, { color: colors.textSecondary }]}>{t('session_preserved_hint')}</Text>}
                            {permissionScope === 'limited' && (
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={handleManagePhotoAccess}
                                    disabled={managingPhotoAccess}
                                    style={[styles.actionButton, { backgroundColor: colors.surface, marginTop: SPACING.m, opacity: managingPhotoAccess ? 0.6 : 1 }]}
                                >
                                    <Text style={[styles.actionButtonText, { color: colors.text }]}>
                                        {t(managingPhotoAccess ? 'permission_requesting' : 'photos_manage_access')}
                                    </Text>
                                </Pressable>
                            )}
                        </View>}
                    </View>

                    {photoSessionUnavailableCount > 0 && visiblePhotos.length > 0 && <Text accessibilityLiveRegion="polite" style={[styles.homeAlbumHint, { color: colors.textSecondary }]}>
                        {t('session_partial_hint', { count: photoSessionUnavailableCount })}
                    </Text>}

                    {session && <View style={styles.sessionActions}>
                        <Pressable accessibilityRole="button" onPress={() => void openSession('new')} style={styles.sessionTextButton}>
                            <Text style={[styles.homeAlbumTitle, { color: colors.text }]}>{t('session_new_round')}</Text>
                        </Pressable>
                        {!!session.deferredIds.length && <Pressable accessibilityRole="button" onPress={() => void openSession('deferred')} style={styles.sessionTextButton}>
                            <Text style={[styles.homeAlbumTitle, { color: colors.text }]}>{t('session_deferred_count', { count: session.deferredIds.length })}</Text>
                        </Pressable>}
                        <Text style={[styles.queueHint, { color: colors.textSecondary, width: '100%' }]}>{t('session_new_round_hint')}</Text>
                    </View>}

                    {permissionScope === 'limited' && previewPhotos.length > 0 && (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ disabled: managingPhotoAccess, busy: managingPhotoAccess }}
                            onPress={handleManagePhotoAccess}
                            disabled={managingPhotoAccess}
                            style={[styles.homeAccessButton, { opacity: managingPhotoAccess ? 0.6 : 1 }]}
                        >
                            <Text style={{ color: colors.textSecondary, fontSize: 15 }}>
                                {t(managingPhotoAccess ? 'permission_requesting' : 'photos_manage_access')}
                            </Text>
                        </Pressable>
                    )}

                    <Pressable
                        onPress={() => setShowScopeSelector(true)}
                        accessibilityRole="button"
                        accessibilityLabel={t('scope_title')}
                        style={({ pressed }) => [styles.homeAlbumRow, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                    >
                        <View style={styles.homeAlbumIcon}>
                            <Feather name="folder" size={20} color={colors.textSecondary} />
                        </View>
                        <View style={styles.homeAlbumCopy}>
                            <Text style={[styles.homeAlbumTitle, { color: colors.text }]}>{t('scope_title')}</Text>
                            <Text style={[styles.homeAlbumHint, { color: colors.textSecondary }]}>{t('scope_entry_hint')}</Text>
                        </View>
                        <Feather name="chevron-right" size={18} color={colors.textSecondary} />
                    </Pressable>
                    {session && <Text style={[styles.homeAlbumHint, { color: colors.textSecondary }]}>{t('session_filter_hint')}</Text>}
                    <View style={styles.recentRow}><RecentDecisionsButton kind="photo" /><RecentUndoButton kind="photo" onChanged={afterUndo} /></View>
                </ScrollView>
                <OrganizingScopeModal visible={showScopeSelector} kind="photo" onClose={() => setShowScopeSelector(false)} onStarted={() => {
                    setShowScopeSelector(false); setReviewDismissed(false); setKeptAllReviewPhotos(false); setShowHome(false);
                }} />
            </View>
        );
    }

    return (
        <View testID="photos-deck" style={[styles.container, {
            paddingTop: insets.top,
            paddingBottom: UI_METRICS.dockHeight + insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
            backgroundColor: colors.background,
        }]}>
            <View style={styles.header}>
                <View style={styles.deckHeaderRow}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('photos_back_home')} onPress={() => setShowHome(true)} style={styles.deckBackButton}>
                        <Feather name="chevron-left" size={22} color={colors.text} />
                    </Pressable>
                    <Text style={[styles.headerTitle, { color: colors.text }]}>{t('photos_header')}</Text>
                    <Text style={[styles.deckCounter, { color: colors.textSecondary }]}>
                        {deckPosition} / {deckTotal}
                    </Text>
                    <PendingDeletionButton />
                </View>
                <View accessible accessibilityRole="progressbar" accessibilityLabel={t('session_position')} accessibilityValue={{ min: 0, max: deckTotal, now: deckPosition }} style={[styles.deckProgressTrack, { backgroundColor: colors.divider }]}>
                    <View style={[styles.deckProgressFill, {
                        backgroundColor: colors.text,
                        width: `${Math.min(100, deckPosition / Math.max(1, deckTotal) * 100)}%`,
                    }]} />
                </View>
            </View>

            <View testID="photos-deck-viewport" style={styles.deckContainer} onLayout={({ nativeEvent }) => {
                const { width: measuredWidth, height: measuredHeight } = nativeEvent.layout;
                setDeckSize(current => current.width === measuredWidth && current.height === measuredHeight
                    ? current : { width: measuredWidth, height: measuredHeight });
            }}>
                {deckSize.width > 40 && deckSize.height > 16 && visiblePhotos.slice(0, 2).reverse().map((photo, index) => {
                    const realIndex = visiblePhotos.indexOf(photo);
                    return (
                        <PhotoCard
                            key={photo.id}
                            photo={photo}
                            index={realIndex}
                            total={visiblePhotos.length}
                            maxWidth={Math.min(deckSize.width, width - insets.left - insets.right) - UI_METRICS.pageInset * 2}
                            maxHeight={deckSize.height - 16}
                            onSwipeUp={() => handleSwipeUp(photo)}
                            onSwipeDown={() => handleSwipeDown(photo)}
                            onTap={() => handleTap(photo)}
                            enableCollections={false}
                        />
                    );
                })}
            </View>

            {/* Gesture shortcuts also remain explicit screen-reader actions. */}
            <View style={styles.deckFooter}>
                {photoSessionUnavailableCount > 0 && <Text style={[styles.queueHint, { color: colors.textSecondary }]}>{t('session_partial_hint', { count: photoSessionUnavailableCount })}</Text>}
                <View style={styles.recentRow}><Pressable accessibilityRole="button" onPress={() => {
                    if (visiblePhotos[0] && deferSessionMedia('photo', visiblePhotos[0].id)) showToast(t('session_deferred_feedback'));
                }} style={styles.sessionTextButton}>
                    <Text style={[styles.homeAlbumTitle, { color: colors.text }]}>{t('session_defer')}</Text>
                </Pressable><RecentUndoButton kind="photo" onChanged={afterUndo} /><RecentDecisionsButton kind="photo" iconOnly /></View>
                <View style={styles.footerHints}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('pending_add')}
                        disabled={!visiblePhotos[0]} onPress={() => { if (visiblePhotos[0]) handleSwipeUp(visiblePhotos[0]); }}
                        style={({ pressed }) => [styles.hintItem, pressed && { opacity: 0.6 }]}>
                        <Ionicons name="arrow-up-outline" size={20} color={colors.danger} />
                        <Text style={[styles.hintText, { color: colors.textSecondary }]}>{t('hint_swipe_up')}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('similar_keep_photo')}
                        disabled={!visiblePhotos[0]} onPress={() => { if (visiblePhotos[0]) void handleSwipeDown(visiblePhotos[0]); }}
                        style={({ pressed }) => [styles.hintItem, pressed && { opacity: 0.6 }]}>
                        <Ionicons name="arrow-down-outline" size={20} color={colors.textSecondary} />
                        <Text style={[styles.hintText, { color: colors.textSecondary }]}>{t('hint_swipe_down')}</Text>
                    </Pressable>
                </View>
                <Text style={[styles.queueHint, { color: colors.textSecondary }]}>{t('photos_queue_review_hint')}</Text>
            </View>

            {/* Toast */}
            {toast}

        </View>
    );
}

const styles = StyleSheet.create({
    recentRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 8 },
    endHeader: { minHeight: UI_METRICS.touchTarget, alignItems: 'flex-end' },
    endContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingTop: SPACING.l },
    sessionActions: { marginTop: SPACING.s, gap: SPACING.xs, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' },
    sessionTextButton: { minHeight: UI_METRICS.touchTarget, paddingHorizontal: SPACING.m, paddingVertical: SPACING.s,
        alignItems: 'center', justifyContent: 'center' },
    deckBackButton: { minWidth: UI_METRICS.touchTarget, minHeight: UI_METRICS.touchTarget, alignItems: 'center', justifyContent: 'center' },
    homeAccessButton: {
        minHeight: 44,
        marginTop: SPACING.s,
        paddingHorizontal: SPACING.m,
        alignItems: 'center',
        justifyContent: 'center',
    },
    homeContent: {
        flexGrow: 1,
        paddingHorizontal: UI_METRICS.pageInset,
    },
    homeBrandRow: {
        minHeight: 36,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    homeBrand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    homeBrandText: {
        ...TYPOGRAPHY.sectionTitle,
    },
    homeHero: {
        marginTop: 24,
    },
    homeTitle: {
        ...TYPOGRAPHY.pageTitle,
    },
    homeScope: {
        ...TYPOGRAPHY.secondary,
    },
    homeCountRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
    },
    homeCountSummary: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
    homeCount: {
        fontSize: 18,
        lineHeight: 26,
        fontWeight: '500',
        fontVariant: ['tabular-nums'],
        flexShrink: 1,
    },
    homeCountLabel: {
        ...TYPOGRAPHY.caption,
    },
    homeStart: {
        minHeight: 54,
        marginTop: 24,
        gap: 12,
        paddingVertical: 15,
        borderRadius: 27,
        paddingHorizontal: 22,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
    },
    homeStartLabel: {
        ...TYPOGRAPHY.button,
        flexShrink: 1,
        textAlign: 'center',
    },
    homePreviewSection: {
        marginTop: 20,
    },
    homeMosaic: {
        flexDirection: 'row',
        gap: 8,
    },
    homeEmpty: {
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.l,
        gap: SPACING.s,
    },
    homeMosaicLarge: {
        flex: 1.35,
        height: '100%',
        borderRadius: 18,
    },
    homeMosaicSide: {
        flex: 1,
        gap: 8,
    },
    homeMosaicSmall: {
        flex: 1,
        width: '100%',
        borderRadius: 18,
    },
    homeAlbumRow: {
        marginTop: 20,
        borderRadius: 16,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 72,
    },
    homeAlbumIcon: {
        width: 24,
        height: UI_METRICS.touchTarget,
        alignItems: 'center',
        justifyContent: 'center',
    },
    homeAlbumCopy: {
        flex: 1,
        gap: 4,
    },
    homeAlbumTitle: {
        ...TYPOGRAPHY.body,
        fontWeight: '500',
    },
    homeAlbumHint: {
        ...TYPOGRAPHY.secondary,
    },
    container: {
        flex: 1,
    },
    readErrorTitle: { ...TYPOGRAPHY.sectionTitle, marginBottom: 12 },
    readErrorDescription: { ...TYPOGRAPHY.body, textAlign: 'center', marginHorizontal: UI_METRICS.pageInset, marginBottom: 20 },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    header: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingTop: 12,
        paddingBottom: 10,
    },
    headerTitle: {
        ...TYPOGRAPHY.pageTitle,
        flex: 1,
        minWidth: 0,
    },
    deckHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
    },
    deckCounter: {
        ...TYPOGRAPHY.secondary,
        flexShrink: 0,
        fontVariant: ['tabular-nums'],
    },
    deckProgressTrack: {
        height: 2,
        marginTop: 12,
        borderRadius: 1,
        overflow: 'hidden',
    },
    deckProgressFill: {
        height: '100%',
        borderRadius: 1,
    },
    deckContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerHints: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
        gap: 16,
    },
    deckFooter: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingTop: 12,
        paddingBottom: 16,
        gap: 12,
    },
    queueHint: {
        ...TYPOGRAPHY.caption,
        textAlign: 'center',
    },
    hintItem: {
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: UI_METRICS.touchTarget,
        flex: 1,
        minWidth: 0,
    },
    hintText: {
        marginTop: 4,
        ...TYPOGRAPHY.secondary,
        textAlign: 'center',
    },
    emptyText: {
        fontSize: 20,
        marginBottom: 20,
        textAlign: 'center',
    },
    actionButton: {
        minHeight: UI_METRICS.buttonHeight,
        paddingHorizontal: 24,
        paddingVertical: 14,
        borderRadius: UI_METRICS.buttonRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionButtonText: {
        ...TYPOGRAPHY.button
    },
    // Toast
    toastContainer: {
        position: 'absolute',
        top: 100,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 1000,
    },
    toast: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.full,
        gap: 8,
        overflow: 'hidden',
    },
    toastText: {
        fontSize: 14,
        fontWeight: '500',
    }
});
