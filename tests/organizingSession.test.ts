import { advanceOrganizingSession, continueOrganizingSession, createOrganizingSession, getSessionResumeIds,
    isOrganizingSession, moveOrganizingSession, removeDeletedSessionMedia, revisitDeferredMedia, sameSessionScope } from '../services/organizingSession';

const scope = { albumIds: ['family'], order: 'random' } as const;
const start = () => createOrganizingSession('photo', { ...scope, albumIds: [...scope.albumIds] }, ['a', 'b', 'c'], 'synthetic-session', 10);

it('captures a stable independent scope and exact randomized order', () => {
    const mutableScope = { albumIds: ['family', 'family'], order: 'random' } as const;
    const ids = ['c', 'b', 'a', 'c'];
    const session = createOrganizingSession('photo', { ...mutableScope, albumIds: [...mutableScope.albumIds] }, ids, 'synthetic', 10);
    ids.reverse();
    expect(session.assetIds).toEqual(['c', 'b', 'a']);
    expect(session.scope.albumIds).toEqual(['family']);
    expect(isOrganizingSession(JSON.parse(JSON.stringify(session)))).toBe(true);
});
it('keeps skip separate from processed decisions and advances to review only at batch end', () => {
    let session = advanceOrganizingSession(start(), 'a', 'skip', 11);
    expect(session).toMatchObject({ position: 1, deferredIds: ['a'], phase: 'organizing' });
    session = advanceOrganizingSession(session, 'b', 'processed', 12);
    session = advanceOrganizingSession(session, 'c', 'processed', 13);
    expect(session).toMatchObject({ position: 3, deferredIds: ['a'], phase: 'review' });
});
it('retains deferred media across batches and a JSON restart, but resets it for an explicit new round', () => {
    let finished = advanceOrganizingSession(start(), 'a', 'skip', 11);
    finished = advanceOrganizingSession(finished, 'b', 'processed', 11);
    finished = advanceOrganizingSession(finished, 'c', 'processed', 11);
    const session = JSON.parse(JSON.stringify(finished));
    const next = continueOrganizingSession(session, ['a', 'new', 'new'], 12);
    expect(next).toMatchObject({ sessionId: 'synthetic-session', assetIds: ['new'], deferredIds: ['a'], position: 0 });
    expect(createOrganizingSession('photo', next.scope, ['a'], 'new-session', 13).deferredIds).toEqual([]);
});
it('has a clear deferred entry and does not repeat already passed batch members', () => {
    const session = advanceOrganizingSession(start(), 'a', 'skip', 11);
    const revisited = revisitDeferredMedia(session, ['a'], 12);
    expect(revisited).toMatchObject({ assetIds: ['a', 'b', 'c'], deferredIds: [], position: 0, phase: 'organizing' });
    expect(revisitDeferredMedia(session, ['not-deferred'])).toBe(session);
});
it('does not treat a previous video decision or unknown ID as navigation backwards', () => {
    const session = advanceOrganizingSession(start(), 'b', 'processed', 11);
    expect(advanceOrganizingSession(session, 'a', 'processed', 12).position).toBe(2);
    expect(advanceOrganizingSession(session, 'foreign', 'skip')).toBe(session);
});
it('returns unavailable resume members without mutating saved order, scope or position', () => {
    const session = advanceOrganizingSession(start(), 'a', 'skip', 11);
    const snapshot = JSON.stringify(session);
    expect(getSessionResumeIds(session, new Set(['b']), new Set())).toEqual({ visible: ['b'], unavailable: ['c'] });
    expect(getSessionResumeIds(session, new Set(), new Set(['b']))).toEqual({ visible: [], unavailable: ['c'] });
    expect(JSON.stringify(session)).toBe(snapshot);
});
it('distinguishes no next batch from batch review without dropping skipped media', () => {
    let finished = advanceOrganizingSession(start(), 'a', 'skip', 11);
    finished = advanceOrganizingSession(finished, 'b', 'processed', 11);
    finished = advanceOrganizingSession(finished, 'c', 'processed', 11);
    const session = continueOrganizingSession(finished, ['a'], 12);
    expect(session).toMatchObject({ phase: 'complete', deferredIds: ['a'], assetIds: [] });
    expect(revisitDeferredMedia(session).phase).toBe('organizing');
});
it('compares the album set and sort order without silently widening scope', () => {
    expect(sameSessionScope({ order: 'random', albumIds: ['b', 'a'] }, { order: 'random', albumIds: ['a', 'b'] })).toBe(true);
    expect(sameSessionScope(scope as any, { order: 'newest', albumIds: ['family'] })).toBe(false);
    expect(sameSessionScope(scope as any, { order: 'random', albumIds: [] })).toBe(false);
});

it('treats sliding back to a kept video as cursor movement, not undoing its processed decision', () => {
    let session = createOrganizingSession('video', { albumIds: [], order: 'random' }, ['a', 'b'], 'video', 10);
    session = moveOrganizingSession(session, 1, 11);
    expect(getSessionResumeIds(session, new Set(['a', 'b']), new Set(['a']))).toEqual({ visible: ['a', 'b'], unavailable: [] });
    session = moveOrganizingSession(session, 0, 12);
    expect(session).toMatchObject({ position: 0, deferredIds: [], phase: 'organizing' });
    expect(moveOrganizingSession(session, -1)).toBe(session);
});

it('requires a finished batch before continuing so unseen media cannot be silently abandoned', () => {
    const session = start();
    expect(continueOrganizingSession(session, ['new'])).toBe(session);
});
it('preserves earlier unreviewed video members when revisiting a skip from a later viewing position', () => {
    const session = { ...createOrganizingSession('video', { albumIds: [], order: 'oldest' }, ['earlier', 'kept', 'later'], 'video', 10),
        position: 2, deferredIds: ['deferred'] };
    expect(revisitDeferredMedia(session, undefined, 11, new Set(['kept']))).toMatchObject({
        assetIds: ['deferred', 'earlier', 'later'], position: 0, deferredIds: [], phase: 'organizing',
    });
});
it('removes only confirmed deleted members without shifting the cursor to a different surviving item', () => {
    const saved = advanceOrganizingSession(start(), 'a', 'skip', 11);
    const pruned = removeDeletedSessionMedia(saved, new Set(['a']), 12)!;
    expect(pruned).toMatchObject({ assetIds: ['b', 'c'], position: 0, deferredIds: [], phase: 'organizing' });
    expect(isOrganizingSession(pruned)).toBe(true);
    expect(removeDeletedSessionMedia(pruned, new Set(['foreign']))).toBe(pruned);
    expect(removeDeletedSessionMedia(pruned, new Set(['b', 'c']), 13)).toMatchObject({ assetIds: [], position: 0, phase: 'review' });
});
it.each([
    { position: -1 }, { position: 4 }, { position: 1.5 }, { phase: 'unknown' }, { phase: 'organizing', position: 3 }, { phase: 'review', position: 0 },
    { version: 2 }, { scope: { albumIds: [], order: 'surprise' } }, { assetIds: ['a', 'a'] }, { deferredIds: [null] },
    { startedAt: -1 }, { updatedAt: 9 }, { sessionId: '' }, { setState: 'forged' },
])('rejects malformed or unsupported sensitive session data %j', change => {
    expect(isOrganizingSession({ ...start(), ...change })).toBe(false);
});
