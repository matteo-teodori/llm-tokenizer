/**
 * Rollups of requests: a total, and totals grouped by day, model, kind or
 * session.
 *
 * Pure, and the time zone is always a parameter. Requests carry UTC epoch
 * milliseconds; which calendar day one falls on depends on where it is read,
 * so the day of a request at 23:30 UTC differs between London and Rome, and
 * the hour that repeats when Rome leaves summer time belongs to one day only.
 */

import {
    EMPTY_COVERAGE,
    addProvenance,
    extendCoverage,
    isComplete,
    requestProvenance,
    type Coverage,
    type UsageProvenance,
} from './provenance';
import type { UsageRequest } from './types';

/** Sums over a set of requests. A missing counter adds nothing. */
export interface UsageTotals {
    input: number;
    cacheCreation: number;
    cacheRead: number;
    output: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    /** A breakdown of `output`, never added to it. */
    thinking: number;
    /** input + cacheCreation + cacheRead + output: what was processed. */
    processed: number;
    /** `partial` as soon as one request in it was missing a counter. */
    provenance: UsageProvenance;
    coverage: Coverage;
}

export function emptyTotals(): UsageTotals {
    return {
        input: 0,
        cacheCreation: 0,
        cacheRead: 0,
        output: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        thinking: 0,
        processed: 0,
        provenance: 'reported',
        coverage: { ...EMPTY_COVERAGE },
    };
}

/** Add one request into `totals`, in place. */
export function addRequest(totals: UsageTotals, request: UsageRequest): void {
    const input = request.input ?? 0;
    const cacheCreation = request.cacheCreation ?? 0;
    const cacheRead = request.cacheRead ?? 0;
    const output = request.output ?? 0;

    totals.input += input;
    totals.cacheCreation += cacheCreation;
    totals.cacheRead += cacheRead;
    totals.output += output;
    totals.cacheWrite5m += request.cacheWrite5m ?? 0;
    totals.cacheWrite1h += request.cacheWrite1h ?? 0;
    totals.thinking += request.thinking ?? 0;
    totals.processed += input + cacheCreation + cacheRead + output;
    totals.provenance = addProvenance(totals.provenance, requestProvenance(request));
    totals.coverage = extendCoverage(totals.coverage, request.timestamp, isComplete(request));
}

/** Two sets of totals as one: for folding time buckets into days. */
export function mergeTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
    return {
        input: a.input + b.input,
        cacheCreation: a.cacheCreation + b.cacheCreation,
        cacheRead: a.cacheRead + b.cacheRead,
        output: a.output + b.output,
        cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
        cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
        thinking: a.thinking + b.thinking,
        processed: a.processed + b.processed,
        provenance: addProvenance(a.provenance, b.provenance),
        coverage: {
            start: earliest(a.coverage.start, b.coverage.start),
            newest: latest(a.coverage.newest, b.coverage.newest),
            requests: a.coverage.requests + b.coverage.requests,
            incompleteRequests: a.coverage.incompleteRequests + b.coverage.incompleteRequests,
        },
    };
}

export function totalsOf(requests: Iterable<UsageRequest>): UsageTotals {
    const totals = emptyTotals();
    for (const request of requests) {
        addRequest(totals, request);
    }
    return totals;
}

/** Totals grouped by whatever `keyOf` says, in first-seen key order. */
export function rollup<K>(requests: Iterable<UsageRequest>, keyOf: (request: UsageRequest) => K): Map<K, UsageTotals> {
    const groups = new Map<K, UsageTotals>();
    for (const request of requests) {
        const key = keyOf(request);
        let totals = groups.get(key);
        if (!totals) {
            totals = emptyTotals();
            groups.set(key, totals);
        }
        addRequest(totals, request);
    }
    return groups;
}

/** Totals by calendar day, `YYYY-MM-DD`, in `timeZone`. */
export function byDay(requests: Iterable<UsageRequest>, timeZone: string): Map<string, UsageTotals> {
    return rollup(requests, request => localDate(request.timestamp, timeZone));
}

/**
 * The share of input that was read from the cache: cacheRead ÷ (input +
 * cacheCreation + cacheRead). Null when nothing was input. It is a share of
 * input, never "tokens saved", which would need a price.
 */
export function cacheReadShare(totals: UsageTotals): number | null {
    const allInput = totals.input + totals.cacheCreation + totals.cacheRead;
    return allInput > 0 ? totals.cacheRead / allInput : null;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day `epochMs` falls on in `timeZone`, as `YYYY-MM-DD`.
 *
 * @throws RangeError for a zone the runtime does not know; see `isTimeZone`.
 */
export function localDate(epochMs: number, timeZone: string): string {
    let format = dayFormats.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        dayFormats.set(timeZone, format);
    }
    const parts = Object.fromEntries(format.formatToParts(epochMs).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

/** True for an IANA zone this runtime can convert to. */
export function isTimeZone(timeZone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    } catch {
        return false;
    }
}

function earliest(a: number | null, b: number | null): number | null {
    return a === null ? b : b === null ? a : Math.min(a, b);
}

function latest(a: number | null, b: number | null): number | null {
    return a === null ? b : b === null ? a : Math.max(a, b);
}
