import { Feather } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { sameMediaDateFilter } from '../services/mediaMonth';
import type { MediaDateFilter } from '../services/mediaMonth';
import { readOrganizingMonths } from '../services/organizingMonths';
import type { OrganizingMonthsResult } from '../services/organizingMonths';
import { sameSessionScope } from '../services/organizingSession';
import type { OrganizingOrder } from '../services/organizingSession';
import { supportsIndexedMediaSizes } from '../services/mediaSizes';
import { useMediaStore } from '../stores/useMediaStore';
import type { MediaType } from '../stores/useMediaStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { AlbumSelector } from './AlbumSelector';
import { PendingDeletionButton } from './PendingDeletionReview';
import { SegmentedControl } from './SegmentedControl';

export function OrganizingScopeModal(props: { visible: boolean; kind: MediaType; onClose: () => void; onStarted: () => void }) {
    return props.visible ? <ScopeContent {...props} /> : null;
}
function ScopeContent({ kind, onClose, onStarted }: { kind: MediaType; onClose: () => void; onStarted: () => void }) {
    const { colors } = useThemeColor(), { t } = useI18n(), insets = useSafeAreaInsets();
    const settings = useSettingsStore(), state = useMediaStore();
    const previousScope = state.organizingSessions[kind]?.scope;
    const [albumIds, setAlbumIds] = useState(() => [...(previousScope?.albumIds ?? settings.selectedAlbumIds)]);
    const [order, setOrder] = useState<OrganizingOrder>(previousScope?.order ?? settings.displayOrder);
    const sizeSupported = supportsIndexedMediaSizes();
    const [date, setDate] = useState<MediaDateFilter | undefined>(previousScope?.date);
    const [showAlbums, setShowAlbums] = useState(false), [working, setWorking] = useState(false), [attempt, setAttempt] = useState(0);
    const [feedback, setFeedback] = useState<string | null>(null);
    const guard = useRef(false), mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const processed = kind === 'photo' ? state.photoProcessedIds : state.videoProcessedIds;
    const pending = kind === 'photo' ? state.deleteQueue : state.videoTrashBin;
    const collection = kind === 'photo' ? state.collectionQueue : null;
    const busy = working || state.isConfirmingDeletion || state.isConfirmingVideoTrash;
    const readIdentity = useMemo(() => ({ kind, albumIds, processed, pending, collection,
        permissionVersion: state.permissionRefreshVersion, mediaVersion: state.mediaLibraryRefreshVersion, attempt }),
    [kind, albumIds, processed, pending, collection, state.permissionRefreshVersion, state.mediaLibraryRefreshVersion, attempt]);
    const [loaded, setLoaded] = useState<{ identity: object; result: OrganizingMonthsResult } | null>(null);
    const read = loaded?.identity === readIdentity ? loaded.result : null;
    useEffect(() => {
        let active = true;
        const initial = useMediaStore.getState();
        const current = () => active && useMediaStore.getState().permissionRefreshVersion === initial.permissionRefreshVersion
            && useMediaStore.getState().mediaLibraryRefreshVersion === initial.mediaLibraryRefreshVersion;
        setLoaded(null);
        const excluded = new Set([...processed, ...pending.map(asset => asset.id), ...(collection?.map(asset => asset.id) ?? [])]);
        void readOrganizingMonths(kind, albumIds, excluded, current).then(result => { if (current()) setLoaded({ identity: readIdentity, result }); });
        return () => { active = false; };
    }, [readIdentity, kind, albumIds, processed, pending, collection, state.permissionRefreshVersion, state.mediaLibraryRefreshVersion, attempt]);
    const start = async () => {
        if (guard.current || busy || read?.status !== 'ready' || (order === 'largest' && !sizeSupported)) return;
        guard.current = true; setWorking(true); setFeedback(null);
        const before = useMediaStore.getState().organizingSessions[kind];
        const scope = { albumIds, order, ...(date !== undefined ? { date } : {}) };
        try {
            const store = useMediaStore.getState();
            if (kind === 'photo') await store.loadPhotos(settings.groupSize, order, albumIds, 'new', date);
            else await store.loadVideos(50, order, albumIds, 'new', date);
            const latest = useMediaStore.getState().organizingSessions[kind];
            if (latest && latest !== before && sameSessionScope(latest.scope, scope)) onStarted();
            else if (mounted.current) { setFeedback(t(order === 'largest' ? 'scope_size_failed' : 'scope_start_failed')); setAttempt(value => value + 1); }
        } catch {
            if (mounted.current) { setFeedback(t('scope_start_failed')); setAttempt(value => value + 1); }
        } finally { guard.current = false; if (mounted.current) setWorking(false); }
    };
    const chooseDate = (value?: MediaDateFilter) => { if (!busy) { setDate(value); setFeedback(null); } };
    const dateLabel = (value?: MediaDateFilter) => value === 'unknown' ? t('scope_unknown_date') : value
        ? t('scope_month_value', { year: value.year, month: value.month }) : t('scope_all_months');
    const row = (value: MediaDateFilter | undefined, count?: number) => {
        const label = dateLabel(value), selected = sameMediaDateFilter(date, value);
        return <Pressable key={label} accessibilityRole="radio" accessibilityLabel={label}
            accessibilityState={{ checked: selected, disabled: busy }} disabled={busy} onPress={() => chooseDate(value)}
            style={[styles.row, { backgroundColor: selected ? colors.surfaceHover : 'transparent', borderColor: colors.divider }]}>
            <View style={styles.copy}><Text style={[styles.label, { color: colors.text }]}>{label}</Text>
                {count !== undefined && <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('scope_unprocessed_count', { count })}</Text>}</View>
            <Feather name={selected ? 'check-circle' : 'circle'} size={20} color={selected ? colors.text : colors.textTertiary} />
        </Pressable>;
    };
    return <Modal visible animationType="none" onRequestClose={() => { if (!busy) onClose(); }}>
        <View testID="organizing-scope" style={[styles.screen, { backgroundColor: colors.background, paddingTop: insets.top,
            paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
            <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={t('scope_back')} disabled={busy} onPress={onClose} style={styles.icon}>
                <Feather name="chevron-left" size={22} color={colors.text} /></Pressable>
                <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('scope_title')}</Text><PendingDeletionButton /></View>
            <ScrollView contentContainerStyle={styles.content}>
                <Text style={[styles.secondary, { color: colors.textSecondary }]}>{t('scope_new_round_hint')}</Text>
                <Text accessibilityRole="header" style={[styles.section, { color: colors.text }]}>{t(kind === 'photo' ? 'tab_photos' : 'tab_videos')}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t('scope_albums')} disabled={busy} onPress={() => setShowAlbums(true)} style={[styles.row, { borderColor: colors.divider }]}>
                    <View style={styles.copy}><Text style={[styles.label, { color: colors.text }]}>{t('scope_albums')}</Text>
                        <Text style={[styles.caption, { color: colors.textSecondary }]}>{t(albumIds.length ? 'scope_album_count' : 'scope_all_albums', { count: albumIds.length })}</Text></View>
                    <Feather name="chevron-right" size={18} color={colors.textSecondary} /></Pressable>
                <Text accessibilityRole="header" style={[styles.section, { color: colors.text }]}>{t('settings_display_order')}</Text>
                <SegmentedControl label={t('settings_display_order')} value={order} onChange={value => { if (!busy) setOrder(value); }} options={[
                    { value: 'oldest', label: t('display_order_oldest') }, { value: 'newest', label: t('display_order_newest') }, { value: 'random', label: t('display_order_random') },
                ]} />
                <Pressable accessibilityRole="radio" accessibilityLabel={t('session_order_largest')}
                    accessibilityState={{ checked: order === 'largest', disabled: busy || !sizeSupported }} disabled={busy || !sizeSupported}
                    onPress={() => { setOrder('largest'); setFeedback(null); }}
                    style={[styles.row, { borderColor: colors.divider, backgroundColor: order === 'largest' ? colors.surfaceHover : 'transparent' }]}>
                    <View style={styles.copy}><Text style={[styles.label, { color: colors.text }]}>{t('session_order_largest')}</Text>
                        <Text style={[styles.caption, { color: colors.textSecondary }]}>{t(sizeSupported ? 'scope_size_hint' : 'scope_size_unavailable')}</Text></View>
                    <Feather name={order === 'largest' ? 'check-circle' : 'circle'} size={20} color={sizeSupported ? colors.text : colors.textTertiary} />
                </Pressable>
                <Text accessibilityRole="header" style={[styles.section, { color: colors.text }]}>{t('scope_months')}</Text>
                <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('scope_selected_date', { value: dateLabel(date) })}</Text>
                {row(undefined)}
                {!read && <ActivityIndicator accessibilityLabel={t('scope_reading')} color={colors.primary} />}
                {read?.status === 'ready' ? <>
                    {read.limited && <Text style={[styles.secondary, { color: colors.textSecondary }]}>{t('scope_limited_hint')}</Text>}
                    {!read.months.length && !read.unknownDateCount && <Text style={[styles.secondary, { color: colors.textSecondary }]}>{t('scope_empty')}</Text>}
                    {read.months.map(month => row({ year: month.year, month: month.month, startInclusive: month.startInclusive, endExclusive: month.endExclusive }, month.count))}
                    {row('unknown', read.unknownDateCount)}
                </> : read && <View style={styles.recovery}>
                    <Text accessibilityRole="alert" style={[styles.secondary, { color: colors.textSecondary }]}>{t(`scope_read_${read.status}`)}</Text>
                    <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={styles.row}><Text style={{ color: colors.text }}>{t('retry')}</Text></Pressable>
                    {read.status === 'permission' && <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} style={styles.row}><Text style={{ color: colors.text }}>{t('permission_open_settings')}</Text></Pressable>}
                </View>}
                {feedback && <Text accessibilityRole="alert" style={[styles.secondary, { color: colors.textSecondary }]}>{feedback}</Text>}
                <Pressable accessibilityRole="button" accessibilityLabel={t('scope_start')} disabled={busy || read?.status !== 'ready' || (order === 'largest' && !sizeSupported)}
                    accessibilityState={{ disabled: busy || read?.status !== 'ready' || (order === 'largest' && !sizeSupported), busy: working }} onPress={() => void start()}
                    style={[styles.start, { backgroundColor: colors.actionBackground, opacity: busy || read?.status !== 'ready' || (order === 'largest' && !sizeSupported) ? 0.4 : 1 }]}>
                    <Text style={[styles.label, { color: colors.actionForeground }]}>{t(working ? 'scope_starting' : 'scope_start')}</Text></Pressable>
            </ScrollView>
            <AlbumSelector visible={showAlbums} initialSelection={albumIds} onClose={() => setShowAlbums(false)} onConfirm={ids => { setAlbumIds(ids); setShowAlbums(false); }} />
        </View>
    </Modal>;
}
export function OrganizingScopeButton({ onPress }: { onPress: () => void }) {
    const { t } = useI18n(), { colors } = useThemeColor();
    return <Pressable accessibilityRole="button" accessibilityLabel={t('scope_title')} onPress={onPress} style={styles.scopeButton}>
        <Feather name="sliders" size={18} color={colors.textSecondary} /><Text style={[styles.secondary, { color: colors.text }]}>{t('scope_title')}</Text>
    </Pressable>;
}
const styles = StyleSheet.create({
    screen: { flex: 1 }, header: { paddingHorizontal: UI_METRICS.pageInset, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
    icon: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }, title: { ...TYPOGRAPHY.sectionTitle, flex: 1, minWidth: 0 },
    content: { paddingHorizontal: UI_METRICS.pageInset, paddingBottom: 24, gap: 12 }, section: { ...TYPOGRAPHY.body, fontWeight: '600', marginTop: 8 },
    secondary: { ...TYPOGRAPHY.secondary }, label: { ...TYPOGRAPHY.body }, caption: { ...TYPOGRAPHY.caption }, copy: { flex: 1, minWidth: 0, gap: 4 },
    row: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row', gap: 12, alignItems: 'center', borderRadius: 8 }, recovery: { gap: 8 },
    start: { minHeight: 48, borderRadius: UI_METRICS.buttonRadius, paddingHorizontal: 16, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
    scopeButton: { minHeight: 44, minWidth: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 8 },
});
