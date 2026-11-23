import {
    ReviewIgnoreRepository,
    type MediaReviewIgnore,
    type ReviewIgnoreType,
} from '../database/repositories/ReviewIgnoreRepository';
import { useMediaStore } from '../stores/useMediaStore';
import { recordBackupChanges } from './backup/changeTracker';
import { flushMediaProgress } from './mediaProgressStorage';

export type { MediaReviewIgnore, ReviewIgnoreType };

export function getIgnoredReviewKeys(ignoreType: ReviewIgnoreType): Promise<Set<string>> {
    return ReviewIgnoreRepository.getIgnoredKeys(ignoreType);
}

/**
 * Read every ignored similar-group key across BOTH local encrypted stores
 * (SQLCipher `media_review_ignores` and AES-256-GCM `useMediaStore.ignoredSimilarGroupKeys`).
 */
export async function getAllIgnoredSimilarGroupKeys(): Promise<Set<string>> {
    const keys = new Set<string>(await ReviewIgnoreRepository.getIgnoredKeys('similar_group'));
    const storeKeys = useMediaStore.getState?.()?.ignoredSimilarGroupKeys ?? [];
    for (const key of storeKeys) {
        if (typeof key === 'string' && key.trim().length > 0) {
            keys.add(key.trim());
        }
    }
    return keys;
}

/**
 * Persist one or more stable keys for a "Not Similar" group into BOTH SQLCipher
 * (`media_review_ignores`) AND the AES-256-GCM encrypted record store so the
 * ignore survives rescans, scan-index resets, and cross-device v2 backup restores.
 */
export async function ignoreSimilarGroupKeys(
    targetKeys: readonly string[],
    createdAt = Date.now(),
): Promise<string[]> {
    const normalized = Array.from(
        new Set(targetKeys.map(key => (typeof key === 'string' ? key.trim() : '')).filter(key => key.length > 0 && key.length <= 512)),
    );
    if (normalized.length === 0) return [];

    if (normalized.length === 1) {
        await ReviewIgnoreRepository.addIgnore('similar_group', normalized[0], createdAt);
    } else {
        await ReviewIgnoreRepository.addIgnores(
            normalized.map(targetKey => ({ ignoreType: 'similar_group' as const, targetKey, createdAt })),
        );
    }

    const store = useMediaStore.getState?.();
    if (typeof store?.addIgnoredSimilarGroupKeys === 'function') {
        store.addIgnoredSimilarGroupKeys(normalized);
        await flushMediaProgress().catch(() => undefined);
    }
    void recordBackupChanges(1);
    return normalized;
}

export function getAllReviewIgnores(): Promise<MediaReviewIgnore[]> {
    return ReviewIgnoreRepository.getAll();
}

export async function addReviewIgnore(
    ignoreType: ReviewIgnoreType,
    targetKey: string,
    createdAt?: number,
): Promise<void> {
    await ReviewIgnoreRepository.addIgnore(ignoreType, targetKey, createdAt);
    void recordBackupChanges(1);
}

export async function addReviewIgnores(
    entries: readonly { ignoreType: ReviewIgnoreType; targetKey: string; createdAt?: number }[],
): Promise<number> {
    const count = await ReviewIgnoreRepository.addIgnores(entries);
    if (count > 0) {
        void recordBackupChanges(count);
    }
    return count;
}

export async function removeReviewIgnore(
    ignoreType: ReviewIgnoreType,
    targetKey: string,
): Promise<void> {
    await ReviewIgnoreRepository.removeIgnore(ignoreType, targetKey);
    void recordBackupChanges(1);
}

export function mergeReviewIgnores(entries: readonly MediaReviewIgnore[]): Promise<number> {
    return ReviewIgnoreRepository.mergeIgnores(entries);
}
