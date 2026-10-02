import { create } from 'zustand';

export type PrivacyScope = 'records' | 'settings' | 'scanner' | 'cache';
export type DeviceKeyScope = Exclude<PrivacyScope, 'cache'>;
interface PrivacyState {
    failures: Partial<Record<PrivacyScope, 'read' | 'write'>>;
    block: (scope: PrivacyScope, kind: 'read' | 'write') => void;
    clear: (scope: PrivacyScope) => void;
}
// Memory only. Errors never carry keys, SQL, payloads, identifiers or paths.
export const usePrivacyStore = create<PrivacyState>(set => ({
    failures: {},
    block: (scope, kind) => set(state => ({ failures: { ...state.failures,
        [scope]: state.failures[scope] === 'read' ? 'read' : kind } })),
    clear: scope => set(state => {
        const failures = { ...state.failures }; delete failures[scope]; return { failures };
    }),
}));

export class LocalPrivacyError extends Error {
    constructor() { super('Local records are unavailable; original data was preserved'); }
}
