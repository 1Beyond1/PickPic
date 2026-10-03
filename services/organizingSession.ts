/** Persisted navigation contains identifiers, not reusable authorized URIs.
 * Reopening a session still requires a fresh native visibility check. */
export type SessionMediaType = 'photo' | 'video';
export interface SessionScope { albumIds: string[]; order: 'newest' | 'oldest' | 'random'; }
export interface OrganizingSession {
    version: 1;
    sessionId: string;
    kind: SessionMediaType;
    scope: SessionScope;
    assetIds: string[];
    position: number;
    deferredIds: string[];
    phase: 'organizing' | 'review' | 'complete';
    startedAt: number;
    updatedAt: number;
}

const unique = (ids: readonly string[]) => [...new Set(ids)];
const validIds = (value: unknown): value is string[] => Array.isArray(value)
    && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512)
    && new Set(value).size === value.length;
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function isOrganizingSession(value: unknown): value is OrganizingSession {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['version', 'sessionId', 'kind', 'scope', 'assetIds', 'position', 'deferredIds', 'phase', 'startedAt', 'updatedAt'])) return false;
    const session = value as OrganizingSession;
    const scope = session.scope;
    return session.version === 1 && typeof session.sessionId === 'string' && session.sessionId.length > 0 && session.sessionId.length <= 128
        && ['photo', 'video'].includes(session.kind) && !!scope && typeof scope === 'object'
        && exactKeys(scope, ['albumIds', 'order']) && validIds(scope.albumIds) && ['newest', 'oldest', 'random'].includes(scope.order)
        && validIds(session.assetIds) && validIds(session.deferredIds)
        && Number.isSafeInteger(session.position) && session.position >= 0 && session.position <= session.assetIds.length
        && ['organizing', 'review', 'complete'].includes(session.phase)
        && (session.phase !== 'organizing' || session.position < session.assetIds.length)
        && (session.phase !== 'review' || session.position === session.assetIds.length)
        && [session.startedAt, session.updatedAt].every(time => Number.isSafeInteger(time) && time >= 0)
        && session.updatedAt >= session.startedAt;
}

export function sameSessionScope(left: SessionScope, right: SessionScope): boolean {
    return left.order === right.order && JSON.stringify(unique(left.albumIds).sort()) === JSON.stringify(unique(right.albumIds).sort());
}

export function createOrganizingSession(kind: SessionMediaType, scope: SessionScope, assetIds: readonly string[], sessionId: string, now = Date.now()): OrganizingSession {
    const ids = unique(assetIds);
    const session: OrganizingSession = { version: 1, sessionId, kind,
        scope: { albumIds: unique(scope.albumIds), order: scope.order }, assetIds: ids, position: 0, deferredIds: [],
        phase: ids.length ? 'organizing' : 'complete', startedAt: now, updatedAt: now };
    if (!isOrganizingSession(session)) throw new Error('Invalid organizing session');
    return session;
}

/** A skip is deferred for this session, never a processed-media decision.
 * A later keep/pending decision removes it from the deferred projection. */
export function advanceOrganizingSession(session: OrganizingSession, assetId: string, decision: 'processed' | 'skip', now = Date.now()): OrganizingSession {
    const index = session.assetIds.indexOf(assetId);
    if (index < 0) return session;
    const position = Math.max(session.position, index + 1);
    return { ...session, position, phase: position === session.assetIds.length ? 'review' : 'organizing',
        deferredIds: decision === 'skip' ? unique([...session.deferredIds, assetId]) : session.deferredIds.filter(id => id !== assetId),
        updatedAt: Math.max(session.startedAt, now) };
}

/** Explicitly continue within the same scope. Deferred IDs remain excluded
 * across batches and restarts; only an explicit new session resets them. */
export function continueOrganizingSession(session: OrganizingSession, assetIds: readonly string[], now = Date.now()): OrganizingSession {
    if (session.phase === 'organizing') return session; // Continuing is not silently abandoning the current batch.
    const deferred = new Set(session.deferredIds);
    const ids = unique(assetIds).filter(id => !deferred.has(id));
    return { ...session, assetIds: ids, position: 0, phase: ids.length ? 'organizing' : 'complete', updatedAt: Math.max(session.startedAt, now) };
}

export function revisitDeferredMedia(session: OrganizingSession, ids: readonly string[] = session.deferredIds, now = Date.now()): OrganizingSession {
    const selected = new Set(ids);
    const deferred = session.deferredIds.filter(id => selected.has(id));
    if (!deferred.length) return session;
    const remaining = session.assetIds.slice(session.position);
    return { ...session, assetIds: unique([...deferred, ...remaining]), position: 0, phase: 'organizing',
        deferredIds: session.deferredIds.filter(id => !selected.has(id)), updatedAt: Math.max(session.startedAt, now) };
}

/** Viewing an earlier kept video is navigation, not an undo. */
export function moveOrganizingSession(session: OrganizingSession, position: number, now = Date.now()): OrganizingSession {
    if (!Number.isSafeInteger(position) || position < 0 || position > session.assetIds.length) return session;
    return { ...session, position, phase: position === session.assetIds.length ? 'review' : 'organizing', updatedAt: Math.max(session.startedAt, now) };
}

/** Only a confirmed physical deletion may remove saved members. A failed or
 * limited visibility lookup must retain them for later permission recovery. */
export function removeDeletedSessionMedia(session: OrganizingSession | null, deletedIds: ReadonlySet<string>, now = Date.now()): OrganizingSession | null {
    if (!session || (!session.assetIds.some(id => deletedIds.has(id)) && !session.deferredIds.some(id => deletedIds.has(id)))) return session;
    const assetIds = session.assetIds.filter(id => !deletedIds.has(id));
    const position = session.position - session.assetIds.slice(0, session.position).filter(id => deletedIds.has(id)).length;
    return { ...session, assetIds, position, deferredIds: session.deferredIds.filter(id => !deletedIds.has(id)),
        phase: session.phase === 'organizing' && position === assetIds.length ? 'review' : session.phase,
        updatedAt: Math.max(session.startedAt, now) };
}

/** Read-only resume projection: permission failure/limited visibility must
 * not rewrite saved scope/order or claim inaccessible files were deleted. */
export function getSessionResumeIds(session: OrganizingSession, visibleIds: ReadonlySet<string>, processedIds: ReadonlySet<string>, pendingIds: ReadonlySet<string> = new Set()) {
    const deferred = new Set(session.deferredIds);
    const remaining = (session.kind === 'video' ? session.assetIds : session.assetIds.slice(session.position))
        .filter(id => (session.kind === 'video' || !processedIds.has(id)) && !deferred.has(id) && !pendingIds.has(id));
    return { visible: remaining.filter(id => visibleIds.has(id)), unavailable: remaining.filter(id => !visibleIds.has(id)) };
}
