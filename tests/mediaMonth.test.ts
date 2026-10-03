import { createMediaMonth, groupMediaByMonth, mediaMatchesMonth, mediaMonthQuery } from '../services/mediaMonth';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

it('includes the exact start, excludes the next month and compensates for strict native predicates', () => {
    const month = createMediaMonth(2026, 10), query = mediaMonthQuery(month);
    expect(mediaMatchesMonth(month.startInclusive, month)).toBe(true);
    expect(mediaMatchesMonth(month.startInclusive - 1, month)).toBe(false);
    expect(mediaMatchesMonth(month.endExclusive - 1, month)).toBe(true);
    expect(mediaMatchesMonth(month.endExclusive, month)).toBe(false);
    // Reproduce the installed SDK's native comparison, not only the helper.
    expect(month.startInclusive > query.createdAfter && month.startInclusive < query.createdBefore).toBe(true);
    expect(mediaMatchesMonth(query.createdAfter, month)).toBe(false);
});

it.each([[2024, 2, 29], [2025, 2, 28], [2026, 12, 31]])('uses calendar boundaries for %i/%i', (year, number, lastDay) => {
    const month = createMediaMonth(year, number);
    expect(new Date(month.startInclusive).getFullYear()).toBe(year);
    expect(new Date(month.startInclusive).getMonth() + 1).toBe(number);
    const last = new Date(month.endExclusive - 1);
    expect(last.getMonth() + 1).toBe(number); expect(last.getDate()).toBe(lastDay);
    expect(new Date(month.endExclusive).getDate()).toBe(1);
});

it('does not reinterpret a valid year below 100 as a twentieth-century date', () => {
    expect(new Date(createMediaMonth(99, 12).startInclusive).getFullYear()).toBe(99);
});

it.each([[2026, 0], [2026, 13], [2026, 1.5], [0, 1], [10000, 1], [NaN, 1]])('rejects invalid calendar inputs %j', (year, month) => {
    expect(() => createMediaMonth(year, month)).toThrow('Invalid calendar month');
});

it('groups only supplied dates, reports unknown dates separately and orders calendar months newest first', () => {
    const october = createMediaMonth(2026, 10), november = createMediaMonth(2026, 11);
    const assets = [{ creationTime: october.startInclusive }, { creationTime: november.startInclusive },
        { creationTime: october.endExclusive - 1 }, { creationTime: 0 }, { creationTime: NaN }, { creationTime: Infinity }];
    const snapshot = assets.map(asset => asset.creationTime);
    const result = groupMediaByMonth(assets);
    expect(result.unknownDateCount).toBe(3);
    expect(result.months).toEqual([{ ...november, count: 1 }, { ...october, count: 2 }]);
    expect(assets.map(asset => asset.creationTime)).toEqual(snapshot);
    expect(groupMediaByMonth([])).toEqual({ months: [], unknownDateCount: 0 });
    expect(mediaMatchesMonth(0, createMediaMonth(1970, 1))).toBe(false);
});

it.each([
    ['America/Havana', 2001, 4, Date.UTC(2001, 3, 1, 5), Date.UTC(2001, 4, 1, 4)],
    ['America/New_York', 2026, 3, Date.UTC(2026, 2, 1, 5), Date.UTC(2026, 3, 1, 4)],
    ['Asia/Kathmandu', 2026, 10, Date.UTC(2026, 8, 30, 18, 15), Date.UTC(2026, 9, 31, 18, 15)],
] as const)('keeps exact month boundaries in %s, including a nonexistent first-day midnight', (zone, year, month, start, end) => {
    // A separate Node process establishes a real timezone before loading the
    // helper; mutating Jest's mocked process.env would not exercise Date/ICU.
    const script = `const fs = require('node:fs'); const ts = require('typescript');
        const source = ts.transpileModule(fs.readFileSync(process.argv[1], 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        const exported = {}; new Function('exports', source)(exported);
        process.stdout.write(JSON.stringify(exported.createMediaMonth(Number(process.argv[2]), Number(process.argv[3]))));`;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script, path.resolve(__dirname, '../services/mediaMonth.ts'), String(year), String(month)],
        { encoding: 'utf8', env: { ...process.env, TZ: zone } }));
    expect(result).toEqual({ year, month, startInclusive: start, endExclusive: end });
});
