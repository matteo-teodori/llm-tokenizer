import * as assert from 'assert';

import { byDay, cacheReadShare, isTimeZone, localDate, localMinute, mergeTotals, totalsOf } from '../../src/usage/aggregate';
import type { UsageRequest } from '../../src/usage/types';

function req(timestamp: number, overrides: Partial<UsageRequest> = {}): UsageRequest {
    return {
        provider: 'claude-code',
        messageId: `m${timestamp}`,
        requestId: null,
        sessionId: 's',
        kind: 'main',
        isMain: true,
        timestamp,
        model: 'claude-opus-5-5',
        variant: null,
        input: 1,
        cacheCreation: 1,
        cacheRead: 1,
        output: 1,
        cacheWrite5m: null,
        cacheWrite1h: null,
        thinking: null,
        effort: null,
        webSearchRequests: null,
        webFetchRequests: null,
        claudeCodeVersion: null,
        agentId: null,
        runId: null,
        file: '/f.jsonl',
        byteOffset: 0,
        parserVersion: 1,
        ...overrides,
    };
}

suite('usage rollups', () => {
    test('processed is the four categories, and thinking is part of output', () => {
        const totals = totalsOf([
            req(1, { input: 10, cacheCreation: 20, cacheRead: 300, output: 40, thinking: 25, cacheWrite5m: 5, cacheWrite1h: 15 }),
        ]);
        assert.strictEqual(totals.processed, 370);
        assert.strictEqual(totals.thinking, 25);
        assert.strictEqual(totals.cacheWrite5m + totals.cacheWrite1h, totals.cacheCreation);
    });

    test('a day is the day where the reader is', () => {
        // 22:30 UTC on 24 October is 00:30 on the 25th in Rome (CEST, +2).
        const t = Date.UTC(2026, 9, 24, 22, 30);
        assert.strictEqual(localDate(t, 'UTC'), '2026-10-24');
        assert.strictEqual(localDate(t, 'Europe/Rome'), '2026-10-25');
    });

    test("the hour Rome repeats when summer time ends belongs to that one day", () => {
        // F16. On 25 October 2026 Rome goes from 03:00 CEST back to 02:00 CET
        // at 01:00 UTC, so 02:30 happens twice; both are the 25th, and the day
        // ends at 23:00 UTC rather than 22:00.
        const zone = 'Europe/Rome';
        const first = Date.UTC(2026, 9, 25, 0, 30); // 02:30 CEST
        const second = Date.UTC(2026, 9, 25, 1, 30); // 02:30 CET
        const lastMinute = Date.UTC(2026, 9, 25, 22, 59); // 23:59 CET
        const nextDay = Date.UTC(2026, 9, 25, 23, 0); // 00:00 CET on the 26th

        const days = byDay([req(first), req(second), req(lastMinute), req(nextDay)], zone);
        assert.deepStrictEqual([...days.keys()], ['2026-10-25', '2026-10-26']);
        assert.strictEqual(days.get('2026-10-25')?.coverage.requests, 3);
        assert.strictEqual(days.get('2026-10-26')?.coverage.requests, 1);
    });

    test('a session that crosses midnight is split across its two days', () => {
        const zone = 'Europe/Rome';
        const days = byDay([req(Date.UTC(2026, 9, 9, 21, 50)), req(Date.UTC(2026, 9, 9, 22, 10))], zone);
        assert.deepStrictEqual([...days.keys()], ['2026-10-09', '2026-10-10']);
    });

    test('merging totals is the same as totalling everything at once', () => {
        const a = [req(1, { input: 3 }), req(2, { output: null })];
        const b = [req(3, { cacheRead: 9 })];
        const merged = mergeTotals(totalsOf(a), totalsOf(b));
        const whole = totalsOf([...a, ...b]);
        assert.deepStrictEqual(merged, whole);
        assert.strictEqual(merged.coverage.start, 1);
        assert.strictEqual(merged.coverage.newest, 3);
    });

    test('the cache read share is of input, and undefined without any', () => {
        assert.strictEqual(cacheReadShare(totalsOf([req(1, { input: 10, cacheCreation: 10, cacheRead: 80 })])), 0.8);
        assert.strictEqual(cacheReadShare(totalsOf([])), null);
    });

    test('a zone the runtime does not know is refused, not guessed', () => {
        assert.ok(isTimeZone('Europe/Rome'));
        assert.ok(isTimeZone('UTC'));
        assert.ok(!isTimeZone('Mars/Olympus_Mons'));
        assert.throws(() => localDate(0, 'Mars/Olympus_Mons'), RangeError);
    });

    test('a time is shown to the minute in the zone given, and one no Date holds as a dash', () => {
        assert.strictEqual(localMinute(Date.UTC(2026, 9, 9, 22, 30), 'Europe/Rome'), '2026-10-10 00:30');
        assert.strictEqual(localMinute(Date.UTC(2026, 9, 9, 22, 30), 'UTC'), '2026-10-09 22:30');
        for (const time of [9e15, -9e15, NaN, Infinity]) {
            assert.strictEqual(localMinute(time, 'UTC'), '—', String(time));
        }
    });
});
