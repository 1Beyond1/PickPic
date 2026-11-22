import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import type { BackupPayload, RestorePreview } from '../services/backup/payload';
import {
    BACKUP_REMINDER_THRESHOLD,
    markBackupCompleted,
    useBackupReminderStore,
} from '../services/backup/changeTracker';
import { BottomSheet } from './BottomSheet';
import { SettingsRow } from './SettingsRow';

export function RecordBackupPanel({ disabled = false }: { disabled?: boolean }) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const pendingBackupChanges = useBackupReminderStore(state => state.pendingChanges);
    const showBackupReminder = pendingBackupChanges >= BACKUP_REMINDER_THRESHOLD;
    const [mode, setMode] = useState<'export' | 'import' | null>(null);
    const [password, setPassword] = useState('');
    const [repeat, setRepeat] = useState('');
    const [busy, setBusy] = useState(false);
    const [keyProgress, setKeyProgress] = useState<number | null>(null);
    const [selected, setSelected] = useState(false);
    const [preview, setPreview] = useState<RestorePreview | null>(null);
    const [includePending, setIncludePending] = useState(false);
    const [message, setMessage] = useState('');
    const bytes = useRef<Uint8Array | null>(null);
    const payload = useRef<BackupPayload | null>(null);
    const generation = useRef(0);
    const externalUI = useRef(false);
    const running = useRef(false);
    const clear = () => {
        generation.current++;
        bytes.current?.fill(0); bytes.current = null; payload.current = null;
        setPassword(''); setRepeat(''); setPreview(null); setSelected(false);
        setIncludePending(false); setMessage(''); setBusy(false); setKeyProgress(null); setMode(null);
    };
    const close = useRef(clear); close.current = clear;
    useEffect(() => {
        const taskGeneration = generation;
        const encryptedBytes = bytes;
        const decryptedPayload = payload;
        const subscription = AppState.addEventListener('change', state => {
            if (state !== 'active') {
                setPassword(''); setRepeat('');
                if (!externalUI.current) close.current();
            }
        });
        return () => { subscription.remove(); taskGeneration.current++; encryptedBytes.current?.fill(0); decryptedPayload.current = null; };
    }, []);

    async function run(task: (cancelled: () => boolean, onProgress: (fraction: number) => void) => Promise<void>) {
        if (running.current) return;
        running.current = true; setBusy(true); setMessage(''); setKeyProgress(null);
        const ticket = generation.current;
        const cancelled = () => ticket !== generation.current;
        // Noble emits many callbacks; render only when a whole percent changes.
        let lastPercent = -1;
        const onProgress = (fraction: number) => {
            const percent = Math.min(100, Math.max(0, Math.floor(fraction * 100)));
            if (!cancelled() && percent !== lastPercent) { lastPercent = percent; setKeyProgress(percent); }
        };
        try { await task(cancelled, onProgress); }
        catch (error) {
            if (!cancelled()) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
                setMessage(code === 'password'
                    ? t('backup_error_password')
                    : code === 'invalid'
                        ? t('backup_error_invalid')
                        : t('backup_error_generic'));
            }
        } finally {
            running.current = false;
            if (!cancelled()) { setBusy(false); setKeyProgress(null); setPassword(''); setRepeat(''); }
        }
    }
    const choose = () => run(async cancelled => {
        setPassword(''); setRepeat('');
        const { pickEncryptedFile } = await import('../services/backup/files');
        externalUI.current = true;
        let selectedBytes: Uint8Array | null;
        try { selectedBytes = await pickEncryptedFile(); }
        finally { externalUI.current = false; }
        if (cancelled()) { selectedBytes?.fill(0); return; }
        bytes.current?.fill(0); bytes.current = selectedBytes;
        setSelected(!!selectedBytes);
    });
    const execute = () => run(async (cancelled, onProgress) => {
        if (mode === 'export') {
            if (password !== repeat) { setMessage(t('backup_error_password_mismatch')); return; }
            const { createEncryptedRecords } = await import('../services/backup/records');
            const output = await createEncryptedRecords(password, cancelled, onProgress);
            setKeyProgress(null);
            setPassword(''); setRepeat('');
            try {
                if (cancelled()) return;
                const { saveEncryptedFile } = await import('../services/backup/files');
                externalUI.current = true;
                let saved: boolean;
                try { saved = await saveEncryptedFile(output.bytes); }
                finally { externalUI.current = false; }
                if (saved) {
                    await markBackupCompleted().catch(() => undefined);
                }
                if (!cancelled()) setMessage(saved
                    ? t(Platform.OS === 'ios' ? 'backup_save_ios' : 'backup_save_android', { saved: output.saved, skipped: output.skipped })
                    : t('backup_save_cancelled'));
            } finally { output.bytes.fill(0); }
        } else if (bytes.current) {
            const { openEncryptedRecords } = await import('../services/backup/records');
            const opened = await openEncryptedRecords(bytes.current, password, cancelled, onProgress);
            if (cancelled()) return;
            payload.current = opened.payload; setPreview(opened.preview);
            bytes.current.fill(0); bytes.current = null;
        }
    });
    const restore = () => run(async cancelled => {
        if (!payload.current) return;
        const { restoreEncryptedRecords } = await import('../services/backup/records');
        const result = await restoreEncryptedRecords(payload.current, includePending, cancelled);
        if (cancelled()) return;
        payload.current = null; setPreview(null); setSelected(false);
        setMessage(t('backup_restore_success', {
            count: result.kept + result.collected + (includePending ? result.pendingDeletion : 0),
        }));
    });
    const button = (label: string, action: () => void, inactive = false) => (
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || inactive }} disabled={busy || inactive} onPress={action}
            style={({ pressed }) => [styles.button, { backgroundColor: colors.actionBackground, opacity: busy || inactive || pressed ? 0.5 : 1 }]}>
            <Text style={[styles.buttonLabel, { color: colors.actionForeground }]}>{label}</Text>
        </Pressable>
    );
    const input = (value: string, setter: (value: string) => void, label: string) => (
        <TextInput accessibilityLabel={label} placeholder={label} placeholderTextColor={colors.textSecondary} value={value} onChangeText={setter}
            secureTextEntry autoCorrect={false} autoCapitalize="none" autoComplete="off" importantForAutofill="noExcludeDescendants"
            textContentType="none"
            editable={!busy} maxLength={256} style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceHover }]} />
    );
    return <>
        {showBackupReminder && (
            <View testID="backup-change-reminder-badge" style={[styles.reminderBanner, { backgroundColor: colors.surfaceHover }]}>
                <Text style={[styles.reminderText, { color: colors.text }]}>
                    {t('backup_unsaved_changes_reminder', { count: pendingBackupChanges })}
                </Text>
            </View>
        )}
        <SettingsRow label={t('backup_export_label')} detail={t('backup_export_detail')} disabled={disabled || Platform.OS === 'web'} onPress={() => { clear(); setMode('export'); }} />
        <SettingsRow label={t('backup_import_label')} disabled={disabled || Platform.OS === 'web'} onPress={() => { clear(); setMode('import'); }} />
        <BottomSheet visible={mode !== null} title={t(mode === 'export' ? 'backup_export_title' : 'backup_import_title')} onClose={clear}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flexShrink: 1 }}>
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
                    <Text style={[styles.copy, { color: colors.textSecondary }]}>{t('backup_scope_desc_v2')}</Text>
                    {mode === 'export' && <>
                        <Text style={[styles.copy, { color: colors.textSecondary }]}>{t('backup_password_warning')}</Text>
                        {input(password, setPassword, t('backup_password_placeholder'))}
                        {input(repeat, setRepeat, t('backup_password_repeat_placeholder'))}
                        {button(t('backup_encrypt_save_btn'), execute, !password || !repeat)}
                    </>}
                    {mode === 'import' && !preview && <>
                        {button(t(selected ? 'backup_choose_another_file' : 'backup_choose_file'), choose)}
                        {selected && <>
                            {input(password, setPassword, t('backup_password_input_label'))}
                            {button(t('backup_decrypt_preview_btn'), execute, !password)}
                        </>}
                    </>}
                    {preview && <>
                        <Text style={[styles.copy, { color: colors.text }]}>{payload.current?.version === 2
                            ? t('backup_preview_summary_v2', {
                                kept: preview.kept,
                                collected: preview.collected,
                                pending: preview.pendingDeletion,
                                rebound: preview.rebound ?? 0,
                                protectedAlbums: preview.protectedAlbums ?? 0,
                                reviewIgnores: preview.reviewIgnores ?? 0,
                                existing: preview.existing,
                                ambiguousSkipped: preview.ambiguousSkipped ?? 0,
                                skipped: preview.skipped,
                            })
                            : t('backup_preview_summary', {
                                kept: preview.kept,
                                collected: preview.collected,
                                pending: preview.pendingDeletion,
                                existing: preview.existing,
                                skipped: preview.skipped,
                            })}</Text>
                        <View style={styles.toggle}>
                            <Text style={[styles.copy, { flex: 1, color: colors.text }]}>{t('backup_include_pending')}</Text>
                            <Switch accessibilityLabel={t('backup_include_pending')} value={includePending} onValueChange={setIncludePending} disabled={busy} />
                        </View>
                        <Text style={[styles.copy, { color: colors.textSecondary }]}>{t('backup_include_pending_hint')}</Text>
                        {button(t('backup_confirm_restore_btn'), restore)}
                    </>}
                    {busy && <ActivityIndicator accessibilityLabel={t('backup_working')} color={colors.text} />}
                    {busy && keyProgress !== null && <Text accessibilityLiveRegion="polite" style={[styles.copy, { color: colors.textSecondary }]}>{t('backup_key_progress', { percent: keyProgress })}</Text>}
                    {!!message && <Text accessibilityLiveRegion="polite" style={[styles.copy, { color: colors.text }]}>{message}</Text>}
                </ScrollView>
            </KeyboardAvoidingView>
        </BottomSheet>
    </>;
}
const styles = StyleSheet.create({
    content: { gap: 14, paddingBottom: 12 }, copy: { fontSize: 14, lineHeight: 22 },
    input: { minHeight: 50, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 },
    button: { minHeight: 48, borderRadius: 24, padding: 12, alignItems: 'center', justifyContent: 'center' },
    buttonLabel: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
    toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    reminderBanner: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, marginBottom: 8 },
    reminderText: { fontSize: 13, lineHeight: 19 },
});
