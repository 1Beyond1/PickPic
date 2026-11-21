import { getReadableMediaInfo, getReadableMediaInfos } from '../services/readableMedia';

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    BackHandler,
    FlatList,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    useReducedMotion,
    withTiming
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { getCurrentlyVisibleAssetIds, useMediaStore } from '../stores/useMediaStore';
import { getPendingDeletionEntries } from '../services/pendingDeletion';
import { PendingDeletionButton } from './PendingDeletionReview';
import { SimilarReviewRepository, isSimilarReviewCurrent } from '../database/repositories/SimilarReviewRepository';
import type { SimilarGroupSnapshot } from '../database/repositories/SimilarReviewRepository';
import { keepSimilarPhotos, completeSimilarGroup } from '../services/similarReview';
import { flushMediaProgress } from '../services/mediaProgressStorage';
import { readMediaSizes } from '../services/mediaSizes';
import { SimilarComparison } from './SimilarComparison';
import { calculateBestShotBreakdown } from '../database/bestShotScoring';

const COLUMN_COUNT = 3;

interface PhotoItem {
    assetId: string;
    uri: string;
    width: number;
    height: number;
    takenAt: number | null;
    bytes: number | null;
}

interface SimilarGroupDetailOverlayProps {
    visible: boolean;
    groupId: string;
    memberAssetIds: string[];
    originRect: { x: number; y: number; width: number; height: number } | null;
    onClose: () => void;
    onComplete: () => void;
}

