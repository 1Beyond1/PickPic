import { Feather, Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PendingDeletionButton, PendingVideoPreview } from '../components/PendingDeletionReview';
import { PhotoPreviewModal } from '../components/PhotoPreviewModal';
import { SegmentedControl } from '../components/SegmentedControl';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { latestRecentDecisions } from '../services/recentDecisions';
import type { RecentDecision, RecentDecisionResult } from '../services/recentDecisions';
import { readRecentDecisionMedia } from '../services/recentDecisionMedia';
import type { PhotoAsset } from '../stores/useMediaStore';
import { recentDecisionIsCurrent, useMediaStore } from '../stores/useMediaStore';

const PAGE_SIZE = 6;
type Filter = 'all' | 'photo' | 'video';
export default function RecentDecisionsScreen() {
    const router = useRouter(); const { kind } = useLocalSearchParams<{ kind?: string }>();
    const { t } = useI18n(); const { colors } = useThemeColor(); const insets = useSafeAreaInsets();
    const state = useMediaStore(state => state);
    const [filter, setFilter] = useState<Filter>(kind === 'photo' || kind === 'video' ? kind : 'all');
    const [page, setPage] = useState(0), [attempt, setAttempt] = useState(0), [working, setWorking] = useState(false);
    const [result, setResult] = useState<RecentDecisionResult | null>(null);
    const [preview, setPreview] = useState<PhotoAsset | null>(null);
    const guard = useRef(false), mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const entries = latestRecentDecisions(state.recentDecisions);
    const filtered = entries.filter(entry => filter === 'all' || filter === entry.kind);
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
    const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    const readKey = JSON.stringify([visible.map(entry => entry.eventId), state.mediaLibraryRefreshVersion, state.permissionRefreshVersion, attempt]);
    const [read, setRead] = useState<{ key: string; assets: Map<string, PhotoAsset>; failed: boolean } | null>(null);
    const currentRead = read?.key === readKey ? read : null;
    const currentPreview = currentRead ? preview : null;
    const busy = working || state.isConfirmingDeletion || state.isConfirmingVideoTrash;
    useEffect(() => {
        let active = true;
        const initial = useMediaStore.getState();
        const current = () => active && useMediaStore.getState().mediaLibraryRefreshVersion === initial.mediaLibraryRefreshVersion
            && useMediaStore.getState().permissionRefreshVersion === initial.permissionRefreshVersion;
        setPreview(null);
        void (async () => {
            const assets = new Map<string, PhotoAsset>(); let failed = false;
            for (const mediaType of ['photo', 'video'] as const) {
                const rows = visible.filter(entry => entry.kind === mediaType);
                if (!rows.length) continue;
                const response = await readRecentDecisionMedia(mediaType, rows.map(entry => entry.assetId), current);
                if (!current()) return;
                if (response.status !== 'ready') failed = true;
                for (const [id, asset] of response.assets) assets.set(`${mediaType}:${id}`, asset);
            }
            if (current()) setRead({ key: readKey, assets, failed });
        })();
        return () => { active = false; };
        // Includes the exact page, history identities and access generations.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [readKey]);
    const change = async (entry: RecentDecision, action: 'undo' | 'keep' | 'pending') => {
        if (guard.current || busy) return;
        guard.current = true; setWorking(true); setResult(null);
        try {
            const outcome = await useMediaStore.getState().changeRecentDecision(entry.eventId, action);
            if (mounted.current) { setResult(outcome); setAttempt(value => value + 1); }
        } finally { guard.current = false; if (mounted.current) setWorking(false); }
    };
    return <View testID="recent-decisions" style={[styles.screen, { backgroundColor: colors.background,
        paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
        <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('recent_back')} onPress={() => router.back()} style={styles.icon}><Feather name="chevron-left" size={22} color={colors.text} /></Pressable>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('recent_title')}</Text>
            <PendingDeletionButton />
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <Text style={[styles.secondary, { color: colors.textSecondary }]}>{t('recent_hint')}</Text>
            <SegmentedControl label={t('recent_filter')} value={filter} onChange={value => { if (!busy) { setFilter(value); setPage(0); } }} options={[
                { value: 'all', label: t('pending_all') }, { value: 'photo', label: t('tab_photos') }, { value: 'video', label: t('tab_videos') },
            ]} />
            {!!result && <Text testID="recent-feedback" accessibilityLiveRegion="polite" accessibilityRole={result === 'changed' || result === 'unchanged' ? 'text' : 'alert'} style={[styles.secondary, { color: colors.textSecondary }]}>{t(`recent_result_${result}`)}</Text>}
            {!filtered.length ? <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('recent_empty')}</Text> : <>
                {!currentRead && <ActivityIndicator color={colors.primary} />}
                {visible.map((entry, index) => {
                    const asset = currentRead?.assets.get(`${entry.kind}:${entry.assetId}`);
                    const actionable = recentDecisionIsCurrent(state, entry);
                    const number = currentPage * PAGE_SIZE + index + 1;
                    return <View key={entry.eventId} style={[styles.row, { borderColor: colors.divider }]}>
                        <View style={styles.summary}>
                            <Pressable accessibilityRole="button" accessibilityLabel={t('recent_view', { number })} disabled={!asset || busy}
                                onPress={() => setPreview(asset!)} style={[styles.thumbnail, { backgroundColor: colors.surfaceHover }]}>
                                {asset && entry.kind === 'photo' ? <Image source={{ uri: asset.uri }} cachePolicy="memory" contentFit="cover" style={StyleSheet.absoluteFill} />
                                    : <Ionicons name={entry.kind === 'video' ? 'play-circle-outline' : 'image-outline'} size={24} color={colors.textSecondary} />}
                            </Pressable>
                            <View style={styles.copy}>
                                <Text style={[styles.rowTitle, { color: colors.text }]}>{t(`recent_action_${entry.action}`)} · {t(entry.kind === 'photo' ? 'tab_photos' : 'tab_videos')}</Text>
                                <Text style={[styles.caption, { color: colors.textSecondary }]}>{new Date(entry.at).toLocaleString()}</Text>
                                {asset && <Text style={[styles.caption, { color: colors.textSecondary }]}>{asset.filename}</Text>}
                                {!actionable && <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('recent_stale_hint')}</Text>}
                                {!!currentRead && !asset && <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('recent_unavailable')}</Text>}
                            </View>
                        </View>
                        <View style={styles.actions}>
                            {entry.action !== 'keep' || !actionable ? <Pressable accessibilityRole="button" accessibilityLabel={t('recent_keep_item', { number })}
                                disabled={!asset || busy} onPress={() => void change(entry, 'keep')} style={styles.action}><Text style={[styles.actionLabel, { color: !asset || busy ? colors.textTertiary : colors.text }]}>{t('pending_keep_short')}</Text></Pressable> : null}
                            {entry.action !== 'pending' || !actionable ? <Pressable accessibilityRole="button" accessibilityLabel={t('recent_pending_item', { number })}
                                disabled={!asset || busy} onPress={() => void change(entry, 'pending')} style={styles.action}><Text style={[styles.actionLabel, { color: !asset || busy ? colors.textTertiary : colors.danger }]}>{t('recent_pending')}</Text></Pressable> : null}
                            <Pressable accessibilityRole="button" accessibilityLabel={t('recent_undo_item', { number })} disabled={!asset || busy || !actionable}
                                onPress={() => void change(entry, 'undo')} style={styles.action}><Text style={[styles.actionLabel, { color: !asset || busy || !actionable ? colors.textTertiary : colors.textSecondary }]}>{t('recent_undo')}</Text></Pressable>
                        </View>
                    </View>;
                })}
                {pages > 1 && <View style={styles.actions}>
                    <Pressable accessibilityRole="button" disabled={busy || currentPage === 0} onPress={() => setPage(currentPage - 1)} style={styles.action}><Text style={{ color: colors.textSecondary }}>{t('photos_review_previous')}</Text></Pressable>
                    <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('photos_review_page', { current: currentPage + 1, total: pages })}</Text>
                    <Pressable accessibilityRole="button" disabled={busy || currentPage === pages - 1} onPress={() => setPage(currentPage + 1)} style={styles.action}><Text style={{ color: colors.textSecondary }}>{t('photos_review_next')}</Text></Pressable>
                </View>}
                {currentRead && (currentRead.failed || visible.some(entry => !currentRead.assets.has(`${entry.kind}:${entry.assetId}`))) && <View style={styles.recovery}>
                    <Text style={[styles.secondary, { color: colors.textSecondary }]}>{t('recent_access_hint')}</Text>
                    <Pressable accessibilityRole="button" disabled={busy} onPress={() => setAttempt(value => value + 1)} style={styles.action}><Text style={{ color: colors.text }}>{t('retry')}</Text></Pressable>
                    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void Linking.openSettings()} style={styles.action}><Text style={{ color: colors.text }}>{t('permission_open_settings')}</Text></Pressable>
                </View>}
            </>}
        </ScrollView>
        <PhotoPreviewModal photo={currentPreview?.mediaType === 'photo' ? currentPreview : null} onClose={() => setPreview(null)} />
        {currentPreview?.mediaType === 'video' && <PendingVideoPreview entry={{ asset: currentPreview, type: 'video', source: 'unknown', addedAt: 0 }} onClose={() => setPreview(null)} />}
    </View>;
}
const styles = StyleSheet.create({
    screen: { flex: 1 }, scroll: { flex: 1 }, content: { paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 24, gap: 16 },
    header: { paddingHorizontal: UI_METRICS.pageInset, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { ...TYPOGRAPHY.sectionTitle, flex: 1, minWidth: 0 }, icon: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
    secondary: { ...TYPOGRAPHY.secondary }, caption: { ...TYPOGRAPHY.caption }, rowTitle: { ...TYPOGRAPHY.body, fontWeight: '500' },
    row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12, gap: 8 }, summary: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
    thumbnail: { width: 56, height: 56, borderRadius: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    copy: { flex: 1, minWidth: 0, gap: 4 }, actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    action: { minHeight: 44, paddingHorizontal: 8, paddingVertical: 10, justifyContent: 'center', alignItems: 'center', borderRadius: UI_METRICS.buttonRadius },
    actionLabel: { ...TYPOGRAPHY.secondary }, recovery: { gap: 8 }, empty: { ...TYPOGRAPHY.body, textAlign: 'center', paddingVertical: 48 },
});
