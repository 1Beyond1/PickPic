/** Calendar grouping follows the device's local timezone at selection time.
 * Keep the actual interval if a future organizing session persists this
 * selection: restarting in another timezone must not silently widen it. */
export interface MediaMonth {
    year: number;
    month: number; // 1–12, not JavaScript's 0–11
    startInclusive: number;
    endExclusive: number;
}

export function createMediaMonth(year: number, month: number): MediaMonth {
    if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
        throw new Error('Invalid calendar month');
    }
    // setFullYear deliberately avoids Date's special treatment of 0–99 as
    // 1900–1999. Calendar arithmetic, not a fixed number of days, handles DST.
    const start = new Date(0);
    start.setFullYear(year, month - 1, 1); start.setHours(0, 0, 0, 0);
    // Build the next boundary independently. Some zones jump over midnight
    // on the first day; copying that normalized 01:00 would leak an hour of
    // the following month into the selected month.
    const end = new Date(0);
    end.setFullYear(year, month, 1); end.setHours(0, 0, 0, 0);
    return { year, month, startInclusive: start.getTime(), endExclusive: end.getTime() };
}

export function mediaMatchesMonth(creationTime: number, month: MediaMonth): boolean {
    // The Android provider uses 0 for a missing DATE_TAKEN. It is not evidence
    // of a photo taken in January 1970. Do not substitute a filename or mtime.
    return Number.isFinite(creationTime) && creationTime !== 0
        && creationTime >= month.startInclusive && creationTime < month.endExclusive;
}

/** SDK 54's native Android/iOS queries both use > and <, not >= and <.
 * Broaden by 1 ms and apply mediaMatchesMonth to returned rows as well. */
export function mediaMonthQuery(month: MediaMonth) {
    return { createdAfter: month.startInclusive - 1, createdBefore: month.endExclusive };
}

/** Counts are for the supplied accessible projection, not the whole library.
 * No EXIF, media IDs or URIs need to be retained by a month chooser. */
export function groupMediaByMonth(assets: readonly { creationTime: number }[]) {
    const grouped = new Map<string, MediaMonth & { count: number }>();
    let unknownDateCount = 0;
    for (const { creationTime } of assets) {
        const date = new Date(creationTime);
        const year = date.getFullYear(), month = date.getMonth() + 1;
        if (!Number.isFinite(creationTime) || creationTime === 0 || !Number.isFinite(year) || year < 1 || year > 9999) {
            unknownDateCount++; continue;
        }
        const key = `${year}-${month}`;
        const entry = grouped.get(key);
        if (entry) entry.count++;
        else grouped.set(key, { ...createMediaMonth(year, month), count: 1 });
    }
    return { months: [...grouped.values()].sort((a, b) => b.year - a.year || b.month - a.month), unknownDateCount };
}
