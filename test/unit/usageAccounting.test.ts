import * as assert from 'assert';

import { compareRecords, dedupe, preferred } from '../../src/usage/accounting';
import { byDay, rollup, totalsOf } from '../../src/usage/aggregate';
import { isSyntheticModel, variantOf } from '../../src/usage/modelIds';
import { addProvenance, isComplete, totalPrefix } from '../../src/usage/provenance';
import type { UsageRequest } from '../../src/usage/types';
import { findModel, modelById } from '../../src/tokenizer/registry';

/** A request with every field set, overridden where a test cares. */
function req(overrides: Partial<UsageRequest> = {}): UsageRequest {
    return {
        provider: 'claude-code',
        messageId: 'msg_1',
        requestId: 'req_1',
        sessionId: 'session-a',
        kind: 'main',
        isMain: true,
        timestamp: Date.UTC(2026, 9, 9, 10, 0),
        model: 'claude-opus-5-5',
        variant: null,
        input: 0,
        cacheCreation: 0,
        cacheRead: 0,
        output: 0,
        cacheWrite5m: null,
        cacheWrite1h: null,
        thinking: null,
        effort: null,
        webSearchRequests: null,
        webFetchRequests: null,
        claudeCodeVersion: '2.1.292',
        agentId: null,
        runId: null,
        file: '/root/projects/p/session-a.jsonl',
        byteOffset: 0,
        parserVersion: 1,
        ...overrides,
    };
}

/** mulberry32: a small seeded generator, so a failing order can be replayed. */
function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/**
 * The proposal's oracle, in its order: (input, cache read, cache creation,
 * output). R1 streams two snapshots, R2 one. Fields are named, so no column
 * order can swap the two cache categories.
 */
const ORACLE: UsageRequest[] = [
    req({ messageId: 'R1', input: 120, cacheRead: 800, cacheCreation: 50, output: 20, byteOffset: 0 }),
    req({ messageId: 'R1', input: 120, cacheRead: 800, cacheCreation: 50, output: 60, byteOffset: 900 }),
    req({ messageId: 'R2', input: 70, cacheRead: 100, cacheCreation: 10, output: 30, byteOffset: 1800 }),
];

