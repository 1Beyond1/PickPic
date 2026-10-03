import { appendRecentDecision, isRecentDecisions, latestRecentDecisions, RECENT_DECISION_LIMIT, sameDecisionSnapshot } from '../services/recentDecisions';
import type { DecisionSnapshot, RecentDecision } from '../services/recentDecisions';

const unreviewed: DecisionSnapshot = { processed: false, pending: null, collected: false, deferred: false };
const kept: DecisionSnapshot = { ...unreviewed, processed: true };
const decision = (eventId = 'one', assetId = 'photo-a'): RecentDecision => ({ version: 1, eventId, assetId,
    kind: 'photo', action: 'keep', before: { ...unreviewed }, after: { ...kept }, at: 10, sessionId: 'round', position: 2 });

it('keeps insertion undo order across wall-clock changes and bounds local metadata', () => {
    let history: RecentDecision[] = [];
    for (let index = 0; index < 110; index++) history = appendRecentDecision(history, { ...decision(`event-${index}`), at: 110 - index });
    expect(history).toHaveLength(RECENT_DECISION_LIMIT);
    expect(history[0].eventId).toBe('event-109'); expect(history.at(-1)?.eventId).toBe('event-10');
    expect(isRecentDecisions(history)).toBe(true);
});
it('copies pending metadata instead of holding mutable queue objects', () => {
    const entry = { ...decision(), action: 'pending' as const, after: { ...kept, pending: { source: 'photos' as const, addedAt: 7 } } };
    const history = appendRecentDecision([], entry);
    entry.after.pending.addedAt = 99; entry.before.deferred = true;
    expect(history[0].after.pending?.addedAt).toBe(7); expect(history[0].before.deferred).toBe(false);
});
it('shows one latest row per typed asset while retaining earlier inverse operations', () => {
    const first = decision();
    const changed = { ...decision('two'), action: 'pending' as const, before: kept,
        after: { ...kept, pending: { source: 'classification' as const, addedAt: 15 } } };
    const video = { ...decision('three'), kind: 'video' as const };
    const history = appendRecentDecision(appendRecentDecision([first], changed), video);
    expect(latestRecentDecisions(history).map(entry => entry.eventId)).toEqual(['three', 'two']);
    expect(history).toHaveLength(3);
});
it('accepts skip, collection and pending-to-keep as distinct decisions', () => {
    expect(isRecentDecisions([{ ...decision(), action: 'defer', after: { ...unreviewed, deferred: true } }])).toBe(true);
    expect(isRecentDecisions([{ ...decision(), action: 'collect', after: { ...kept, collected: true } }])).toBe(true);
    expect(isRecentDecisions([{ ...decision(), before: { ...kept, pending: { source: 'videos', addedAt: 0 } } }])).toBe(true);
    expect(sameDecisionSnapshot(kept, { ...kept })).toBe(true);
    expect(sameDecisionSnapshot(kept, { ...kept, deferred: true })).toBe(false);
});
it.each([
    { version: 2 }, { uri: 'file:///not-allowed.jpg' }, { at: -1 }, { position: 1.5 }, { sessionId: null },
    { assetId: '' }, { before: { ...unreviewed, latitude: 1 } }, { after: unreviewed },
    { before: kept }, { kind: 'video', action: 'collect', after: { ...kept, collected: true } },
    { after: { ...kept, pending: { source: 'made-up', addedAt: 1 } } },
])('rejects unsupported, excessive or inconsistent history fields (%j)', patch => {
    expect(isRecentDecisions([{ ...decision(), ...patch }])).toBe(false);
});
it('rejects duplicate events, over-limit persisted arrays and no-op additions', () => {
    expect(isRecentDecisions([decision(), decision()])).toBe(false);
    expect(isRecentDecisions(Array.from({ length: 101 }, (_, index) => decision(String(index))))).toBe(false);
    expect(() => appendRecentDecision([decision()], decision())).toThrow('Invalid recent decision');
    expect(() => appendRecentDecision([], { ...decision(), before: kept })).toThrow('Invalid recent decision');
});
