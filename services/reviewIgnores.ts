import {
    ReviewIgnoreRepository,
    type MediaReviewIgnore,
    type ReviewIgnoreType,
} from '../database/repositories/ReviewIgnoreRepository';
import { recordBackupChanges } from './backup/changeTracker';

export type { MediaReviewIgnore, ReviewIgnoreType };

export function getIgnoredReviewKeys(ignoreType: ReviewIgnoreType): Promise<Set<string>> {
    return ReviewIgnoreRepository.getIgnoredKeys(ignoreType);
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
