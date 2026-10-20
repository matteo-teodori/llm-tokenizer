/**
 * What a number is worth: whether every counter behind it was reported, and
 * what span of time it covers.
 *
 * - `reported`: every counter of every request it covers was in the records.
 * - `partial`: at least one counter was missing. The total is a lower bound,
 *   and is shown with `≥`; `≈` stays reserved for estimates.
 * - `snapshot`: a reading at one point in time, such as a session's latest
 *   record or a compaction's post-compaction size. It describes a state, so it
 *   is never added to anything.
 */

import type { TokenCounts } from './types';

export type UsageProvenance = 'reported' | 'partial' | 'snapshot';

/** True when all four counters were reported. */
export function isComplete(counts: TokenCounts): boolean {
    return (
        counts.input !== null &&
        counts.cacheCreation !== null &&
        counts.cacheRead !== null &&
        counts.output !== null
    );
}

/** The provenance of one request's counters. */
export function requestProvenance(counts: TokenCounts): UsageProvenance {
    return isComplete(counts) ? 'reported' : 'partial';
}

/**
 * The provenance of a sum of two quantities.
 *
 * @throws when either is a snapshot, which describes a state and has no
 *   meaning summed.
 */
export function addProvenance(a: UsageProvenance, b: UsageProvenance): UsageProvenance {
    for (const p of [a, b]) {
        switch (p) {
            case 'snapshot':
                throw new Error('A snapshot is a state, not an amount; it cannot be summed');
            case 'partial':
                return 'partial';
            case 'reported':
                break;
            default:
                return unreachable(p);
        }
    }
    return 'reported';
}

/** The mark a total carries in front of it: `≥` when it is only a lower bound. */
export function totalPrefix(provenance: UsageProvenance): '' | '≥' {
    switch (provenance) {
        case 'partial':
            return '≥';
        case 'reported':
        case 'snapshot':
            return '';
        default:
            return unreachable(provenance);
    }
}

/** What span of time, and how much of it, an aggregate covers. */
export interface Coverage {
    /** The oldest request it includes, UTC epoch milliseconds; null when empty. */
    start: number | null;
    /** The newest request it includes: how fresh it is. */
    newest: number | null;
    requests: number;
    /** Requests with at least one counter missing. */
    incompleteRequests: number;
}

export const EMPTY_COVERAGE: Coverage = Object.freeze({
    start: null,
    newest: null,
    requests: 0,
    incompleteRequests: 0,
});

/** Coverage with one more request in it. */
export function extendCoverage(coverage: Coverage, timestamp: number, complete: boolean): Coverage {
    return {
        start: coverage.start === null ? timestamp : Math.min(coverage.start, timestamp),
        newest: coverage.newest === null ? timestamp : Math.max(coverage.newest, timestamp),
        requests: coverage.requests + 1,
        incompleteRequests: coverage.incompleteRequests + (complete ? 0 : 1),
    };
}

function unreachable(value: never): never {
    throw new Error(`Unknown provenance: ${String(value)}`);
}
