/** Select a scan scope. Nothing starts until count or albums are confirmed. */
import { Feather } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import { AlbumSelector } from './AlbumSelector';
import { BottomSheet } from './BottomSheet';

interface ScanBatchModalProps {
    visible: boolean;
    onClose: () => void;
    onStartScan: (options: { mode: 'album' | 'count'; albumIds?: string[]; count?: number }) => void;
}

const COUNT_OPTIONS = [100, 200, 300, 500, 1000];

export function ScanBatchModal({ visible, onClose, onStartScan }: ScanBatchModalProps) {
    const { colors } = useThemeColor();
    const { t, language } = useI18n();
    const [mode, setMode] = useState<'album' | 'count' | null>(null);
    const [count, setCount] = useState(100);
    const [showAlbumSelector, setShowAlbumSelector] = useState(false);

    const handleStartByCount = () => {
        onStartScan({ mode: 'count', count });
        onClose();
        setMode(null);
    };

    const handleAlbumConfirm = (albumIds: string[]) => {
        if (albumIds.length === 0) {
            Alert.alert(t('scan_batch_album_required_title'), t('scan_batch_album_required_message'));
            return;
        }
        setShowAlbumSelector(false);
        onStartScan({ mode: 'album', albumIds });
        onClose();
        setMode(null);
    };

    const resetAndClose = () => {
        setMode(null);
        onClose();
    };

    if (!visible) return null;

    return (
        <>
            <BottomSheet
                visible={!showAlbumSelector}
                title={t('scan_batch')}
                onClose={resetAndClose}
                footer={mode === 'count' ? (
                    <View style={styles.footer}>
                        <Pressable
                            accessibilityRole="button"
                            onPress={() => setMode(null)}
                            style={({ pressed }) => [styles.back, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}
                        >
                            <Feather name="arrow-left" size={18} color={colors.textSecondary} />
                            <Text style={[styles.backLabel, { color: colors.textSecondary }]}>{language === 'zh' ? '返回' : 'Back'}</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            onPress={handleStartByCount}
                            style={({ pressed }) => [styles.start, { backgroundColor: colors.actionBackground, opacity: pressed ? 0.7 : 1 }]}
                        >
                            <Text style={[styles.startLabel, { color: colors.actionForeground }]}>{t('scan_batch_start')}</Text>
                        </Pressable>
                    </View>
                ) : undefined}
            >
                <ScrollView style={styles.list}>
                    {mode === null ? (
                        <>
                            <Pressable accessibilityRole="button" onPress={() => setShowAlbumSelector(true)} style={({ pressed }) => [styles.option, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}>
                                <Feather name="folder" size={20} color={colors.textSecondary} />
                                <Text style={[styles.optionLabel, { color: colors.text }]}>{t('scan_batch_by_album')}</Text>
                                <Feather name="chevron-right" size={18} color={colors.textTertiary} />
                            </Pressable>
                            <Pressable accessibilityRole="button" onPress={() => setMode('count')} style={({ pressed }) => [styles.option, { backgroundColor: pressed ? colors.surfaceHover : 'transparent' }]}>
                                <Feather name="hash" size={20} color={colors.textSecondary} />
                                <Text style={[styles.optionLabel, { color: colors.text }]}>{t('scan_batch_by_count')}</Text>
                                <Feather name="chevron-right" size={18} color={colors.textTertiary} />
                            </Pressable>
                        </>
                    ) : mode === 'count' ? (
                        <>
                            <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('scan_batch_count_label', { count })}</Text>
                            {COUNT_OPTIONS.map(option => (
                                <Pressable
                                    key={option}
                                    accessibilityRole="radio"
                                    accessibilityLabel={t('scan_batch_count_label', { count: option })}
                                    accessibilityState={{ checked: count === option }}
                                    onPress={() => setCount(option)}
                                    style={({ pressed }) => [styles.option, { backgroundColor: pressed || count === option ? colors.surfaceHover : 'transparent' }]}
                                >
                                    <Text style={[styles.optionLabel, { color: colors.text, fontWeight: count === option ? '500' : '400', fontVariant: ['tabular-nums'] }]}>{option}</Text>
                                    {count === option ? <Feather name="check" size={20} color={colors.text} /> : null}
                                </Pressable>
                            ))}
                        </>
                    ) : null}
                </ScrollView>
            </BottomSheet>
            <AlbumSelector visible={showAlbumSelector} onClose={() => setShowAlbumSelector(false)} onConfirm={handleAlbumConfirm} />
        </>
    );
}

const styles = StyleSheet.create({
    list: { flexGrow: 0, flexShrink: 1 },
    option: { minHeight: UI_METRICS.rowHeight, paddingHorizontal: 12, paddingVertical: 14, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
    optionLabel: { ...TYPOGRAPHY.body, flex: 1 },
    hint: { ...TYPOGRAPHY.secondary, paddingHorizontal: 12, paddingBottom: 8 },
    footer: { gap: 8 },
    back: { minHeight: UI_METRICS.touchTarget, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
    backLabel: { ...TYPOGRAPHY.secondary, flexShrink: 1 },
    start: { minHeight: UI_METRICS.buttonHeight, paddingHorizontal: 16, paddingVertical: 12, borderRadius: UI_METRICS.buttonRadius, justifyContent: 'center', alignItems: 'center' },
    startLabel: { ...TYPOGRAPHY.button, textAlign: 'center' },
});