export function SimilarGroupDetailOverlay({
    visible,
    groupId,
    memberAssetIds,
    onClose,
    onComplete,
}: SimilarGroupDetailOverlayProps) {
    const insets = useSafeAreaInsets();
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const translationRef = useRef(t);
    translationRef.current = t;
    const reducedMotion = useReducedMotion();
    const processedIds = useMediaStore(state => state.photoProcessedIds);
    const pendingPhotos = useMediaStore(state => state.deleteQueue);

    const [photos, setPhotos] = useState<PhotoItem[]>([]);
    const [isLoadingPhotos, setIsLoadingPhotos] = useState(false);
    const [unavailableCount, setUnavailableCount] = useState(0);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [previewPhoto, setPreviewPhoto] = useState<PhotoItem | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [queueFeedback, setQueueFeedback] = useState<string | null>(null);
    const [snapshot, setSnapshot] = useState<SimilarGroupSnapshot | null>(null);
    const [keptIds, setKeptIds] = useState<Set<string>>(new Set());
    const [showComparison, setShowComparison] = useState(false);
    const [showDetails, setShowDetails] = useState(false);
    const isDeletingRef = useRef(false);
    const loadRequestIdRef = useRef(0);

    // Animation state
    const overlayOpacity = useSharedValue(0);

    const loadPhotos = useCallback(async () => {
        const requestId = ++loadRequestIdRef.current;
        setIsLoadingPhotos(true);
        setUnavailableCount(0);
        setPhotos([]);
        setSnapshot(null);
        setKeptIds(new Set());
        let groupSnapshot: SimilarGroupSnapshot | null = null;
        let confirmedKeeps: string[] = [];
        try {
            groupSnapshot = await SimilarReviewRepository.getSnapshot(groupId);
            if (groupSnapshot) {
                const review = await SimilarReviewRepository.getReview(groupSnapshot);
                const store = useMediaStore.getState();
                if (isSimilarReviewCurrent(review, store.photoProcessedIds, store.deleteQueue.map(asset => asset.id))) confirmedKeeps = review!.keptIds;
            }
        } catch {
            // An unreadable saved review is not the same as no review. Keep
            // previews available, but do not let new decisions overwrite it.
            groupSnapshot = null;
            if (requestId === loadRequestIdRef.current) setQueueFeedback(translationRef.current('similar_save_failed'));
        }
        const infos = await getReadableMediaInfos(memberAssetIds, 'photo', { shouldDownloadFromNetwork: false });
        if (requestId !== loadRequestIdRef.current) return;
        const items: PhotoItem[] = [];
        for (const assetId of memberAssetIds) {
            const info = infos.get(assetId);
            if (info?.id === assetId && info.mediaType === 'photo' && (info.localUri || info.uri)) {
                items.push({
                    assetId,
                    uri: info.localUri || info.uri,
                    width: Number.isFinite(info.width) && info.width > 0 ? info.width : 0,
                    height: Number.isFinite(info.height) && info.height > 0 ? info.height : 0,
                    takenAt: Number.isFinite(info.creationTime) && info.creationTime > 0 ? info.creationTime : null,
                    bytes: null,
                });
            }
        }
        const sizes = await readMediaSizes('photo', items.map(item => item.assetId), () => requestId === loadRequestIdRef.current);
        if (sizes.status === 'ready') for (const photo of items) photo.bytes = sizes.sizes.get(photo.assetId) ?? null;
        if (requestId === loadRequestIdRef.current) {
            setPhotos(items);
            setUnavailableCount(memberAssetIds.length - items.length);
            setSnapshot(groupSnapshot);
            setKeptIds(new Set(confirmedKeeps));
            setIsLoadingPhotos(false);
        }
    }, [groupId, memberAssetIds]);

    const animateClose = useCallback(() => {
        // Exit animation
        overlayOpacity.value = withTiming(0, { duration: reducedMotion ? 0 : 250 }, (finished) => {
            if (finished) {
                runOnJS(onClose)();
            }
        });
    }, [onClose, overlayOpacity, reducedMotion]);

    const handleClose = useCallback(() => {
        if (isDeletingRef.current) return;
        animateClose();
    }, [animateClose]);

    useEffect(() => {
        if (visible && memberAssetIds.length > 0) {
            loadPhotos();
            setSelectedIds(new Set());
            setPreviewPhoto(null);
            setQueueFeedback(null);
            setShowComparison(false);
            setShowDetails(false);
            // Start enter animation
            overlayOpacity.value = withTiming(1, { duration: reducedMotion ? 0 : 180 });
        } else {
            loadRequestIdRef.current += 1;
            setPhotos([]); // Clear on close or an empty group to avoid stale content
            setIsLoadingPhotos(false);
            setUnavailableCount(0);
            setSelectedIds(new Set());
            setPreviewPhoto(null);
            setSnapshot(null);
            setKeptIds(new Set());
            setShowComparison(false);
        }
        return () => { loadRequestIdRef.current += 1; };
    }, [visible, memberAssetIds, loadPhotos, overlayOpacity, reducedMotion]);

    // Handle Back Button
    useEffect(() => {
        if (!visible) return;

        const onBackPress = () => {
            handleClose();
            return true;
        };

        const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);

        return () => subscription.remove();
    }, [visible, handleClose]);

    const handleLongPress = (assetId: string) => {
        if (isDeletingRef.current) return;
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(assetId)) {
                next.delete(assetId);
            } else {
                next.add(assetId);
            }
            return next;
        });
    };

    const handleTap = (photo: PhotoItem) => {
        if (isDeletingRef.current) return;
        if (selectedIds.size > 0) {
            handleLongPress(photo.assetId);
        } else {
            setPreviewPhoto(photo);
        }
    };

    const queuePhotos = async (assetIds: readonly string[]) => {
        if (!assetIds.length || isDeletingRef.current) return;
        const confirmedKeeps = Array.from(keptIds).filter(id => processedIds.includes(id) && !pendingPhotos.some(asset => asset.id === id));
        if (!confirmedKeeps.length || assetIds.some(id => confirmedKeeps.includes(id))) {
            setQueueFeedback(t('similar_keep_first')); return;
        }
        const generation = loadRequestIdRef.current;
        const permissionVersion = useMediaStore.getState().permissionRefreshVersion;
        isDeletingRef.current = true;
        setIsDeleting(true);
        setQueueFeedback(null);
        try {
            const visibleIds = await getCurrentlyVisibleAssetIds(assetIds, 'photo');
            if (visibleIds.size !== new Set(assetIds).size) throw new Error('Unavailable');
            const infoMap = await getReadableMediaInfos(assetIds, 'photo', { shouldDownloadFromNetwork: false });
            const assets = assetIds.map(id => infoMap.get(id));
            if (assets.some((asset, index) => !asset || asset.id !== assetIds[index] || asset.mediaType !== 'photo')) throw new Error('Unavailable');
            const validatedAssets = assets as NonNullable<typeof assets[number]>[];
            let store = useMediaStore.getState();
            if (generation !== loadRequestIdRef.current || permissionVersion !== store.permissionRefreshVersion) throw new Error('Access changed');
            const latest = await SimilarReviewRepository.getSnapshot(groupId);
            if (!snapshot || latest?.key !== snapshot.key || generation !== loadRequestIdRef.current
                || permissionVersion !== useMediaStore.getState().permissionRefreshVersion) throw new Error('Group changed');
            if (!confirmedKeeps.some(id => useMediaStore.getState().photoProcessedIds.includes(id)
                && !useMediaStore.getState().deleteQueue.some(asset => asset.id === id))) throw new Error('Keep changed');
            store = useMediaStore.getState();
            if (!store.hasHydrated || store.isConfirmingDeletion || store.isConfirmingVideoTrash) throw new Error('Busy');
            const before = new Set(getPendingDeletionEntries(store).map(entry => entry.asset.id));
            const added = store.enqueuePendingDeletion(validatedAssets, 'similar');
            if (!added && assetIds.some(id => !before.has(id))) throw new Error('Record mutation is blocked');
            await flushMediaProgress();
            if (generation !== loadRequestIdRef.current) return;
            setQueueFeedback(t(added ? 'pending_added' : 'pending_already_added'));
            setSelectedIds(new Set());
            setPreviewPhoto(null);
            // Queuing is not physical deletion, nor an explicit decision to keep
            // the remaining members. Group completion is handled separately.
        } catch { if (generation === loadRequestIdRef.current) setQueueFeedback(t('pending_add_failed')); }
        finally { isDeletingRef.current = false; setIsDeleting(false); }
    };
    const handleDeleteSelected = () => queuePhotos(Array.from(selectedIds));
    const handleClosePreview = () => { if (!isDeletingRef.current) setPreviewPhoto(null); };
    const handleDeleteFromPreview = () => previewPhoto && queuePhotos([previewPhoto.assetId]);
    const confirmedKeptIds = Array.from(keptIds).filter(id => processedIds.includes(id) && !pendingPhotos.some(asset => asset.id === id));
    const allAccessible = !!snapshot && snapshot.assets.length === photos.length
        && snapshot.assets.every(asset => photos.some(photo => photo.assetId === asset.asset_id));
    const canComplete = allAccessible && confirmedKeptIds.length > 0 && photos.every(photo => confirmedKeptIds.includes(photo.assetId)
        || (processedIds.includes(photo.assetId) && pendingPhotos.some(asset => asset.id === photo.assetId)));
    const keepPhotos = async (ids: readonly string[]) => {
        if (!snapshot || isDeletingRef.current) return;
        const generation = loadRequestIdRef.current;
        isDeletingRef.current = true; setIsDeleting(true); setQueueFeedback(null);
        try {
            const result = await keepSimilarPhotos(groupId, snapshot.key, ids, () => generation === loadRequestIdRef.current);
            if (generation !== loadRequestIdRef.current) return;
            if (result === 'saved') {
                setKeptIds(previous => new Set([...previous, ...ids]));
                setSelectedIds(new Set());
                setQueueFeedback(t('similar_kept_saved'));
            } else setQueueFeedback(t(result === 'stale' ? 'similar_group_changed' : 'similar_save_failed'));
        } finally { isDeletingRef.current = false; setIsDeleting(false); }
    };
    const finish = async () => {
        if (!snapshot || !canComplete || isDeletingRef.current) return;
        const generation = loadRequestIdRef.current;
        isDeletingRef.current = true; setIsDeleting(true); setQueueFeedback(null);
        try {
            const result = await completeSimilarGroup(groupId, snapshot.key, confirmedKeptIds, () => generation === loadRequestIdRef.current);
            if (generation !== loadRequestIdRef.current) return;
            if (result === 'saved') { onComplete(); onClose(); }
            else setQueueFeedback(t(result === 'stale' ? 'similar_group_changed' : 'similar_save_failed'));
        } finally { isDeletingRef.current = false; setIsDeleting(false); }
    };

    const renderPhotoItem = ({ item, index }: { item: PhotoItem; index: number }) => {
        const isSelected = selectedIds.has(item.assetId);
        return (
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('similar_photo', { index: index + 1 })}
                accessibilityHint={t(selectedIds.size > 0 ? 'similar_toggle_hint' : 'similar_select_hint')}
                accessibilityState={{ selected: isSelected, disabled: isDeleting }}
                style={[
                    styles.photoItem,
                    isSelected && { borderColor: colors.primary, borderWidth: 3 },
                    isDeleting && { opacity: 0.5 },
                ]}
                onPress={() => handleTap(item)}
                onLongPress={() => handleLongPress(item.assetId)}
                disabled={isDeleting}
            >
                <Image source={{ uri: item.uri }} cachePolicy="memory" contentFit="cover" style={styles.photoImage} />
                {isSelected && (
                    <View style={[styles.checkmark, { backgroundColor: colors.actionBackground }]}>
                        <Ionicons name="checkmark" size={16} color={colors.actionForeground} />
                    </View>
                )}
                {confirmedKeptIds.includes(item.assetId) && <View style={[styles.keptBadge, { backgroundColor: colors.surface }]}><Text style={[styles.badgeText, { color: colors.success }]}>{t('similar_kept')}</Text></View>}
                {snapshot?.recommendedAssetId === item.assetId && !confirmedKeptIds.includes(item.assetId) && <View style={[styles.keptBadge, { backgroundColor: colors.surface }]}><Text style={[styles.badgeText, { color: colors.text }]}>{t('similar_recommended')}</Text></View>}
            </Pressable>
        );
    };

    const containerAnimatedStyle = useAnimatedStyle(() => ({
        opacity: overlayOpacity.value,
    }));

    if (!visible) return null;

    return (
        <Animated.View accessibilityViewIsModal testID="similar-detail" style={[StyleSheet.absoluteFill, styles.container, {
            backgroundColor: colors.background,
            paddingTop: insets.top + 8,
            paddingBottom: UI_METRICS.dockHeight + insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
        }, containerAnimatedStyle]}>
            <View style={styles.header}>
                <View style={styles.heading}>
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('similar_group_detail_title')}</Text>
                    <Text accessibilityLiveRegion="polite" style={[styles.summary, { color: colors.textSecondary }]}>
                        {selectedIds.size > 0 ? t('similar_selected_count', { count: selectedIds.size }) : t('scan_photo_count', { count: isLoadingPhotos || (photos.length === 0 && unavailableCount > 0) ? memberAssetIds.length : photos.length })}
                    </Text>
                </View>
                <PendingDeletionButton />
                <Pressable
                    style={[styles.closeButton, isDeleting && { opacity: 0.5 }]}
                    onPress={handleClose}
                    disabled={isDeleting}
                    accessibilityRole="button"
                    accessibilityLabel={t('close')}
                    accessibilityState={{ disabled: isDeleting }}
                >
                    <Ionicons name="close-outline" size={24} color={colors.text} />
                </Pressable>
            </View>
            {queueFeedback && <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: colors.textSecondary }]}>{queueFeedback}</Text>}
            {!isLoadingPhotos && photos.length > 0 && <Text style={[styles.hint, { color: colors.textSecondary }]}>{t(selectedIds.size > 0 ? 'similar_toggle_hint' : 'similar_select_hint')}</Text>}
            {!isLoadingPhotos && photos.length > 0 && unavailableCount > 0 && <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: colors.textSecondary }]}>{t('similar_unavailable_count', { count: unavailableCount })}</Text>}

            {/* Grid */}
            <View style={{ flex: 1 }}>
                <FlatList
                    data={photos}
                    renderItem={renderPhotoItem}
                    keyExtractor={(item) => item.assetId}
                    numColumns={COLUMN_COUNT}
                    contentContainerStyle={styles.grid}
                    ListHeaderComponent={photos.length > 0 ? <View style={styles.groupActions}>
                        <Text style={[styles.readMessage, { color: colors.textSecondary }]}>{t('similar_flow_hint')}</Text>
                        {photos.length > 1 && <Pressable accessibilityRole="button" accessibilityLabel={t('similar_compare')}
                            disabled={isDeleting} onPress={() => setShowComparison(true)} style={[styles.retryButton, { backgroundColor: colors.surfaceHover }]}>
                            <Text style={[styles.retryText, { color: colors.text }]}>{t('similar_compare')}</Text>
                        </Pressable>}
                        {selectedIds.size > 0 && <>
                            <Pressable accessibilityRole="button" accessibilityLabel={t('similar_keep_selected')} disabled={isDeleting || !snapshot}
                                onPress={() => void keepPhotos(Array.from(selectedIds))} style={[styles.retryButton, { backgroundColor: colors.actionBackground }]}>
                                <Text style={[styles.retryText, { color: colors.actionForeground }]}>{t('similar_keep_selected')}</Text>
                            </Pressable>
                            <Pressable accessibilityRole="button" accessibilityLabel={t('pending_add')}
                                accessibilityState={{ disabled: isDeleting || !confirmedKeptIds.length || Array.from(selectedIds).some(id => confirmedKeptIds.includes(id)), busy: isDeleting }}
                                disabled={isDeleting || !confirmedKeptIds.length || Array.from(selectedIds).some(id => confirmedKeptIds.includes(id))}
                                onPress={handleDeleteSelected} style={[styles.retryButton, { backgroundColor: colors.dangerBackground }]}>
                                <Text style={[styles.retryText, { color: colors.dangerForeground }]}>{t('pending_add')}</Text>
                            </Pressable>
                        </>}
                        {!allAccessible && <Text accessibilityLiveRegion="polite" style={[styles.readMessage, { color: colors.textSecondary }]}>{t('similar_incomplete_access')}</Text>}
                    </View> : null}
                    ListFooterComponent={photos.length > 0 ? <View style={styles.groupActions}>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('similar_finish')} disabled={isDeleting || !canComplete}
                            accessibilityState={{ disabled: isDeleting || !canComplete, busy: isDeleting }} onPress={() => void finish()}
                            style={[styles.retryButton, { backgroundColor: colors.actionBackground, opacity: canComplete && !isDeleting ? 1 : 0.5 }]}>
                            <Text style={[styles.retryText, { color: colors.actionForeground }]}>{t('similar_finish')}</Text>
                        </Pressable>
                        <Text style={[styles.readMessage, { color: colors.textSecondary }]}>{t('similar_finish_hint')}</Text>
                    </View> : null}
                    ListEmptyComponent={isLoadingPhotos ? (
                        <ActivityIndicator color={colors.primary} style={styles.readState} />
                    ) : unavailableCount > 0 ? (
                        <View style={styles.readState}>
                            <Text accessibilityRole="alert" style={[styles.readMessage, { color: colors.textSecondary }]}>{t('photos_load_failed')}</Text>
                            <Pressable accessibilityRole="button" onPress={() => void loadPhotos()} style={[styles.retryButton, { backgroundColor: colors.actionBackground }]}>
                                <Text style={[styles.retryText, { color: colors.actionForeground }]}>{t('retry')}</Text>
                            </Pressable>
                        </View>
                    ) : null}
                />
            </View>

            {/* Preview Modal */}
            {previewPhoto && (
                <Modal visible={true} transparent animationType={reducedMotion ? 'none' : 'fade'} statusBarTranslucent navigationBarTranslucent onRequestClose={handleClosePreview}>
                    <View accessibilityViewIsModal testID="similar-preview" style={[styles.previewOverlay, {
                        backgroundColor: colors.background,
                        paddingTop: insets.top + 8,
                        paddingBottom: insets.bottom,
                        paddingLeft: insets.left,
                        paddingRight: insets.right,
                    }]}>
                        <View style={styles.previewHeader}>
                            <Text accessibilityRole="header" style={[styles.previewTitle, { color: colors.text }]}>{t('photo_detail_title')}</Text>
                            <Pressable
                                style={[styles.previewClose, isDeleting && { opacity: 0.5 }]}
                                onPress={handleClosePreview}
                                disabled={isDeleting}
                                accessibilityRole="button"
                                accessibilityLabel={t('close')}
                                accessibilityState={{ disabled: isDeleting }}
                            >
                                <Ionicons name="close-outline" size={24} color={colors.text} />
                            </Pressable>
                            <Pressable
                                style={[styles.previewDeleteButton, { backgroundColor: colors.dangerBackground }, isDeleting && { opacity: 0.5 }]}
                                onPress={handleDeleteFromPreview}
                                disabled={isDeleting || !confirmedKeptIds.length || confirmedKeptIds.includes(previewPhoto.assetId)}
                                accessibilityRole="button"
                                accessibilityLabel={t('pending_add')}
                                accessibilityState={{ disabled: isDeleting || !confirmedKeptIds.length || confirmedKeptIds.includes(previewPhoto.assetId), busy: isDeleting }}
                            >
                                <Ionicons name="trash-outline" size={20} color={colors.dangerForeground} />
                            </Pressable>
                        </View>
                        <ScrollView contentContainerStyle={styles.previewContent}>
                            <Pressable accessibilityRole="button" accessibilityLabel={t('similar_keep_photo')} disabled={isDeleting || !snapshot}
                                onPress={() => void keepPhotos([previewPhoto.assetId])} style={[styles.retryButton, { backgroundColor: colors.actionBackground }]}>
                                <Text style={[styles.retryText, { color: colors.actionForeground }]}>{t('similar_keep_photo')}</Text>
                            </Pressable>
                            {queueFeedback && <Text accessibilityLiveRegion="polite" style={[styles.readMessage, { color: colors.textSecondary }]}>{queueFeedback}</Text>}
                            <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('pending_keep_hint')}</Text>
                            <Pressable accessibilityRole="button" accessibilityLabel={t('similar_details')} accessibilityState={{ expanded: showDetails }}
                                onPress={() => setShowDetails(value => !value)} style={styles.retryButton}>
                                <Text style={[styles.retryText, { color: colors.text }]}>{t('similar_details')}</Text>
                            </Pressable>
                            {showDetails && <SimilarDetails photo={previewPhoto} snapshot={snapshot} />}
                        <View style={styles.previewMedia}>
                            <SimilarPhotoPreview key={`${previewPhoto.assetId}:${previewPhoto.uri}`} photo={previewPhoto} />
                        </View>
                        </ScrollView>
                    </View>
                </Modal>
            )}
            {showComparison && photos.length > 1 && <SimilarComparison photos={photos} recommendedId={snapshot?.recommendedAssetId ?? null} onClose={() => setShowComparison(false)} />}
        </Animated.View>
    );
}

