/**
 * Which record represents a request.
 *
 * Claude Code writes one line per streaming snapshot, not per request: 268,354
 * assistant lines held 133,320 requests, up to 15 lines each, and within a
 * request only `output_tokens` changed, the last line holding the most.
 * Measured against that:
 *
 * - summing every line gave 55.48 B tokens, 1.94× too many;
 * - keeping the first line seen gave 19.6 M output tokens instead of 71.4 M;
 * - `stop_reason` cannot pick the final line: it is null on about 72% of
 *   lines, and dropping those loses 57.6% of the tokens.
 *
 * So one total order picks the record, everywhere it is needed: the per-file
 * dedup here, and the store's upsert, which encodes the same order in SQL. It
 * picks a whole record, never a field-by-field maximum, which could assemble
 * a combination of counters that was never observed.
 *
 * 1. A higher parser version wins, so a newer parser's row replaces an
 *    older one whatever its counters.
 * 2. The main chain beats a sidechain copy.
 * 3. All four counters reported beats any missing.
 * 4. More output wins; missing output counts as -1.
 * 5. The smallest (file, byte offset) wins, so the result never depends on
 *    the order files were read in. Paths compare as UTF-8 bytes, as SQLite
 *    compares text, so both sides agree on non-BMP characters too.
 */

import { isComplete } from './provenance';
import type { UsageRequest } from './types';

/** Negative when `a` should represent the request rather than `b`. */
export function compareRecords(a: UsageRequest, b: UsageRequest): number {
    return (
        b.parserVersion - a.parserVersion ||
        Number(b.isMain) - Number(a.isMain) ||
        Number(isComplete(b)) - Number(isComplete(a)) ||
        (b.output ?? -1) - (a.output ?? -1) ||
        Buffer.compare(Buffer.from(a.file, 'utf8'), Buffer.from(b.file, 'utf8')) ||
        a.byteOffset - b.byteOffset
    );
}

/** The record that represents the request, of two for the same `messageId`. */
export function preferred(a: UsageRequest, b: UsageRequest): UsageRequest {
    return compareRecords(a, b) <= 0 ? a : b;
}

/** One record per `messageId`: the one `compareRecords` puts first. */
export function dedupe(records: Iterable<UsageRequest>): Map<string, UsageRequest> {
    const chosen = new Map<string, UsageRequest>();
    for (const record of records) {
        const held = chosen.get(record.messageId);
        chosen.set(record.messageId, held ? preferred(held, record) : record);
    }
    return chosen;
}
