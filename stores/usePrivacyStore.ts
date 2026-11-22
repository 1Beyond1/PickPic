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
    block: (scope: PrivacyScope, kind: 'read' | 'write', reason?: PrivacyFailureReason) => void;
    clear: (scope: PrivacyScope) => void;
    clearAll: () => void;
}

// Memory only. Errors never carry keys, SQL, payloads, identifiers or paths.
export const usePrivacyStore = create<PrivacyState>(set => ({
    failures: {},
    reasons: {},
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
}));

export class LocalPrivacyError extends Error {
    public readonly reason: PrivacyFailureReason;

    constructor(reason: PrivacyFailureReason = 'unknown') {
        super('Local records are unavailable; original data was preserved');
        this.reason = reason;
    }
}
