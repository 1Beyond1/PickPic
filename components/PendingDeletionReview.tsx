import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { getPendingDeletionEntries } from '../services/pendingDeletion';
import { getReadableMediaInfo, getReadableMediaInfos } from '../services/readableMedia';
import type { PendingDeletionEntry } from '../services/pendingDeletion';
import { useMediaStore } from '../stores/useMediaStore';
import { useShallow } from 'zustand/react/shallow';
import { PhotoPreviewModal } from './PhotoPreviewModal';
import { SegmentedControl } from './SegmentedControl';

type Filter = 'all' | 'photo' | 'video';
const PAGE_SIZE = 9;

/** Every entry point uses this review. Viewing never changes a decision;
 * keeping changes only that decision and remains processed. */
export function PendingDeletionReview({ initialFilter = 'all', onContinue, onKeep }: {
    initialFilter?: Filter;
    onContinue?: () => void;
    onKeep?: () => void;
}) {
    const state = useMediaStore(useShallow(store => ({
        deleteQueue: store.deleteQueue,
        videoTrashBin: store.videoTrashBin,
        pendingDeletionInfo: store.pendingDeletionInfo,
        deletedCounts: store.deletedCounts,
        lastDeletionResult: store.lastDeletionResult,
        isConfirmingDeletion: store.isConfirmingDeletion,
        isConfirmingVideoTrash: store.isConfirmingVideoTrash,
        mediaLibraryRefreshVersion: store.mediaLibraryRefreshVersion,
        permissionRefreshVersion: store.permissionRefreshVersion,
        permissionScope: store.permissionScope,
        hiddenPhotoQueuedAssetIds: store.hiddenPhotoQueuedAssetIds,
        hiddenVideoQueuedAssetIds: store.hiddenVideoQueuedAssetIds,
    })));
    const { t } = useI18n();
    const { colors } = useThemeColor();
    const [filter, setFilter] = useState<Filter>(initialFilter);
    const [page, setPage] = useState(0);
    const [attempt, setAttempt] = useState(0);
    const [preview, setPreview] = useState<PendingDeletionEntry | null>(null);
    // OS confirmation can pause the App and remount the surrounding feed.
    // Its outcome belongs to the common store, not this transient surface.
    const result = state.lastDeletionResult;
    const confirmingRef = useRef(false);
    const entries = getPendingDeletionEntries(state);
    const filtered = entries.filter(entry => filter === 'all' || entry.type === filter);
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const currentPage = Math.min(page, pageCount - 1);
    const pageEntries = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    const busy = state.isConfirmingDeletion || state.isConfirmingVideoTrash;
    // A changed library snapshot must not keep displaying an old authorized URI.
    const readKey = JSON.stringify([pageEntries.map(entry => [entry.asset.id, entry.type]), state.mediaLibraryRefreshVersion, state.permissionRefreshVersion, attempt]);
    const [read, setRead] = useState<{ key: string; uris: Record<string, string>; failed: boolean } | null>(null);
    const currentRead = read?.key === readKey ? read : null;
    const currentPreview = currentRead ? preview : null;

    useEffect(() => {
        let active = true;
        setPreview(null);
        void (async () => {
            const uris: Record<string, string> = {};
            let failed = false;
            try {
                for (const type of ['photo', 'video'] as const) {
                    const wanted = pageEntries.filter(entry => entry.type === type);
                    if (!wanted.length) continue;
                    const permission = await MediaLibrary.getPermissionsAsync(false, [type]);
                    if (!permission.granted) continue;
                    const readable = await getReadableMediaInfos(wanted.map(entry => entry.asset.id), type);
                    for (const entry of wanted) {
                        const info = readable.get(entry.asset.id);
                        if (info && (info.localUri || info.uri)) uris[entry.asset.id] = info.localUri || info.uri;
                        else failed = true;
                    }
                }
            } catch { failed = true; }
            if (active) setRead({ key: readKey, uris, failed });
        })();
        return () => { active = false; };
        // readKey includes the exact page and invalidation generations.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [readKey]);

    const keep = (id: string) => {
        if (confirmingRef.current || busy) return;
        if (useMediaStore.getState().keepPendingDeletion(id)) onKeep?.();
    };
    const keepAll = () => {
        if (confirmingRef.current || busy || !filtered.length) return;
        if (useMediaStore.getState().keepAllPendingDeletion(filtered.map(entry => entry.asset.id)) > 0) onKeep?.();
    };
    const confirm = async () => {
        if (confirmingRef.current || busy || !filtered.length) return;
        confirmingRef.current = true;
        try { await useMediaStore.getState().confirmPendingDeletion(filtered.map(entry => entry.asset.id)); }
        finally { confirmingRef.current = false; }
    };
    const resultText = result && t(`pending_result_${result.status}`, { deleted: result.deletedIds.length, remaining: result.remainingIds.length });

    return (
        <View testID="pending-deletion-review" style={styles.layout}>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
                <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('photos_review_title')}</Text>
                <Text accessibilityLiveRegion="polite" style={[styles.secondary, { color: colors.textSecondary }]}>{t('pending_count', { count: entries.length })}</Text>
                {!!((state.deletedCounts?.photos ?? 0) + (state.deletedCounts?.videos ?? 0)) && <Text testID="pending-deleted-totals" style={[styles.caption, { color: colors.textSecondary }]}>{t('pending_deleted_totals', { photos: state.deletedCounts.photos, videos: state.deletedCounts.videos })}</Text>}
                <SegmentedControl label={t('pending_filter')} value={filter} onChange={value => { if (!busy) { setFilter(value); setPage(0); } }} options={[
                    { value: 'all', label: t('pending_all') }, { value: 'photo', label: t('tab_photos') }, { value: 'video', label: t('tab_videos') },
                ]} />
                <Text style={[styles.secondary, { color: colors.textSecondary }]}>{t('pending_keep_hint')}</Text>
                {resultText && <Text testID="pending-result" accessibilityRole={result?.status === 'success' ? 'text' : 'alert'} accessibilityLiveRegion="polite" style={[styles.secondary, { color: result?.status === 'success' ? colors.text : colors.danger }]}>{resultText}</Text>}
                {filtered.length === 0 ? <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('pending_empty')}</Text> : <>
                    {!currentRead && <ActivityIndicator color={colors.primary} />}
                    <View style={styles.grid}>
                        {pageEntries.map((entry, index) => {
                            const uri = currentRead?.uris[entry.asset.id];
                            const number = currentPage * PAGE_SIZE + index + 1;
                            return <View key={entry.asset.id} style={styles.tile}>
                                <Pressable accessibilityRole="button" accessibilityLabel={t('pending_preview', { number })} accessibilityState={{ disabled: !uri || busy }} disabled={!uri || busy}
                                    onPress={() => setPreview({ ...entry, asset: { ...entry.asset, uri: uri! } })}
                                    style={[styles.thumbnail, { backgroundColor: colors.surfaceHover }]}>
                                    {uri && entry.type === 'photo' ? <Image source={{ uri }} cachePolicy="memory" contentFit="cover" style={StyleSheet.absoluteFill} />
                                        : <Ionicons name={entry.type === 'video' ? 'play-circle-outline' : 'image-outline'} size={28} color={colors.textSecondary} />}
                                </Pressable>
                                <Text style={[styles.caption, { color: colors.textSecondary }]}>{t(entry.type === 'photo' ? 'tab_photos' : 'tab_videos')} · {t(`pending_source_${entry.source}`)}</Text>
                                {!!currentRead && !uri && <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('pending_unavailable')}</Text>}
                                <Pressable accessibilityRole="button" accessibilityLabel={t('pending_keep', { number })} accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => keep(entry.asset.id)}
                                    style={({ pressed }) => [styles.keep, { backgroundColor: pressed ? colors.selectionBackground : colors.surface, borderColor: colors.divider, opacity: busy ? 0.5 : 1 }]}>
                                    <Text style={[styles.caption, { color: colors.text }]}>{t('pending_keep_short')}</Text>
                                </Pressable>
                            </View>;
                        })}
                    </View>
                    {pageCount > 1 && <View style={styles.pagination}>
                        <Pressable accessibilityRole="button" disabled={busy || currentPage === 0} onPress={() => setPage(currentPage - 1)} style={styles.pageButton}><Text style={{ color: busy || currentPage === 0 ? colors.textTertiary : colors.text }}>{t('photos_review_previous')}</Text></Pressable>
                        <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('photos_review_page', { current: currentPage + 1, total: pageCount })}</Text>
                        <Pressable accessibilityRole="button" disabled={busy || currentPage === pageCount - 1} onPress={() => setPage(currentPage + 1)} style={styles.pageButton}><Text style={{ color: busy || currentPage === pageCount - 1 ? colors.textTertiary : colors.text }}>{t('photos_review_next')}</Text></Pressable>
                    </View>}
                    {currentRead && (currentRead.failed || pageEntries.some(entry => !currentRead.uris[entry.asset.id])) && <View style={styles.recovery}>
                        <Text style={[styles.secondary, { color: colors.textSecondary }]}>{t('pending_access_hint')}</Text>
                        <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={styles.pageButton}><Text style={{ color: colors.text }}>{t('retry')}</Text></Pressable>
                        <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} style={styles.pageButton}><Text style={{ color: colors.text }}>{t('permission_open_settings')}</Text></Pressable>
                    </View>}
                </>}
            </ScrollView>
            <View testID="pending-review-actions" style={[styles.actions, { borderTopColor: colors.divider }]}>
                {filtered.length > 0 && <>
                    <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('photos_review_warning')}</Text>
                    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !currentRead, busy }} disabled={busy || !currentRead} onPress={() => void confirm()}
                        style={[styles.button, { backgroundColor: colors.dangerBackground, opacity: busy || !currentRead ? 0.5 : 1 }]}>
                        <Text style={[styles.buttonText, { color: colors.dangerForeground }]}>{t('pending_confirm', { count: filtered.length })}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" disabled={busy} onPress={keepAll} style={styles.button}><Text style={[styles.buttonText, { color: colors.text }]}>{t('pending_keep_all')}</Text></Pressable>
                </>}
                {onContinue && <Pressable accessibilityRole="button" disabled={busy} onPress={onContinue} style={[styles.button, { backgroundColor: filtered.length ? 'transparent' : colors.actionBackground }]}>
                    <Text style={[styles.buttonText, { color: filtered.length ? colors.textSecondary : colors.actionForeground }]}>{t('pending_continue')}</Text>
                </Pressable>}
            </View>
            <PhotoPreviewModal photo={currentPreview?.type === 'photo' ? currentPreview.asset : null} onClose={() => setPreview(null)} />
            {currentPreview?.type === 'video' && <PendingVideoPreview entry={currentPreview} onClose={() => setPreview(null)} />}
        </View>
    );
}

