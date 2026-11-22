import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    AppState,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TYPOGRAPHY, UI_METRICS } from '../constants/theme';
import { useI18n } from '../hooks/useI18n';
import { useThemeColor } from '../hooks/useThemeColor';
import type { BackupPayload, RestorePreview } from '../services/backup/payload';
import { type PrivacyFailureReason, usePrivacyStore } from '../stores/usePrivacyStore';
import { BottomSheet } from './BottomSheet';

export interface PrivacyRecoveryScreenProps {
    failure: 'read' | 'write' | null;
    failureDomain?: PrivacyFailureReason | null;
    busy: boolean;
    onRetry: () => void;
    onResetLocalIndex?: () => Promise<void>;
    onRecoverFromBackup?: (
        payload: BackupPayload,
        includePending: boolean,
        cancelled?: () => boolean,
    ) => Promise<RestorePreview>;
}

function getDomainCopyKeys(failure: 'read' | 'write', domain?: PrivacyFailureReason | null): {
    badge: string | null;
    titleKey: 'privacy_domain_keystore_title' | 'privacy_domain_cipher_title' | 'privacy_domain_schema_title' | 'privacy_read_title' | 'privacy_write_title';
    descKey: 'privacy_domain_keystore_desc' | 'privacy_domain_cipher_desc' | 'privacy_domain_schema_desc' | 'privacy_read_desc' | 'privacy_write_desc';
} {
    if (domain === 'keystore_unavailable') {
        return {
            badge: 'Keystore',
            titleKey: 'privacy_domain_keystore_title',
            descKey: 'privacy_domain_keystore_desc',
        };
    }
    if (domain === 'cipher_decrypt_failed') {
        return {
            badge: 'SQLCipher',
            titleKey: 'privacy_domain_cipher_title',
            descKey: 'privacy_domain_cipher_desc',
        };
    }
    if (domain === 'schema_corrupt') {
        return {
            badge: 'Schema',
            titleKey: 'privacy_domain_schema_title',
            descKey: 'privacy_domain_schema_desc',
        };
    }
    return {
        badge: null,
        titleKey: failure === 'read' ? 'privacy_read_title' : 'privacy_write_title',
        descKey: failure === 'read' ? 'privacy_read_desc' : 'privacy_write_desc',
    };
}