suite('usage accounting', () => {
    test('the oracle: R1 = 1,030, R2 = 210, the session 1,240', () => {
        const requests = dedupe(ORACLE);
        const totals = (id: string) => totalsOf([requests.get(id)!]).processed;
        assert.strictEqual(totals('R1'), 1_030);
        assert.strictEqual(totals('R2'), 210);

        const session = totalsOf(requests.values());
        assert.deepStrictEqual(
            { input: session.input, cacheRead: session.cacheRead, cacheCreation: session.cacheCreation, output: session.output, processed: session.processed },
            { input: 190, cacheRead: 900, cacheCreation: 60, output: 90, processed: 1_240 },
        );
        assert.strictEqual(session.coverage.requests, 2);
    });

    test('summing snapshots, or keeping the first one, would both be wrong', () => {
        // The two measured failure modes: every line counted (1.94× too high on
        // real data), and first seen wins (3.6× too low on output).
        const everyLine = totalsOf(ORACLE).processed;
        const firstSeen = totalsOf([ORACLE[0], ORACLE[2]]).processed;
        assert.notStrictEqual(everyLine, 1_240);
        assert.notStrictEqual(firstSeen, 1_240);
        assert.strictEqual(totalsOf(dedupe(ORACLE).values()).processed, 1_240);
    });

    test('a whole record wins, never a field-by-field maximum', () => {
        // F01. A maximum per field would give (100, 60, 20), which no record
        // ever said.
        const a = req({ input: 100, cacheRead: 50, output: 10, byteOffset: 0 });
        const b = req({ input: 90, cacheRead: 60, output: 20, byteOffset: 500 });
        const winner = dedupe([a, b]).get('msg_1');
        assert.strictEqual(winner, b);
        assert.deepStrictEqual([winner.input, winner.cacheRead, winner.output], [90, 60, 20]);
    });

    test('the comparator: parser, then main chain, then completeness, then output, then position', () => {
        const base = req({ output: 10 });
        const cases: [string, UsageRequest, UsageRequest][] = [
            ['a newer parser wins whatever its output', req({ parserVersion: 2, output: 1 }), req({ output: 999 })],
            ['the main chain beats a sidechain copy', req({ isMain: true, output: 1 }), req({ isMain: false, output: 999 })],
            ['all four counters reported beats a missing one', req({ output: 1 }), req({ cacheRead: null, output: 999 })],
            ['more output wins', req({ output: 20 }), base],
            ['missing output loses to a reported zero', req({ input: null, output: 0 }), req({ input: null, output: null })],
            ['the earlier file wins a tie', req({ file: '/a.jsonl' }), req({ file: '/b.jsonl' })],
            ['then the earlier offset', req({ byteOffset: 10 }), req({ byteOffset: 20 })],
        ];
        for (const [name, winner, loser] of cases) {
            assert.ok(compareRecords(winner, loser) < 0, name);
            assert.ok(compareRecords(loser, winner) > 0, `${name} (reversed)`);
            assert.strictEqual(preferred(loser, winner), winner, `${name} (preferred)`);
        }
        assert.strictEqual(compareRecords(base, req({ output: 10 })), 0, 'identical records tie');
    });

    test('paths compare as UTF-8 bytes, the way SQLite compares text', () => {
        // In UTF-16, U+10000 (a surrogate pair from 0xD800) sorts before
        // U+FFFF; in UTF-8 (F0 90 80 80 against EF BF BF) it sorts after. The
        // store's upsert compares UTF-8, so this must too, or the two pick
        // different records.
        const bmp = req({ file: '/p/￿.jsonl' });
        const astral = req({ file: '/p/\u{10000}.jsonl' });
        assert.ok(astral.file < bmp.file, 'the premise: JavaScript orders them the other way');
        assert.ok(compareRecords(bmp, astral) < 0);
    });

    test('any order, duplication or re-import gives the same rollups', () => {
        const records: UsageRequest[] = [
            ...ORACLE,
            req({ messageId: 'R3', sessionId: 'session-b', model: 'claude-sonnet-5-5', kind: 'task', isMain: false, input: 5, cacheRead: 7, cacheCreation: 1, output: 3, timestamp: Date.UTC(2026, 9, 9, 23, 30), file: '/root/projects/p/session-b/subagents/agent-1.jsonl' }),
            req({ messageId: 'R3', sessionId: 'session-b', model: 'claude-sonnet-5-5', kind: 'task', isMain: false, input: 5, cacheRead: 7, cacheCreation: 1, output: 9, timestamp: Date.UTC(2026, 9, 9, 23, 30), file: '/root/projects/p/session-b/subagents/agent-1.jsonl', byteOffset: 400 }),
            req({ messageId: 'R4', sessionId: 'session-b', kind: 'workflow', isMain: false, input: 2, cacheRead: null, cacheCreation: 0, output: 4, timestamp: Date.UTC(2026, 9, 10, 0, 15), file: '/root/projects/p/session-b/subagents/workflows/wf_1/agent-2.jsonl' }),
        ];
        const snapshot = (input: UsageRequest[]) => {
            const chosen = [...dedupe(input).values()];
            const rows = (m: Map<string, ReturnType<typeof totalsOf>>) =>
                [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, t]) => [k, t.processed, t.provenance, t.coverage.requests]);
            return JSON.stringify({
                total: totalsOf(chosen),
                byDay: rows(byDay(chosen, 'Europe/Rome')),
                byModel: rows(rollup(chosen, r => r.model)),
                bySession: rows(rollup(chosen, r => r.sessionId)),
                byKind: rows(rollup(chosen, r => r.kind)),
            });
        };

        const expected = snapshot(records);
        assert.strictEqual(snapshot([...records].reverse()), expected, 'reversed');
        assert.strictEqual(snapshot([...records, ...records]), expected, 'imported twice');
        const random = seeded(20261009);
        for (let i = 0; i < 200; i++) {
            const doubled = shuffled([...records, ...shuffled(records, random).slice(0, 3)], random);
            assert.strictEqual(snapshot(doubled), expected, `permutation ${i}`);
        }
    });

    test('a missing counter makes a total a lower bound; a real zero does not', () => {
        // F10. Null is unknown and marks the total with ≥; 0 is a known zero.
        const known = totalsOf([req({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0 })]);
        assert.strictEqual(known.provenance, 'reported');
        assert.strictEqual(totalPrefix(known.provenance), '');

        const unknown = totalsOf([req({ messageId: 'a', output: 5 }), req({ messageId: 'b', cacheRead: null, output: 5 })]);
        assert.strictEqual(unknown.provenance, 'partial');
        assert.strictEqual(totalPrefix(unknown.provenance), '≥');
        assert.strictEqual(unknown.coverage.incompleteRequests, 1);
        assert.strictEqual(unknown.processed, 10, 'the missing counter adds nothing');
        assert.ok(!isComplete(req({ input: null })));
    });

    test('a snapshot is a state and cannot be summed', () => {
        assert.throws(() => addProvenance('snapshot', 'reported'));
        assert.throws(() => addProvenance('reported', 'snapshot'));
        assert.strictEqual(addProvenance('reported', 'partial'), 'partial');
        assert.strictEqual(addProvenance('reported', 'reported'), 'reported');
    });

    test('model ids are kept as recorded, with the routing suffix apart', () => {
        // F09. An unknown or renamed id stays unresolved: following the alias
        // would credit a retired model's usage to its replacement.
        assert.strictEqual(modelById('claude-3-opus'), undefined);
        assert.strictEqual(findModel('claude-3-opus')?.id, 'claude-opus-5', 'the premise: the tokenizer side follows it');
        assert.strictEqual(modelById('claude-opus-5-5')?.label, 'Claude Opus 5.5');
        assert.strictEqual(modelById('claude-opus-5-5[1m]'), undefined, 'the bracket is not part of an id');

        assert.strictEqual(variantOf('claude-opus-5-5[1m]'), '1m');
        assert.strictEqual(variantOf('claude-opus-5-5'), null);
        assert.strictEqual(variantOf(undefined), null);
        assert.ok(isSyntheticModel('<synthetic>'));
        assert.ok(!isSyntheticModel('claude-opus-5-5'));
    });
});
