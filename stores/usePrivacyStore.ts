import { create } from 'zustand';

export type PrivacyScope = 'records' | 'settings' | 'scanner' | 'cache';
export type DeviceKeyScope = Exclude<PrivacyScope, 'cache'>;
export type PrivacyFailureReason =
    | 'keystore_unavailable'
    | 'cipher_decrypt_failed'
    | 'schema_corrupt'
    | 'storage_io'
    | 'unknown';

interface PrivacyState {
    failures: Partial<Record<PrivacyScope, 'read' | 'write'>>;
    reasons: Partial<Record<PrivacyScope, PrivacyFailureReason>>;
    /** Reference-counted recovery lock: keeps the privacy gate closed until
     * an entire self-rescue / encrypted-backup restore transaction completes. */
    recoveryDepth: number;
    recovering: boolean;
    block: (scope: PrivacyScope, kind: 'read' | 'write', reason?: PrivacyFailureReason) => void;
    clear: (scope: PrivacyScope) => void;
    clearAll: () => void;
    beginRecovery: () => () => void;
}

// Memory only. Errors never carry keys, SQL, payloads, identifiers or paths.
export const usePrivacyStore = create<PrivacyState>(set => ({
    failures: {},
    reasons: {},
    recoveryDepth: 0,
    recovering: false,
    block: (scope, kind, reason) => set(state => {
        const nextKind = state.failures[scope] === 'read' ? 'read' : kind;
        const existingReason = state.reasons[scope];
        const nextReason = reason && reason !== 'unknown'
            ? reason
            : existingReason ?? reason ?? 'unknown';
        return {
            failures: { ...state.failures, [scope]: nextKind },
            reasons: { ...state.reasons, [scope]: nextReason },
        };
    }),
    clear: scope => set(state => {
        const failures = { ...state.failures };
        const reasons = { ...state.reasons };
        delete failures[scope];
        delete reasons[scope];
        return { failures, reasons };
    }),
    clearAll: () => set({ failures: {}, reasons: {} }),
    beginRecovery: () => {
        let released = false;
        set(state => {
            const recoveryDepth = state.recoveryDepth + 1;
            return { recoveryDepth, recovering: true };
        });
        return () => {
            if (released) return;
            released = true;
            set(state => {
                const recoveryDepth = Math.max(0, state.recoveryDepth - 1);
                return { recoveryDepth, recovering: recoveryDepth > 0 };
            });
        };
    },
}));

export class LocalPrivacyError extends Error {
    public readonly reason: PrivacyFailureReason;

    constructor(reason: PrivacyFailureReason = 'unknown') {
        super('Local records are unavailable; original data was preserved');
        this.reason = reason;
    }
}