export function PrivacyRecoveryScreen({
    failure,
    failureDomain = null,
    busy,
    onRetry,
    onResetLocalIndex,
    onRecoverFromBackup,
}: PrivacyRecoveryScreenProps) {
    const { colors } = useThemeColor();
    const { t } = useI18n();
    const insets = useSafeAreaInsets();

    const [wizardMode, setWizardMode] = useState<'import' | 'reset' | null>(null);
    const [working, setWorking] = useState(false);
    const [irreversibleWorking, setIrreversibleWorking] = useState(false);
    const [wizardMessage, setWizardMessage] = useState('');
    const [resetAck, setResetAck] = useState(false);

    // Backup import wizard state
    const [selectedFile, setSelectedFile] = useState(false);
    const [password, setPassword] = useState('');
    const [keyProgress, setKeyProgress] = useState<number | null>(null);
    const [includePending, setIncludePending] = useState(false);
    const [verifiedSummary, setVerifiedSummary] = useState<{
        version: 1 | 2;
        records: number;
        protectedAlbums: number;
        reviewIgnores: number;
    } | null>(null);
    const [restoreResult, setRestoreResult] = useState<RestorePreview | null>(null);

    const bytesRef = useRef<Uint8Array | null>(null);
    const payloadRef = useRef<BackupPayload | null>(null);
    const generationRef = useRef(0);
    const externalUIRef = useRef(false);
    const runningRef = useRef(false);
    const irreversibleWorkingRef = useRef(false);
    const uiRecoveryReleaseRef = useRef<(() => void) | null>(null);

    const releaseUiRecovery = () => {
        const release = uiRecoveryReleaseRef.current;
        uiRecoveryReleaseRef.current = null;
        release?.();
    };

    const closeWizard = () => {
        generationRef.current++;
        bytesRef.current?.fill(0);
        bytesRef.current = null;
        payloadRef.current = null;
        irreversibleWorkingRef.current = false;
        setIrreversibleWorking(false);
        setWizardMode(null);
        setWorking(false);
        setWizardMessage('');
        setResetAck(false);
        setSelectedFile(false);
        setPassword('');
        setKeyProgress(null);
        setIncludePending(false);
        setVerifiedSummary(null);
        setRestoreResult(null);
        releaseUiRecovery();
    };
    const handleRequestCloseWizard = () => {
        if (irreversibleWorkingRef.current) return;
        closeWizard();
    };
    const closeRef = useRef(handleRequestCloseWizard);
    closeRef.current = handleRequestCloseWizard;

    useEffect(() => {
        const gen = generationRef;
        const encrypted = bytesRef;
        const decrypted = payloadRef;
        const subscription = AppState.addEventListener('change', state => {
            if (state !== 'active') {
                setPassword('');
                if (!externalUIRef.current && !irreversibleWorkingRef.current) {
                    closeRef.current();
                }
            }
        });
        return () => {
            subscription.remove();
            gen.current++;
            encrypted.current?.fill(0);
            decrypted.current = null;
            const release = uiRecoveryReleaseRef.current;
            uiRecoveryReleaseRef.current = null;
            release?.();
        };
    }, []);

    const runWizardTask = async (
        task: (cancelled: () => boolean, onProgress: (fraction: number) => void) => Promise<void>,
        fallbackErrorKey: 'privacy_wizard_restore_failed' | 'privacy_wizard_reset_failed',
        options: { irreversible?: boolean } = {},
    ) => {
        if (runningRef.current) return;
        runningRef.current = true;
        setWorking(true);
        if (options.irreversible) {
            irreversibleWorkingRef.current = true;
            setIrreversibleWorking(true);
        }
        setWizardMessage('');
        setKeyProgress(null);
        const ticket = generationRef.current;
        const cancelled = () => ticket !== generationRef.current;
        let lastPercent = -1;
        const onProgress = (fraction: number) => {
            const percent = Math.min(100, Math.max(0, Math.floor(fraction * 100)));
            if (!cancelled() && percent !== lastPercent) {
                lastPercent = percent;
                setKeyProgress(percent);
            }
        };
        try {
            await task(cancelled, onProgress);
        } catch (error) {
            if (options.irreversible || !cancelled()) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
                if (code === 'password') setWizardMessage(t('backup_error_password'));
                else if (code === 'invalid') setWizardMessage(t('backup_error_invalid'));
                else if (code === 'size') setWizardMessage(t('backup_error_size'));
                else if (code === 'unavailable' && fallbackErrorKey === 'privacy_wizard_restore_failed') {
                    setWizardMessage(t('privacy_wizard_restore_no_permission'));
                } else setWizardMessage(t(fallbackErrorKey));
            }
        } finally {
            runningRef.current = false;
            if (options.irreversible) {
                irreversibleWorkingRef.current = false;
                setIrreversibleWorking(false);
            }
            if (options.irreversible || !cancelled()) {
                setWorking(false);
                setKeyProgress(null);
                setPassword('');
            }
        }
    };

    const handleChooseBackup = () => void runWizardTask(async cancelled => {
        setPassword('');
        const { pickEncryptedFile } = await import('../services/backup/files');
        externalUIRef.current = true;
        let picked: Uint8Array | null;
        try { picked = await pickEncryptedFile(); }
        finally { externalUIRef.current = false; }
        if (cancelled()) { picked?.fill(0); return; }
        bytesRef.current?.fill(0);
        bytesRef.current = picked;
        setSelectedFile(!!picked);
        setVerifiedSummary(null);
        setRestoreResult(null);
        payloadRef.current = null;
    }, 'privacy_wizard_restore_failed');

    const handleDecryptBackup = () => void runWizardTask(async (cancelled, onProgress) => {
        if (!bytesRef.current) return;
        const { decryptAndParseBackup } = await import('../services/backup/records');
        const parsed = await decryptAndParseBackup(bytesRef.current, password, cancelled, onProgress);
        if (cancelled()) return;
        bytesRef.current.fill(0);
        bytesRef.current = null;
        payloadRef.current = parsed;
        setRestoreResult(null);
        setVerifiedSummary({
            version: parsed.version,
            records: parsed.records.length,
            protectedAlbums: parsed.version === 2 ? parsed.protectedAlbums.length : 0,
            reviewIgnores: parsed.version === 2 ? parsed.reviewIgnores.length : 0,
        });
    }, 'privacy_wizard_restore_failed');

    const handleConfirmRestore = () => void runWizardTask(async () => {
        if (!payloadRef.current || !onRecoverFromBackup) return;
        const payloadToRestore = payloadRef.current;
        if (!uiRecoveryReleaseRef.current) {
            uiRecoveryReleaseRef.current = usePrivacyStore.getState?.().beginRecovery?.() ?? null;
        }
        // Post-confirmation restore must not bind cancellation to component unmount.
        const neverCancel = () => false;
        try {
            const result = await onRecoverFromBackup(payloadToRestore, includePending, neverCancel);
            payloadRef.current = null;
            setVerifiedSummary(null);
            setRestoreResult(result);
        } catch (error) {
            releaseUiRecovery();
            throw error;
        }
    }, 'privacy_wizard_restore_failed', { irreversible: true });

    const handleConfirmReset = () => void runWizardTask(async () => {
        if (!resetAck || !onResetLocalIndex) return;
        await onResetLocalIndex();
        closeWizard();
    }, 'privacy_wizard_reset_failed', { irreversible: true });

    const domainCopy = failure ? getDomainCopyKeys(failure, failureDomain) : null;
    const isBusy = busy || working;

    return (
        <ScrollView contentContainerStyle={[styles.content, {
            backgroundColor: colors.background,
            paddingTop: insets.top + 32,
            paddingBottom: insets.bottom + 32,
            paddingLeft: insets.left + UI_METRICS.pageInset,
            paddingRight: insets.right + UI_METRICS.pageInset,
        }]}>
            <View style={styles.body}>
                {Platform.OS === 'web' ? <>
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('privacy_native_title')}</Text>
                    <Text style={[styles.description, { color: colors.textSecondary }]}>{t('privacy_native_desc')}</Text>
                </> : !failure || !domainCopy ? (
                    <ActivityIndicator color={colors.primary} accessibilityLabel={t('privacy_loading')} />
                ) : <>
                    {domainCopy.badge && (
                        <View testID="privacy-failure-domain-badge" style={[styles.domainBadge, { backgroundColor: colors.surfaceHover }]}>
                            <Ionicons name="shield-outline" size={14} color={colors.danger} />
                            <Text style={[styles.domainBadgeText, { color: colors.danger }]}>{domainCopy.badge}</Text>
                        </View>
                    )}
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t(domainCopy.titleKey)}</Text>
                    <Text style={[styles.description, { color: colors.textSecondary }]}>{t(domainCopy.descKey)}</Text>

                    <View style={styles.actions}>
                        <Pressable
                            testID="privacy-retry-btn"
                            accessibilityRole="button"
                            accessibilityState={{ disabled: isBusy, busy: isBusy }}
                            disabled={isBusy}
                            onPress={onRetry}
                            style={({ pressed }) => [styles.button, {
                                backgroundColor: colors.actionBackground,
                                opacity: pressed || isBusy ? 0.65 : 1,
                            }]}
                        >
                            <Text style={[styles.buttonText, { color: colors.actionForeground }]}>
                                {t(busy ? 'privacy_retrying' : 'privacy_retry')}
                            </Text>
                        </Pressable>

                        {onRecoverFromBackup && (
                            <Pressable
                                testID="privacy-wizard-open-import"
                                accessibilityRole="button"
                                accessibilityState={{ disabled: isBusy }}
                                disabled={isBusy}
                                onPress={() => { closeWizard(); setWizardMode('import'); }}
                                style={({ pressed }) => [styles.secondaryButton, {
                                    backgroundColor: colors.surface,
                                    borderColor: colors.divider,
                                    opacity: pressed || isBusy ? 0.65 : 1,
                                }]}
                            >
                                <Ionicons name="cloud-download-outline" size={18} color={colors.text} />
                                <Text style={[styles.buttonText, { color: colors.text }]}>{t('privacy_wizard_import_btn')}</Text>
                            </Pressable>
                        )}

                        {onResetLocalIndex && (
                            <Pressable
                                testID="privacy-wizard-open-reset"
                                accessibilityRole="button"
                                accessibilityState={{ disabled: isBusy }}
                                disabled={isBusy}
                                onPress={() => { closeWizard(); setWizardMode('reset'); }}
                                style={({ pressed }) => [styles.secondaryButton, {
                                    backgroundColor: colors.surface,
                                    borderColor: colors.danger,
                                    opacity: pressed || isBusy ? 0.65 : 1,
                                }]}
                            >
                                <Ionicons name="refresh-outline" size={18} color={colors.danger} />
                                <Text style={[styles.buttonText, { color: colors.danger }]}>{t('privacy_wizard_reset_btn')}</Text>
                            </Pressable>
                        )}
                    </View>
                </>}
            </View>

            {/* Backup Import Self-Rescue Sheet */}
            <BottomSheet
                visible={wizardMode === 'import'}
                title={t('privacy_wizard_import_btn')}
                onClose={irreversibleWorking ? () => undefined : handleRequestCloseWizard}
                dismissOnBackdrop={!working}
            >
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flexShrink: 1 }}>
                    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
                        <Text style={[styles.sheetCopy, { color: colors.textSecondary }]}>
                            {t('privacy_wizard_import_desc')}
                        </Text>

                        {!verifiedSummary && !restoreResult && (
                            <>
                                <Pressable
                                    testID="privacy-import-choose-file"
                                    accessibilityRole="button"
                                    disabled={working}
                                    onPress={handleChooseBackup}
                                    style={({ pressed }) => [styles.button, {
                                        backgroundColor: colors.actionBackground,
                                        opacity: working || pressed ? 0.6 : 1,
                                    }]}
                                >
                                    <Text style={[styles.buttonText, { color: colors.actionForeground }]}>
                                        {t(selectedFile ? 'backup_choose_another_file' : 'backup_choose_file')}
                                    </Text>
                                </Pressable>

                                {selectedFile && (
                                    <>
                                        <TextInput
                                            accessibilityLabel={t('backup_password_input_label')}
                                            placeholder={t('backup_password_input_label')}
                                            placeholderTextColor={colors.textSecondary}
                                            value={password}
                                            onChangeText={setPassword}
                                            secureTextEntry
                                            autoCorrect={false}
                                            autoCapitalize="none"
                                            autoComplete="off"
                                            importantForAutofill="noExcludeDescendants"
                                            textContentType="none"
                                            editable={!working}
                                            maxLength={256}
                                            style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceHover }]}
                                        />
                                        <Pressable
                                            testID="privacy-import-decrypt-btn"
                                            accessibilityRole="button"
                                            disabled={working || !password}
                                            onPress={handleDecryptBackup}
                                            style={({ pressed }) => [styles.button, {
                                                backgroundColor: colors.actionBackground,
                                                opacity: working || !password || pressed ? 0.5 : 1,
                                            }]}
                                        >
                                            <Text style={[styles.buttonText, { color: colors.actionForeground }]}>
                                                {t('backup_decrypt_preview_btn')}
                                            </Text>
                                        </Pressable>
                                    </>
                                )}
                            </>
                        )}

                        {verifiedSummary && !restoreResult && (
                            <>
                                <View testID="privacy-import-verified-summary" style={[styles.summaryCard, { backgroundColor: colors.surfaceHover }]}>
                                    <Text style={[styles.sheetCopy, { color: colors.text }]}>
                                        {`v${verifiedSummary.version} · ${verifiedSummary.records} · ${t('settings_protected_albums')}: ${verifiedSummary.protectedAlbums}`}
                                    </Text>
                                </View>
                                <View style={styles.toggleRow}>
                                    <Text style={[styles.sheetCopy, { flex: 1, color: colors.text }]}>
                                        {t('backup_include_pending')}
                                    </Text>
                                    <Switch
                                        accessibilityLabel={t('backup_include_pending')}
                                        value={includePending}
                                        onValueChange={setIncludePending}
                                        disabled={working}
                                    />
                                </View>
                                <Text style={[styles.sheetCopy, { color: colors.textSecondary }]}>
                                    {t('backup_include_pending_hint')}
                                </Text>
                                <Pressable
                                    testID="privacy-import-confirm-btn"
                                    accessibilityRole="button"
                                    disabled={working}
                                    onPress={handleConfirmRestore}
                                    style={({ pressed }) => [styles.button, {
                                        backgroundColor: colors.actionBackground,
                                        opacity: working || pressed ? 0.6 : 1,
                                    }]}
                                >
                                    <Text style={[styles.buttonText, { color: colors.actionForeground }]}>
                                        {t('privacy_wizard_import_confirm')}
                                    </Text>
                                </Pressable>
                            </>
                        )}

                        {restoreResult && (
                            <>
                                <View testID="privacy-import-restore-result" style={[styles.summaryCard, { backgroundColor: colors.surfaceHover }]}>
                                    <Text style={[styles.buttonText, { color: colors.text, textAlign: 'left', marginBottom: 6 }]}>
                                        {t('privacy_wizard_restore_done_title')}
                                    </Text>
                                    <Text style={[styles.sheetCopy, { color: colors.textSecondary }]}>
                                        {t('privacy_wizard_restore_done_summary', {
                                            kept: restoreResult.kept ?? 0,
                                            collected: restoreResult.collected ?? 0,
                                            pending: includePending ? (restoreResult.pendingDeletion ?? 0) : 0,
                                            protectedAlbums: restoreResult.protectedAlbums ?? 0,
                                            reviewIgnores: restoreResult.reviewIgnores ?? 0,
                                            skipped: restoreResult.skipped ?? 0,
                                        })}
                                    </Text>
                                </View>
                                <Pressable
                                    testID="privacy-import-finish-btn"
                                    accessibilityRole="button"
                                    onPress={closeWizard}
                                    style={({ pressed }) => [styles.button, {
                                        backgroundColor: colors.actionBackground,
                                        opacity: pressed ? 0.6 : 1,
                                    }]}
                                >
                                    <Text style={[styles.buttonText, { color: colors.actionForeground }]}>
                                        {t('privacy_wizard_enter_app')}
                                    </Text>
                                </Pressable>
                            </>
                        )}

                        {working && <ActivityIndicator accessibilityLabel={t('backup_working')} color={colors.text} />}
                        {working && keyProgress !== null && (
                            <Text accessibilityLiveRegion="polite" style={[styles.sheetCopy, { color: colors.textSecondary }]}>
                                {t('backup_key_progress', { percent: keyProgress })}
                            </Text>
                        )}
                        {!!wizardMessage && (
                            <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.sheetCopy, { color: colors.danger }]}>
                                {wizardMessage}
                            </Text>
                        )}
                    </ScrollView>
                </KeyboardAvoidingView>
            </BottomSheet>

            {/* Secondary Explicit Confirmation Reset Sheet */}
            <BottomSheet
                visible={wizardMode === 'reset'}
                title={t('privacy_wizard_reset_title')}
                onClose={irreversibleWorking ? () => undefined : handleRequestCloseWizard}
                dismissOnBackdrop={!working}
            >
                <ScrollView contentContainerStyle={styles.sheetContent}>
                    <Text style={[styles.sheetCopy, { color: colors.textSecondary }]}>
                        {t('privacy_wizard_reset_warning')}
                    </Text>

                    <Pressable
                        testID="privacy-wizard-reset-ack"
                        accessibilityRole="checkbox"
                        accessibilityLabel={t('privacy_wizard_reset_ack')}
                        accessibilityState={{ checked: resetAck, disabled: working }}
                        disabled={working}
                        onPress={() => setResetAck(value => !value)}
                        style={[styles.ackRow, { backgroundColor: colors.surfaceHover }]}
                    >
                        <Ionicons
                            name={resetAck ? 'checkbox' : 'square-outline'}
                            size={22}
                            color={resetAck ? colors.danger : colors.textSecondary}
                        />
                        <Text style={[styles.sheetCopy, { flex: 1, color: colors.text }]}>
                            {t('privacy_wizard_reset_ack')}
                        </Text>
                    </Pressable>

                    <Pressable
                        testID="privacy-wizard-reset-confirm"
                        accessibilityRole="button"
                        accessibilityLabel={t('privacy_wizard_reset_confirm')}
                        accessibilityState={{ disabled: !resetAck || working, busy: working }}
                        disabled={!resetAck || working}
                        onPress={handleConfirmReset}
                        style={({ pressed }) => [styles.button, {
                            backgroundColor: colors.dangerBackground,
                            opacity: !resetAck || working || pressed ? 0.5 : 1,
                        }]}
                    >
                        <Text style={[styles.buttonText, { color: colors.dangerForeground }]}>
                            {t(working ? 'privacy_wizard_resetting' : 'privacy_wizard_reset_confirm')}
                        </Text>
                    </Pressable>

                    {!!wizardMessage && (
                        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.sheetCopy, { color: colors.danger }]}>
                            {wizardMessage}
                        </Text>
                    )}
                </ScrollView>
            </BottomSheet>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    content: { flexGrow: 1, justifyContent: 'center' },
    body: { width: '100%', maxWidth: 480, alignSelf: 'center' },
    domainBadge: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        marginBottom: 14,
    },
    domainBadgeText: {
        ...TYPOGRAPHY.caption,
        fontWeight: '600',
    },
    title: { fontSize: 24, fontWeight: '600', marginBottom: 16 },
    description: { fontSize: 15, lineHeight: 24, marginBottom: 28 },
    actions: { gap: 12 },
    button: {
        minHeight: 52,
        paddingVertical: 15,
        paddingHorizontal: 24,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    secondaryButton: {
        minHeight: 50,
        paddingVertical: 13,
        paddingHorizontal: 20,
        borderRadius: 25,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    buttonText: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
    sheetContent: { gap: 14, paddingBottom: 12 },
    sheetCopy: { fontSize: 14, lineHeight: 22 },
    input: { minHeight: 50, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 },
    summaryCard: { padding: 12, borderRadius: 12 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    ackRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 12,
        borderRadius: 12,
        minHeight: UI_METRICS.touchTarget,
    },
});