export function PendingVideoPreview({ entry, onClose }: { entry: PendingDeletionEntry; onClose: () => void }) {
    const { t } = useI18n();
    const { colors } = useThemeColor();
    const insets = useSafeAreaInsets();
    const [failed, setFailed] = useState(false);
    const player = useVideoPlayer(null);
    useEffect(() => {
        let active = true;
        void (async () => {
            try {
                const info = await getReadableMediaInfo(entry.asset.id, 'video', { shouldDownloadFromNetwork: false });
                if (!active) return;
                if (!info || info.id !== entry.asset.id || !(info.localUri || info.uri)) throw new Error('Unavailable');
                await player.replaceAsync(info.localUri || info.uri);
            } catch { if (active) setFailed(true); }
        })();
        const subscription = player.addListener('statusChange', event => { if (active && event.status === 'error') setFailed(true); });
        return () => { active = false; subscription.remove(); };
    }, [entry.asset.id, player]);
    return <Modal visible onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
        <View accessibilityViewIsModal style={[styles.layout, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
            <View style={styles.previewHeader}><Text style={[styles.title, { color: colors.text }]}>{t('tab_videos')}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('close')} onPress={onClose} style={styles.pageButton}><Ionicons name="close-outline" size={24} color={colors.text} /></Pressable></View>
            {failed ? <Text accessibilityRole="alert" style={[styles.empty, { color: colors.textSecondary }]}>{t('pending_unavailable')}</Text> : <VideoView player={player} nativeControls contentFit="contain" style={styles.layout} />}
        </View>
    </Modal>;
}

export function PendingDeletionModal({ visible, onClose, initialFilter = 'all' }: { visible: boolean; onClose: () => void; initialFilter?: Filter }) {
    const busy = useMediaStore(state => state.isConfirmingDeletion || state.isConfirmingVideoTrash);
    const { t } = useI18n();
    const { colors } = useThemeColor();
    const insets = useSafeAreaInsets();
    const reducedMotion = useReducedMotion();
    return <Modal visible={visible} animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={() => { if (!busy) onClose(); }} statusBarTranslucent navigationBarTranslucent>
        {visible && <View accessibilityViewIsModal style={[styles.layout, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
            <View style={styles.modalHeader}><Pressable accessibilityRole="button" accessibilityLabel={t('close')} disabled={busy} onPress={onClose} style={styles.pageButton}><Ionicons name="close-outline" size={24} color={colors.text} /></Pressable></View>
            <PendingDeletionReview initialFilter={initialFilter} onContinue={onClose} />
        </View>}
    </Modal>;
}

export function PendingDeletionButton({ onOpen }: { onOpen?: () => void }) {
    const count = useMediaStore(state => getPendingDeletionEntries(state).length);
    const { t } = useI18n();
    const { colors } = useThemeColor();
    const [visible, setVisible] = useState(false);
    return <>
        <Pressable accessibilityRole="button" accessibilityLabel={t('pending_open', { count })} onPress={() => { onOpen?.(); setVisible(true); }} style={({ pressed }) => [styles.entry, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}>
            <Ionicons name="trash-bin-outline" size={20} color={colors.text} /><Text style={[styles.caption, { color: count ? colors.danger : colors.textSecondary }]}>{count > 99 ? '99+' : count}</Text>
        </Pressable>
        <PendingDeletionModal visible={visible} onClose={() => setVisible(false)} />
    </>;
}

const styles = StyleSheet.create({
    layout: { flex: 1, minHeight: 0 }, scroll: { flex: 1 }, content: { padding: UI_METRICS.pageInset, gap: 14 },
    title: { ...TYPOGRAPHY.pageTitle }, secondary: { ...TYPOGRAPHY.secondary }, caption: { ...TYPOGRAPHY.caption },
    grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 }, tile: { width: '33.333333%', padding: 4, gap: 5 },
    thumbnail: { aspectRatio: 1, borderRadius: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    keep: { minHeight: UI_METRICS.touchTarget, padding: 6, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center', alignItems: 'center' },
    pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 4 },
    pageButton: { minHeight: UI_METRICS.touchTarget, minWidth: UI_METRICS.touchTarget, padding: 10, alignItems: 'center', justifyContent: 'center' },
    actions: { padding: UI_METRICS.pageInset, gap: 6, borderTopWidth: StyleSheet.hairlineWidth },
    button: { minHeight: UI_METRICS.buttonHeight, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
    buttonText: { ...TYPOGRAPHY.button, textAlign: 'center' }, empty: { ...TYPOGRAPHY.body, paddingVertical: 24, textAlign: 'center' },
    recovery: { gap: 4 }, entry: { minHeight: 44, minWidth: 44, padding: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 12 },
    modalHeader: { paddingHorizontal: UI_METRICS.pageInset, alignItems: 'flex-end' }, previewHeader: { padding: UI_METRICS.pageInset, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
