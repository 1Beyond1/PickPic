import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { recentDecisionIsCurrent, useMediaStore } from '../stores/useMediaStore';
import type { MediaType } from '../stores/useMediaStore';
import type { RecentDecisionResult } from '../services/recentDecisions';

export function RecentDecisionsButton({ kind, iconOnly = false }: { kind?: MediaType; iconOnly?: boolean }) {
    const router = useRouter(); const { t } = useI18n(); const { colors } = useThemeColor();
    return <Pressable accessibilityRole="button" accessibilityLabel={t('recent_title')}
        onPress={() => router.push({ pathname: '/recent-decisions', params: kind ? { kind } : {} })}
        style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}>
        <Feather name="clock" size={20} color={colors.textSecondary} />
        {!iconOnly && <Text style={[styles.label, { color: colors.text }]}>{t('recent_title')}</Text>}
    </Pressable>;
}
export function RecentUndoButton({ kind, onChanged }: { kind: MediaType; onChanged?: () => void }) {
    const state = useMediaStore(state => state);
    const { t } = useI18n(); const { colors } = useThemeColor();
    const [working, setWorking] = useState(false), [result, setResult] = useState<RecentDecisionResult | null>(null);
    const guard = useRef(false), mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const entry = state.recentDecisions?.find(item => item.kind === kind && recentDecisionIsCurrent(state, item));
    const disabled = !entry || working || state.isConfirmingDeletion || state.isConfirmingVideoTrash;
    const undo = async () => {
        if (!entry || guard.current || disabled) return;
        guard.current = true; setWorking(true); setResult(null);
        try {
            const outcome = await useMediaStore.getState().changeRecentDecision(entry.eventId, 'undo');
            if (mounted.current) setResult(outcome);
            if (outcome === 'changed') onChanged?.();
        } finally { guard.current = false; if (mounted.current) setWorking(false); }
    };
    return <View style={styles.control}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('recent_undo_last')} accessibilityState={{ disabled, busy: working }}
            disabled={disabled} onPress={() => void undo()} style={({ pressed }) => [styles.button, {
                backgroundColor: pressed ? colors.surfaceHover : 'transparent', opacity: disabled ? 0.4 : 1,
            }]}>
            <Feather name="corner-up-left" size={18} color={colors.textSecondary} />
            <Text style={[styles.label, { color: colors.textSecondary }]}>{t('recent_undo_last')}</Text>
        </Pressable>
        {result && result !== 'changed' && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.feedback, { color: colors.textSecondary }]}>{t(`recent_result_${result}`)}</Text>}
    </View>;
}
const styles = StyleSheet.create({
    button: { minWidth: UI_METRICS.touchTarget, minHeight: UI_METRICS.touchTarget, flexDirection: 'row', flexWrap: 'wrap',
        alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 8, borderRadius: UI_METRICS.buttonRadius },
    label: { ...TYPOGRAPHY.secondary, flexShrink: 1 },
    control: { alignItems: 'center', maxWidth: '100%' },
    feedback: { ...TYPOGRAPHY.caption, textAlign: 'center' },
});
