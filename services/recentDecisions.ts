import type { PendingDeletionInfo } from './pendingDeletion';

/** Bounded local undo metadata: identifiers and decisions, never media URIs,
 * thumbnails, location, EXIF or copies of the original files. */
export const RECENT_DECISION_LIMIT = 100;
export interface DecisionSnapshot {
    processed: boolean;
    pending: PendingDeletionInfo | null;
    collected: boolean;
    deferred: boolean;
}
export interface RecentDecision {
    version: 1;
    eventId: string;
    assetId: string;
    kind: 'photo' | 'video';
    action: 'keep' | 'pending' | 'collect' | 'defer';
    before: DecisionSnapshot;
    after: DecisionSnapshot;
    at: number;
    sessionId: string | null;
    position: number | null;
}
export type RecentDecisionResult = 'changed' | 'unchanged' | 'busy' | 'stale' | 'unavailable' | 'failed' | 'nothing';
const exact = (value: object, keys: readonly string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const id = (value: unknown, length: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= length;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function isSnapshot(value: unknown): value is DecisionSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !exact(value, ['processed', 'pending', 'collected', 'deferred'])) return false;
    const snapshot = value as DecisionSnapshot;
    const pending = snapshot.pending;
    return [snapshot.processed, snapshot.collected, snapshot.deferred].every(flag => typeof flag === 'boolean')
        && (pending === null || (!!pending && typeof pending === 'object' && !Array.isArray(pending)
            && exact(pending, ['source', 'addedAt']) && time(pending.addedAt)
            && ['photos', 'videos', 'blur', 'similar', 'classification', 'unknown'].includes(pending.source)));
}
export function sameDecisionSnapshot(left: DecisionSnapshot, right: DecisionSnapshot): boolean {
    return left.processed === right.processed && left.collected === right.collected && left.deferred === right.deferred
        && (left.pending === null ? right.pending === null : right.pending !== null
            && left.pending.source === right.pending.source && left.pending.addedAt === right.pending.addedAt);
}
export function isRecentDecision(value: unknown): value is RecentDecision {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !exact(value, ['version', 'eventId', 'assetId', 'kind', 'action', 'before', 'after', 'at', 'sessionId', 'position'])) return false;
    const entry = value as RecentDecision;
    if (entry.version !== 1 || !id(entry.eventId, 128) || !id(entry.assetId, 512) || !time(entry.at)
        || !['photo', 'video'].includes(entry.kind) || !['keep', 'pending', 'collect', 'defer'].includes(entry.action)
        || !isSnapshot(entry.before) || !isSnapshot(entry.after) || sameDecisionSnapshot(entry.before, entry.after)
        || (entry.kind === 'video' && (entry.before.collected || entry.after.collected))
        || (entry.sessionId === null ? entry.position !== null : !id(entry.sessionId, 128) || !time(entry.position))) return false;
    const after = entry.after;
    switch (entry.action) {
        case 'keep': return after.processed && !after.pending && !after.collected && !after.deferred;
        case 'pending': return after.processed && !!after.pending && !after.collected && !after.deferred;
        case 'collect': return after.processed && !after.pending && after.collected && !after.deferred;
        case 'defer': return !after.processed && !after.pending && !after.collected && after.deferred;
    }
}
export function isRecentDecisions(value: unknown): value is RecentDecision[] {
    return Array.isArray(value) && value.length <= RECENT_DECISION_LIMIT && value.every(isRecentDecision)
        && new Set(value.map(entry => entry.eventId)).size === value.length;
}
function copySnapshot(snapshot: DecisionSnapshot): DecisionSnapshot {
    return { ...snapshot, pending: snapshot.pending ? { ...snapshot.pending } : null };
}
/** Insertion order is the undo order, even if the device wall clock moves
 * backwards. Repeated/no-op processing must not create another event. */
export function appendRecentDecision(history: readonly RecentDecision[], entry: RecentDecision): RecentDecision[] {
    if (!isRecentDecision(entry) || history.some(item => item.eventId === entry.eventId)) throw new Error('Invalid recent decision');
    return [{ ...entry, before: copySnapshot(entry.before), after: copySnapshot(entry.after) }, ...history].slice(0, RECENT_DECISION_LIMIT);
}
/** The review list shows the latest decision per medium; earlier events remain
 * in the bounded journal for successive undo, not as contradictory rows. */
export function latestRecentDecisions(history: readonly RecentDecision[]): RecentDecision[] {
    const seen = new Set<string>();
    return history.filter(entry => {
        const key = `${entry.kind}:${entry.assetId}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}
