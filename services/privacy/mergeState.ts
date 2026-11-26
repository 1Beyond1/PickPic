import { LocalPrivacyError } from '../../stores/usePrivacyStore';

/** Persisted data can supply state, never replace executable store actions or
 * mark a store hydrated before its post-hydration validation has succeeded. */
export function mergeProtectedState<T extends object>(stored: unknown, current: T): T {
    if (stored === undefined) return current;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new LocalPrivacyError();
    for (const name of Object.keys(stored)) {
        if (name === '__proto__' || name === 'constructor' || name === 'prototype'
            || typeof (current as Record<string, unknown>)[name] === 'function') throw new LocalPrivacyError();
    }
    return { ...current, ...stored, ...('hasHydrated' in current ? { hasHydrated: false } : {}) };
}