function SimilarDetails({ photo, snapshot }: { photo: PhotoItem; snapshot: SimilarGroupSnapshot | null }) {
    const { colors } = useThemeColor();
    const { t, language } = useI18n();
    const asset = snapshot?.assets.find(item => item.asset_id === photo.assetId);
    const breakdown = asset ? calculateBestShotBreakdown(asset) : null;
    const unknown = t('similar_unknown');
    const info = [
        t('similar_date', { value: photo.takenAt === null ? unknown : new Date(photo.takenAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US') }),
        t('similar_resolution', { value: photo.width > 0 && photo.height > 0 ? `${photo.width} × ${photo.height}` : unknown }),
        t('similar_size', { value: photo.bytes === null ? unknown : `${(photo.bytes / 1024 / 1024).toFixed(2)} MB` }),
    ];
    if (asset && breakdown) {
        info.push(t('similar_sharpness', { value: asset.blur_score === null ? unknown : `${asset.blur_score.toFixed(1)} / ${breakdown.sharpness.toFixed(1)}` }));
        info.push(t('similar_lighting', { value: asset.mean_luma === null ? unknown : `${asset.mean_luma.toFixed(1)} / ${breakdown.lighting.toFixed(1)}` }));
        info.push(t('similar_resolution_score', { value: asset.width && asset.height ? breakdown.resolution.toFixed(1) : unknown }));
        info.push(t('similar_score_hint'));
    }
    return <View style={styles.details}>{info.map(text => <Text key={text} style={[styles.detailText, { color: colors.textSecondary }]}>{text}</Text>)}</View>;
}

/** Keep a failed decoder from looking like an empty, successfully loaded preview. */
function SimilarPhotoPreview({ photo }: { photo: PhotoItem }) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const [attempt, setAttempt] = useState(0);
    const [image, setImage] = useState<{ uri: string; failed: boolean; attempt: number } | null>({ uri: photo.uri, failed: false, attempt: 0 });

    useEffect(() => {
        if (attempt === 0) return;
        let active = true;
        setImage(null);
        void getReadableMediaInfo(photo.assetId).then(info => {
            const uri = info?.localUri || info?.uri || '';
            if (active) setImage({ uri, failed: !uri, attempt });
        }).catch(() => {
            if (active) setImage({ uri: '', failed: true, attempt });
        });
        return () => { active = false; };
    }, [photo.assetId, attempt]);

    if (!image) return <ActivityIndicator size="large" color={colors.primary} />;
    if (image.failed) return (
        <View style={styles.readState}>
            <Text accessibilityRole="alert" style={[styles.readMessage, { color: colors.textSecondary }]}>{t('scan_photo_unavailable')}</Text>
            <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={[styles.retryButton, { backgroundColor: colors.actionBackground }]}>
                <Text style={[styles.retryText, { color: colors.actionForeground }]}>{t('retry')}</Text>
            </Pressable>
        </View>
    );
    const uri = image.uri;
    return <Image key={attempt} accessible accessibilityRole="image" accessibilityLabel={t('photo_detail_title')}
        source={{ uri }} cachePolicy="memory" contentFit="contain" style={styles.previewImage}
        onError={() => setImage(previous => previous?.attempt === attempt && previous.uri === uri ? { ...previous, failed: true } : previous)} />;
}

const styles = StyleSheet.create({
    groupActions: { paddingVertical: 12, gap: 12 },
    keptBadge: { position: 'absolute', left: 4, bottom: 4, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4, maxWidth: '94%' },
    badgeText: { ...TYPOGRAPHY.caption },
    details: { paddingHorizontal: 8, gap: 6 },
    detailText: { ...TYPOGRAPHY.secondary },
    previewContent: { flexGrow: 1, paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 24, gap: 12 },
    readState: { alignItems: 'center', paddingHorizontal: UI_METRICS.pageInset, paddingVertical: 24, gap: 20 },
    readMessage: { ...TYPOGRAPHY.body, textAlign: 'center' },
    retryButton: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 24, paddingVertical: 14, justifyContent: 'center', alignItems: 'center' },
    retryText: { ...TYPOGRAPHY.button },
    container: {
        zIndex: 1000,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: UI_METRICS.pageInset,
        paddingBottom: 12,
        gap: 12,
    },
    heading: { flex: 1, minWidth: 0, gap: 4 },
    closeButton: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 4,
        flexShrink: 0,
        borderRadius: UI_METRICS.buttonRadius,
    },
    title: {
        ...TYPOGRAPHY.pageTitle,
    },
    summary: { ...TYPOGRAPHY.secondary },
    hint: { ...TYPOGRAPHY.secondary, paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 16 },
    deleteButton: {
        minWidth: 44,
        minHeight: 44,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 10,
        borderRadius: 12,
    },
    grid: {
        paddingHorizontal: 12,
        paddingBottom: 20,
    },
    photoItem: {
        width: '33.333333%',
        aspectRatio: 1,
        padding: 4,
    },
    photoImage: {
        width: '100%',
        height: '100%',
        borderRadius: 8,
    },
    checkmark: {
        position: 'absolute',
        top: 8,
        right: 8,
        width: 24,
        height: 24,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewOverlay: {
        flex: 1,
    },
    previewHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 12 },
    previewTitle: { ...TYPOGRAPHY.sectionTitle, flex: 1, minWidth: 0 },
    previewMedia: { flex: 1, minHeight: 300 },
    previewClose: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        borderRadius: UI_METRICS.buttonRadius,
    },
    previewDeleteButton: {
        minWidth: 44,
        minHeight: 44,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 10,
        borderRadius: UI_METRICS.buttonRadius,
    },
    previewImage: {
        width: '100%',
        height: '100%',
    },
});
