import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useThemeColor } from '../hooks/useThemeColor';
import { useSettingsStore } from '../stores/useSettingsStore';
import type { BackupPayload, RestorePreview } from '../services/backup/payload';
import { BottomSheet } from './BottomSheet';
import { SettingsRow } from './SettingsRow';

export function RecordBackupPanel({ disabled = false }: { disabled?: boolean }) {
    const { colors } = useThemeColor();
    const language = useSettingsStore(state => state.language);
    const zh = language === 'zh';
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
                    ? (zh ? '请使用 12–128 个字符的密码，建议使用较长且不重复的口令。' : 'Use 12–128 characters. A long, unique passphrase is recommended.')
                    : code === 'invalid'
                        ? (zh ? '密码不正确，或文件损坏、版本不兼容。没有恢复任何记录。' : 'Incorrect password, damaged file or incompatible version. No records were restored.')
                        : (zh ? '操作未完成。请检查存储空间、相册权限并重试；恢复未提示成功时请保持应用开启。' : 'The operation did not complete. Check storage and gallery access, then retry. Keep the app open if restoration has not succeeded.'));
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
            if (password !== repeat) { setMessage(zh ? '两次输入的密码不一致。' : 'The passwords do not match.'); return; }
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
                if (!cancelled()) setMessage(saved
                    ? (zh ? `${Platform.OS === 'ios' ? '已打开分享面板，请确认已保存文件。' : '加密备份已保存。'}包含 ${output.saved} 条记录，跳过 ${output.skipped} 条不可访问记录。`
                        : `${Platform.OS === 'ios' ? 'Share sheet opened; confirm that you saved the file.' : 'Encrypted backup saved.'} ${output.saved} records included; ${output.skipped} inaccessible records skipped.`)
                    : (zh ? '已取消保存。' : 'Save cancelled.'));
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
        setMessage(zh ? `已恢复 ${result.kept + result.collected + (includePending ? result.pendingDeletion : 0)} 条记录。现有决定已保留，原照片和视频未改动。`
            : `Restored ${result.kept + result.collected + (includePending ? result.pendingDeletion : 0)} records. Existing decisions and original media were preserved.`);
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
        <SettingsRow label={zh ? '加密备份整理记录' : 'Back up organizing records'} detail={zh ? '设置密码，保存到自己选择的位置' : 'Protect with a password and choose where to save'} disabled={disabled || Platform.OS === 'web'} onPress={() => { clear(); setMode('export'); }} />
        <SettingsRow label={zh ? '从加密备份恢复' : 'Restore an encrypted backup'} disabled={disabled || Platform.OS === 'web'} onPress={() => { clear(); setMode('import'); }} />
        <BottomSheet visible={mode !== null} title={mode === 'export' ? (zh ? '加密备份' : 'Encrypted backup') : (zh ? '恢复整理记录' : 'Restore records')} onClose={clear}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flexShrink: 1 }}>
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
                    <Text style={[styles.copy, { color: colors.textSecondary }]}>{zh
                        ? '仅包含整理决定，不含照片、视频或扫描缓存。适用于原设备、原相册；移动或编辑过的媒体可能跳过。'
                        : 'Includes organizing decisions, not media or scan caches. Intended for the same device and library; moved or edited media may be skipped.'}</Text>
                    {mode === 'export' && <>
                        <Text style={[styles.copy, { color: colors.textSecondary }]}>{zh ? '密码无法找回。请使用较长的独立口令，并与备份文件分开保管。' : 'The password cannot be recovered. Use a long, unique passphrase and store it separately from the backup.'}</Text>
                        {input(password, setPassword, zh ? '备份密码（至少 12 个字符）' : 'Backup password (12+ characters)')}
                        {input(repeat, setRepeat, zh ? '再次输入密码' : 'Repeat password')}
                        {button(zh ? '加密并选择保存位置' : 'Encrypt and choose location', execute, !password || !repeat)}
                    </>}
                    {mode === 'import' && !preview && <>
                        {button(selected ? (zh ? '重新选择文件' : 'Choose another file') : (zh ? '选择备份文件' : 'Choose backup file'), choose)}
                        {selected && <>
                            {input(password, setPassword, zh ? '备份密码' : 'Backup password')}
                            {button(zh ? '解密并预览' : 'Decrypt and preview', execute, !password)}
                        </>}
                    </>}
                    {preview && <>
                        <Text style={[styles.copy, { color: colors.text }]}>{zh
                            ? `可恢复保留 ${preview.kept} · 收藏 ${preview.collected}\n待删除 ${preview.pendingDeletion}\n已有决定 ${preview.existing} · 无法匹配 ${preview.skipped}`
                            : `Keep ${preview.kept} · Collect ${preview.collected}\nPending deletion ${preview.pendingDeletion}\nAlready decided ${preview.existing} · Unmatched ${preview.skipped}`}</Text>
                        <View style={styles.toggle}>
                            <Text style={[styles.copy, { flex: 1, color: colors.text }]}>{zh ? '同时恢复待删除列表' : 'Also restore pending deletions'}</Text>
                            <Switch accessibilityLabel={zh ? '同时恢复待删除列表' : 'Also restore pending deletions'} value={includePending} onValueChange={setIncludePending} disabled={busy} />
                        </View>
                        <Text style={[styles.copy, { color: colors.textSecondary }]}>{zh ? '不会执行删除。恢复后仍需在待删除列表中复核确认。未勾选的待删除项目会留待重新整理。' : 'Nothing is deleted. Restored pending deletions still require review. Excluded pending items remain available for organizing.'}</Text>
                        {button(zh ? '确认恢复' : 'Confirm restore', restore)}
                    </>}
                    {busy && <ActivityIndicator accessibilityLabel={zh ? '处理中' : 'Working'} color={colors.text} />}
                    {busy && keyProgress !== null && <Text accessibilityLiveRegion="polite" style={[styles.copy, { color: colors.textSecondary }]}>{zh
                        ? `密码保护计算 ${keyProgress}% · 为保护密码，此步骤可能较慢，可随时取消。`
                        : `Password protection ${keyProgress}% · This security step can take time. You can cancel at any time.`}</Text>}
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
});
