import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import {
    scanExactDuplicatesFromIndexedPhotos,
    selectExactDuplicateKeepIds,
    selectExactDuplicateQueueIds,
    type ExactDuplicateGroup,
    type ExactDuplicateKeepStrategy,
    type ExactDuplicateMember,
    type ExactDuplicateProgress,
    type ExactDuplicateScanResult,
} from '../services/exactDuplicates';
import { flushMediaProgress } from '../services/mediaProgressStorage';
import { getPendingDeletionEntries } from '../services/pendingDeletion';
import { isAssetProtected } from '../services/protectedAlbums';
import { getReadableMediaInfos } from '../services/readableMedia';
import { isRecordTransferActive } from '../services/recordOperationLock';
import { useMediaStore } from '../stores/useMediaStore';
import { SegmentedControl } from './SegmentedControl';
import { ZoomablePhotoModal } from './ZoomablePhotoModal';

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

export interface ExactDuplicatesViewProps {
    completedCount: number | null;
    onOpenSettings: () => void;
}

export function ExactDuplicatesView({ completedCount, onOpenSettings }: ExactDuplicatesViewProps) {
    const { colors } = useThemeColor();
    const { t, language } = useI18n();
    const deleteQueue = useMediaStore(state => state.deleteQueue);
    const protectedAlbums = useMediaStore(state => state.protectedAlbums);
    const protectedAssetIds = useMediaStore(state => state.protectedAssetIds);
    const permissionRefreshVersion = useMediaStore(state => state.permissionRefreshVersion ?? 0);
    const lastDeletionResult = useMediaStore(state => state.lastDeletionResult ?? null);

    const pendingDeleteIdSet = useMemo(() => new Set((deleteQueue ?? []).map(asset => asset.id)), [deleteQueue]);
    const protectedAlbumIdSet = useMemo(
        () => new Set((protectedAlbums ?? []).map(album => album.albumId)),
        [protectedAlbums],
    );
    const protectedAssetIdSet = useMemo(
        () => new Set(protectedAssetIds ?? []),
        [protectedAssetIds],
    );

    const [strategy, setStrategy] = useState<ExactDuplicateKeepStrategy>('protected_and_earliest');
    const [isScanningExact, setIsScanningExact] = useState(false);
    const [progress, setProgress] = useState<ExactDuplicateProgress | null>(null);
    const [scanResult, setScanResult] = useState<ExactDuplicateScanResult | null>(null);
    const [scanError, setScanError] = useState(false);
    const [keepOverrides, setKeepOverrides] = useState<Record<string, string[]>>({});
    const [feedback, setFeedback] = useState<string | null>(null);
    const [isQueueing, setIsQueueing] = useState(false);
    const [previewMember, setPreviewMember] = useState<ExactDuplicateMember | null>(null);

    const scanRunIdRef = useRef(0);
    const cancelledRef = useRef(false);
    const queueingRef = useRef(false);
    const prevPermVersionRef = useRef(permissionRefreshVersion);
    const prevDeletionResultRef = useRef(lastDeletionResult);

    // Clear stale results immediately when permissions change.
    useEffect(() => {
        if (permissionRefreshVersion === prevPermVersionRef.current) return;
        prevPermVersionRef.current = permissionRefreshVersion;
        cancelledRef.current = true;
        scanRunIdRef.current += 1;
        setIsScanningExact(false);
        setProgress(null);
        setScanResult(null);
        setScanError(false);
        setKeepOverrides({});
        setPreviewMember(null);
        setFeedback(null);
    }, [permissionRefreshVersion]);

    // Remove confirmed physically deleted photos from displayed groups immediately.
    useEffect(() => {
        if (lastDeletionResult === prevDeletionResultRef.current) return;
        prevDeletionResultRef.current = lastDeletionResult;
        if (!lastDeletionResult || lastDeletionResult.deletedIds.length === 0) return;

        const deletedSet = new Set(lastDeletionResult.deletedIds);
        setScanResult(previous => {
            if (!previous) return previous;
            const groups = previous.groups
                .map(group => {
                    const remaining = group.members.filter(member => !deletedSet.has(member.assetId));
                    if (remaining.length < 2) return null;
                    const recommendedKeepIds = selectExactDuplicateKeepIds(remaining, strategy);
                    return {
                        ...group,
                        members: remaining,
                        recommendedKeepIds,
                        reclaimableBytes: group.fileSize * Math.max(0, remaining.length - recommendedKeepIds.length),
                    };
                })
                .filter((group): group is ExactDuplicateGroup => group !== null);
            return { ...previous, groups };
        });
        setPreviewMember(prev => (prev && deletedSet.has(prev.assetId) ? null : prev));
    }, [lastDeletionResult, strategy]);

    useEffect(() => () => {
        cancelledRef.current = true;
        scanRunIdRef.current += 1;
    }, []);

    // Recompute live protection flag on every member whenever protected albums change.
    const resolvedGroups = useMemo(() => {
        if (!scanResult || scanResult.status !== 'ready') return [] as ExactDuplicateGroup[];
        return scanResult.groups.map(group => {
            const members = group.members.map(member => ({
                ...member,
                isProtected: isAssetProtected(
                    { id: member.assetId, albumId: member.albumId },
                    protectedAlbumIdSet,
                    protectedAssetIdSet,
                ),
            }));
            const recommendedKeepIds = selectExactDuplicateKeepIds(members, strategy);
            const redundantCount = Math.max(0, members.length - recommendedKeepIds.length);
            return {
                ...group,
                members,
                recommendedKeepIds,
                reclaimableBytes: group.fileSize * redundantCount,
            };
        });
    }, [protectedAlbumIdSet, protectedAssetIdSet, scanResult, strategy]);

    const getEffectiveKeepSet = useCallback((group: ExactDuplicateGroup): Set<string> => {
        const override = keepOverrides[group.sha256];
        const keep = new Set<string>(override ?? group.recommendedKeepIds);
        // Protected members are ALWAYS locked as kept.
        for (const member of group.members) {
            if (member.isProtected) keep.add(member.assetId);
        }
        if (keep.size === 0 && group.members.length > 0) {
            keep.add(group.members[0].assetId);
        }
        return keep;
    }, [keepOverrides]);

    const toggleMemberKeep = useCallback((group: ExactDuplicateGroup, member: ExactDuplicateMember) => {
        if (member.isProtected) {
            setFeedback(t('exact_dup_protected_keep_locked'));
            return;
        }
        const current = getEffectiveKeepSet(group);
        const next = new Set(current);
        if (next.has(member.assetId)) {
            if (next.size <= 1) {
                setFeedback(t('exact_dup_keep_at_least_one'));
                return;
            }
            next.delete(member.assetId);
        } else {
            next.add(member.assetId);
        }
        setFeedback(null);
        setKeepOverrides(previous => ({ ...previous, [group.sha256]: Array.from(next) }));
    }, [getEffectiveKeepSet, t]);

    const handleStrategyChange = useCallback((nextStrategy: ExactDuplicateKeepStrategy) => {
        setStrategy(nextStrategy);
        setKeepOverrides({});
        setFeedback(null);
    }, []);

    const startDetection = useCallback(async () => {
        const runId = ++scanRunIdRef.current;
        cancelledRef.current = false;
        setIsScanningExact(true);
        setScanError(false);
        setFeedback(null);
        setKeepOverrides({});
        setProgress({ phase: 'bucketing', totalCandidates: 0, hashedCount: 0, skippedUnreadableCount: 0 });
        try {
            const result = await scanExactDuplicatesFromIndexedPhotos({
                protectedAlbumIds: protectedAlbumIdSet,
                protectedAssetIds: protectedAssetIdSet,
                isCancelled: () => cancelledRef.current || scanRunIdRef.current !== runId,
                onProgress: next => {
                    if (scanRunIdRef.current === runId) {
                        setProgress(next);
                    }
                },
            });
            if (scanRunIdRef.current !== runId) return;
            setScanResult(result);
            if (result.status === 'cancelled') {
                setFeedback(t('exact_dup_cancelled'));
            } else if (result.status === 'permission') {
                setFeedback(t('exact_dup_permission_required'));
            }
        } catch {
            if (scanRunIdRef.current === runId) {
                setScanError(true);
                setFeedback(t('exact_dup_failed'));
            }
        } finally {
            if (scanRunIdRef.current === runId) {
                setIsScanningExact(false);
            }
        }
    }, [protectedAlbumIdSet, protectedAssetIdSet, t]);

    const cancelDetection = useCallback(() => {
        cancelledRef.current = true;
    }, []);

    const queueAssetIds = useCallback(async (assetIds: readonly string[]) => {
        const uniqueIds = Array.from(new Set(assetIds.filter(Boolean)));
        if (uniqueIds.length === 0 || queueingRef.current) return;
        const initialStore = useMediaStore.getState();
        const refreshVersion = initialStore.mediaLibraryRefreshVersion;
        const permVersion = initialStore.permissionRefreshVersion ?? 0;

        queueingRef.current = true;
        setIsQueueing(true);
        setFeedback(null);
        try {
            const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
            if (!permission.granted) throw new Error('Unavailable');

            const infoMap = await getReadableMediaInfos(uniqueIds, 'photo', {
                shouldDownloadFromNetwork: false,
            });
            const store = useMediaStore.getState();
            if (
                refreshVersion !== store.mediaLibraryRefreshVersion
                || permVersion !== (store.permissionRefreshVersion ?? 0)
            ) {
                throw new Error('Access changed');
            }
            if (!store.hasHydrated || store.isConfirmingDeletion || store.isConfirmingVideoTrash || isRecordTransferActive()) {
                throw new Error('Busy');
            }

            const assets = uniqueIds
                .map(id => infoMap.get(id))
                .filter((info): info is NonNullable<typeof info> => !!info && info.mediaType === 'photo');
            if (assets.length === 0) throw new Error('Unavailable');

            const unprotected: typeof assets = [];
            let protectedSkipped = 0;
            for (const asset of assets) {
                if (isAssetProtected(asset, protectedAlbumIdSet, protectedAssetIdSet)) {
                    protectedSkipped++;
                } else {
                    unprotected.push(asset);
                }
            }

            let added = 0;
            if (unprotected.length > 0) {
                const before = new Set(getPendingDeletionEntries(store).map(entry => entry.asset.id));
                const report = typeof store.enqueuePendingDeletionWithReport === 'function'
                    ? store.enqueuePendingDeletionWithReport(unprotected, 'exact_duplicate')
                    : (() => {
                        const count = store.enqueuePendingDeletion(unprotected, 'exact_duplicate');
                        return { added: count, alreadyQueued: 0, protectedSkipped: 0, protectedAssetIds: [] as string[] };
                    })();
                added = report.added;
                protectedSkipped += report.protectedSkipped;
                const unprotectedRequested = unprotected.filter(asset => !report.protectedAssetIds.includes(asset.id));
                if (!added && report.protectedSkipped === 0 && unprotectedRequested.some(asset => !before.has(asset.id))) {
                    throw new Error('Record mutation is blocked');
                }
                if (added > 0) {
                    await flushMediaProgress();
                }
            }

            if (protectedSkipped > 0) {
                setFeedback(added > 0
                    ? t('protected_batch_skipped_feedback', { added, skipped: protectedSkipped })
                    : t('protected_all_skipped_feedback', { skipped: protectedSkipped }));
            } else {
                setFeedback(t(added > 0 ? 'pending_added' : 'pending_already_added'));
            }
        } catch {
            setFeedback(t('pending_add_failed'));
        } finally {
            queueingRef.current = false;
            setIsQueueing(false);
        }
    }, [protectedAlbumIdSet, protectedAssetIdSet, t]);

    const allQueueableIds = useMemo(() => {
        const ids: string[] = [];
        for (const group of resolvedGroups) {
            const keepSet = getEffectiveKeepSet(group);
            ids.push(...selectExactDuplicateQueueIds(group, keepSet));
        }
        return ids;
    }, [getEffectiveKeepSet, resolvedGroups]);

    const totalReclaimableBytes = useMemo(() => {
        let total = 0;
        for (const group of resolvedGroups) {
            const keepSet = getEffectiveKeepSet(group);
            const queueIds = selectExactDuplicateQueueIds(group, keepSet);
            total += group.fileSize * queueIds.length;
        }
        return total;
    }, [getEffectiveKeepSet, resolvedGroups]);

    const hasIncompleteCoverage = !!scanResult
        && scanResult.status === 'ready'
        && (
            scanResult.skippedUnknownSizeCount > 0
            || scanResult.skippedUnreadableCount > 0
            || scanResult.skippedOversizedCount > 0
        );

    const renderGroup = ({ item: group }: { item: ExactDuplicateGroup }) => {
        const keepSet = getEffectiveKeepSet(group);
        const queueIds = selectExactDuplicateQueueIds(group, keepSet);
        const allProtected = group.members.every(member => member.isProtected);

        return (
            <View
                testID={`exact-dup-group-${group.sha256.slice(0, 12)}`}
                style={[styles.groupCard, { backgroundColor: colors.surface, borderColor: colors.divider }]}
            >
                <View style={styles.groupHeader}>
                    <Text style={[styles.groupTitle, { color: colors.text }]}>
                        {t('exact_dup_group_header', { count: group.members.length, size: formatBytes(group.fileSize) })}
                    </Text>
                    <Text style={[styles.caption, { color: colors.textSecondary }]}>
                        {t('exact_dup_hash_label', { hash: group.sha256.slice(0, 12) })}
                    </Text>
                </View>

                <View style={styles.memberList}>
                    {group.members.map(member => {
                        const isKept = keepSet.has(member.assetId);
                        const isQueued = pendingDeleteIdSet.has(member.assetId);
                        const dateText = member.creationTime
                            ? new Date(member.creationTime).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')
                            : t('similar_unknown');
                        const resolutionText = member.width > 0 && member.height > 0
                            ? `${member.width} × ${member.height}`
                            : t('similar_unknown');

                        return (
                            <View
                                key={member.assetId}
                                style={[styles.memberRow, { borderTopColor: colors.divider }]}
                            >
                                <Pressable
                                    testID={`exact-dup-preview-${member.assetId}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('exact_dup_open_preview')}
                                    onPress={() => setPreviewMember(member)}
                                    style={styles.memberPreviewTouch}
                                >
                                    <Image
                                        source={{ uri: member.uri }}
                                        cachePolicy="memory"
                                        contentFit="cover"
                                        style={[styles.thumbnail, { backgroundColor: colors.surfaceHover }]}
                                    />
                                    <View style={styles.memberMeta}>
                                        <Text style={[styles.metaTitle, { color: colors.text }]} numberOfLines={1}>
                                            {dateText}
                                        </Text>
                                        <Text style={[styles.caption, { color: colors.textSecondary }]} numberOfLines={1}>
                                            {resolutionText}
                                        </Text>
                                        <View style={styles.badgeRow}>
                                            {member.isProtected && (
                                                <View
                                                    testID={`exact-dup-protected-${member.assetId}`}
                                                    style={[styles.pill, { backgroundColor: colors.surfaceHover }]}
                                                >
                                                    <Ionicons name="shield-checkmark" size={12} color={colors.primary} />
                                                    <Text style={[styles.pillText, { color: colors.primary }]}>
                                                        {t('protected_badge')}
                                                    </Text>
                                                </View>
                                            )}
                                            {isQueued && (
                                                <View style={[styles.pill, { backgroundColor: colors.surfaceHover }]}>
                                                    <Text style={[styles.pillText, { color: colors.danger }]}>
                                                        {t('pending_already_added')}
                                                    </Text>
                                                </View>
                                            )}
                                        </View>
                                    </View>
                                </Pressable>

                                <Pressable
                                    testID={`exact-dup-toggle-${member.assetId}`}
                                    accessibilityRole="checkbox"
                                    accessibilityLabel={member.isProtected
                                        ? t('exact_dup_protected_keep_locked')
                                        : t(isKept ? 'exact_dup_keep_badge' : 'exact_dup_remove_badge')}
                                    accessibilityState={{ checked: isKept, disabled: member.isProtected || isQueueing }}
                                    disabled={isQueueing}
                                    onPress={() => toggleMemberKeep(group, member)}
                                    style={[
                                        styles.keepChip,
                                        {
                                            backgroundColor: isKept ? colors.selectionBackground : colors.surfaceHover,
                                            borderColor: member.isProtected ? colors.primary : colors.divider,
                                            opacity: member.isProtected ? 0.9 : 1,
                                        },
                                    ]}
                                >
                                    <Ionicons
                                        name={member.isProtected ? 'shield-checkmark' : isKept ? 'checkmark-circle' : 'trash-outline'}
                                        size={16}
                                        color={member.isProtected ? colors.primary : isKept ? colors.success : colors.danger}
                                    />
                                    <Text
                                        style={[
                                            styles.keepChipText,
                                            { color: isKept ? colors.text : colors.danger },
                                        ]}
                                    >
                                        {t(isKept ? 'exact_dup_keep_badge' : 'exact_dup_remove_badge')}
                                    </Text>
                                </Pressable>
                            </View>
                        );
                    })}
                </View>

                {allProtected ? (
                    <Text style={[styles.caption, { color: colors.textSecondary }]}>
                        {t('exact_dup_all_protected_hint')}
                    </Text>
                ) : queueIds.length > 0 ? (
                    <Pressable
                        testID={`exact-dup-queue-group-${group.sha256.slice(0, 12)}`}
                        accessibilityRole="button"
                        accessibilityLabel={t('exact_dup_group_queue_action', { count: queueIds.length })}
                        disabled={isQueueing}
                        onPress={() => void queueAssetIds(queueIds)}
                        style={[
                            styles.groupQueueButton,
                            { backgroundColor: colors.dangerBackground, opacity: isQueueing ? 0.5 : 1 },
                        ]}
                    >
                        <Text style={[styles.buttonText, { color: colors.dangerForeground }]}>
                            {t('exact_dup_group_queue_action', { count: queueIds.length })}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        );
    };

    if (completedCount === 0 && !scanResult && !isScanningExact) {
        return (
            <View style={styles.emptyWrap}>
                <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
                    {t('scan_results_not_ready')}
                </Text>
                <Text style={[styles.body, { color: colors.textSecondary }]}>
                    {t('scan_results_not_ready_desc')}
                </Text>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('scan_open_settings')}
                    onPress={onOpenSettings}
                    style={[styles.primaryButton, { backgroundColor: colors.actionBackground }]}
                >
                    <Text style={[styles.buttonText, { color: colors.actionForeground }]}>
                        {t('scan_open_settings')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View testID="exact-duplicates-view" style={styles.container}>
            <FlatList<ExactDuplicateGroup>
                testID="exact-duplicates-list"
                data={resolvedGroups}
                extraData={{ keepOverrides, pendingDeleteIdSet, strategy, isQueueing }}
                renderItem={renderGroup}
                keyExtractor={item => item.sha256}
                contentContainerStyle={styles.listContent}
                ListHeaderComponent={
                    <View style={styles.headerBlock}>
                        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
                            {t('exact_dup_title')}
                        </Text>
                        <Text style={[styles.body, { color: colors.textSecondary }]}>
                            {t('exact_dup_desc')}
                        </Text>

                        <View style={styles.actionRow}>
                            {!isScanningExact ? (
                                <Pressable
                                    testID="exact-dup-start-btn"
                                    accessibilityRole="button"
                                    accessibilityLabel={t(scanResult ? 'exact_dup_rescan' : 'exact_dup_start')}
                                    disabled={isQueueing}
                                    onPress={() => void startDetection()}
                                    style={[
                                        styles.primaryButton,
                                        { backgroundColor: colors.actionBackground, opacity: isQueueing ? 0.5 : 1 },
                                    ]}
                                >
                                    <Text style={[styles.buttonText, { color: colors.actionForeground }]}>
                                        {t(scanResult ? 'exact_dup_rescan' : 'exact_dup_start')}
                                    </Text>
                                </Pressable>
                            ) : (
                                <View style={styles.progressBox}>
                                    <ActivityIndicator size="small" color={colors.primary} />
                                    <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.text, flex: 1 }]}>
                                        {progress && progress.totalCandidates > 0
                                            ? t('exact_dup_progress_hashing', {
                                                hashed: progress.hashedCount,
                                                total: progress.totalCandidates,
                                            })
                                            : t('exact_dup_progress_bucketing')}
                                    </Text>
                                    <Pressable
                                        testID="exact-dup-cancel-btn"
                                        accessibilityRole="button"
                                        accessibilityLabel={t('exact_dup_cancel')}
                                        onPress={cancelDetection}
                                        style={[styles.cancelChip, { backgroundColor: colors.surfaceHover }]}
                                    >
                                        <Text style={[styles.caption, { color: colors.text }]}>{t('exact_dup_cancel')}</Text>
                                    </Pressable>
                                </View>
                            )}
                        </View>

                        {feedback && (
                            <Text testID="exact-dup-feedback" accessibilityLiveRegion="polite" style={[styles.body, { color: scanError ? colors.danger : colors.textSecondary }]}>
                                {feedback}
                            </Text>
                        )}

                        {scanResult?.status === 'ready' && scanResult.permissionLimited && (
                            <Text style={[styles.caption, { color: colors.textSecondary }]}>
                                {t('exact_dup_limited_warning')}
                            </Text>
                        )}

                        {hasIncompleteCoverage && scanResult && (
                            <Text testID="exact-dup-incomplete-warning" style={[styles.caption, { color: colors.textSecondary }]}>
                                {t('exact_dup_incomplete_warning', {
                                    unknown: scanResult.skippedUnknownSizeCount,
                                    unreadable: scanResult.skippedUnreadableCount,
                                    oversized: scanResult.skippedOversizedCount,
                                })}
                            </Text>
                        )}

                        {resolvedGroups.length > 0 && (
                            <View style={styles.summaryControls}>
                                <Text testID="exact-dup-summary" style={[styles.body, { color: colors.text, fontWeight: '600' }]}>
                                    {t('exact_dup_summary', {
                                        groups: resolvedGroups.length,
                                        copies: allQueueableIds.length,
                                        size: formatBytes(totalReclaimableBytes),
                                    })}
                                </Text>
                                <SegmentedControl
                                    label={t('exact_dup_strategy_label')}
                                    value={strategy}
                                    onChange={handleStrategyChange}
                                    options={[
                                        { value: 'protected_and_earliest', label: t('exact_dup_strategy_protected') },
                                        { value: 'earliest', label: t('exact_dup_strategy_earliest') },
                                    ]}
                                />
                                {allQueueableIds.length > 0 && (
                                    <Pressable
                                        testID="exact-dup-batch-queue-btn"
                                        accessibilityRole="button"
                                        accessibilityLabel={t('exact_dup_batch_queue', { count: allQueueableIds.length })}
                                        disabled={isQueueing}
                                        onPress={() => void queueAssetIds(allQueueableIds)}
                                        style={[
                                            styles.primaryButton,
                                            { backgroundColor: colors.dangerBackground, opacity: isQueueing ? 0.5 : 1 },
                                        ]}
                                    >
                                        <Text style={[styles.buttonText, { color: colors.dangerForeground }]}>
                                            {t('exact_dup_batch_queue', { count: allQueueableIds.length })}
                                        </Text>
                                    </Pressable>
                                )}
                            </View>
                        )}
                    </View>
                }
                ListEmptyComponent={
                    scanResult?.status === 'ready' && !isScanningExact ? (
                        <View style={styles.emptyState}>
                            <Text style={[styles.body, { color: colors.textSecondary }]}>
                                {t('exact_dup_no_results')}
                            </Text>
                        </View>
                    ) : null
                }
            />

            <ZoomablePhotoModal
                testID="exact-dup-zoom-preview"
                visible={!!previewMember}
                photo={previewMember ? { id: previewMember.assetId, uri: previewMember.uri } : null}
                title={t('photo_detail_title')}
                subtitle={previewMember ? `${formatBytes(previewMember.fileSize)}${previewMember.width > 0 && previewMember.height > 0 ? ` · ${previewMember.width} × ${previewMember.height}` : ''}` : undefined}
                isProtected={previewMember?.isProtected ?? false}
                feedback={feedback}
                onClose={() => setPreviewMember(null)}
                actions={previewMember && !previewMember.isProtected ? [
                    {
                        id: 'queue',
                        testID: 'exact-dup-preview-queue',
                        label: pendingDeleteIdSet.has(previewMember.assetId) ? t('pending_already_added') : t('pending_add'),
                        icon: pendingDeleteIdSet.has(previewMember.assetId) ? 'trash' : 'trash-outline',
                        tone: 'danger',
                        disabled: isQueueing,
                        onPress: () => { void queueAssetIds([previewMember.assetId]); },
                    },
                ] : []}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    listContent: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingBottom: 24,
        gap: 14,
    },
    headerBlock: {
        paddingTop: 8,
        paddingBottom: 8,
        gap: 12,
    },
    title: { ...TYPOGRAPHY.sectionTitle },
    body: { ...TYPOGRAPHY.secondary },
    caption: { ...TYPOGRAPHY.caption },
    actionRow: { gap: 10 },
    primaryButton: {
        minHeight: UI_METRICS.buttonHeight,
        borderRadius: UI_METRICS.buttonRadius,
        paddingHorizontal: 16,
        paddingVertical: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonText: { ...TYPOGRAPHY.button, textAlign: 'center' },
    progressBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
    },
    cancelChip: {
        minHeight: UI_METRICS.touchTarget,
        paddingHorizontal: 12,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    summaryControls: { gap: 10 },
    groupCard: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        padding: 12,
        gap: 10,
    },
    groupHeader: { gap: 2 },
    groupTitle: { ...TYPOGRAPHY.button },
    memberList: { gap: 4 },
    memberRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    memberPreviewTouch: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    thumbnail: {
        width: 56,
        height: 56,
        borderRadius: 8,
    },
    memberMeta: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    metaTitle: { ...TYPOGRAPHY.body },
    badgeRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 2,
    },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
    },
    pillText: { ...TYPOGRAPHY.caption, fontWeight: '600' },
    keepChip: {
        minHeight: UI_METRICS.touchTarget,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    keepChipText: { ...TYPOGRAPHY.caption, fontWeight: '600' },
    groupQueueButton: {
        minHeight: UI_METRICS.touchTarget,
        borderRadius: UI_METRICS.buttonRadius,
        paddingHorizontal: 12,
        paddingVertical: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyWrap: {
        paddingHorizontal: UI_METRICS.pageInset,
        paddingVertical: 32,
        gap: 12,
    },
    emptyState: {
        paddingVertical: 24,
        alignItems: 'center',
    },
});
