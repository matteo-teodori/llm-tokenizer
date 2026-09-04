import * as assert from 'assert';

import { renderSummary, type SummaryView } from '../../src/summary/render';
import { contentSecurityPolicy, createNonce } from '../../src/html';

function view(overrides: Partial<SummaryView> = {}): SummaryView {
    return {
        totalTokens: 1_000,
        exact: true,
        cancelled: false,
        modelLabel: 'GPT-5.6 Sol',
        contextLimit: 10_000,
        filesCounted: 2,
        filesSkipped: 0,
        filesIgnored: 0,
        byFolder: [{ label: 'src', tokens: 1_000, files: 2, share: 1 }],
        byLanguage: [{ label: 'TypeScript', tokens: 1_000, files: 2, share: 1 }],
        files: [
            { path: '/repo/src/a.ts', display: 'src/a.ts', tokens: 700 },
            { path: '/repo/src/b.ts', display: 'src/b.ts', tokens: 300 },
        ],
        filesNotListed: 0,
        skipped: [],
        ignored: [],
        ...overrides,
    };
}

function render(overrides: Partial<SummaryView> = {}): string {
    const nonce = createNonce();
    return renderSummary(view(overrides), nonce, contentSecurityPolicy(nonce));
}

suite('summary page', () => {
    test('leads with the total as a hero figure', () => {
        const html = render({ totalTokens: 1_240_000 });
        assert.ok(html.includes('1.2M'), 'the total should be shown compactly');
        assert.ok(/class="hero-value"/.test(html));
    });

    test('marks an estimated total, and leaves an exact one unmarked', () => {
        assert.ok(render({ exact: false }).includes('≈'));
        assert.ok(render({ exact: false }).includes('estimated'));

        const exact = render({ exact: true });
        assert.ok(!exact.includes('≈'), 'an exact count must not be prefixed');
        assert.ok(exact.includes('>exact<'));
    });

    test('says so when the run was cancelled', () => {
        assert.ok(render({ cancelled: true }).includes('Cancelled'));
        assert.ok(!render({ cancelled: false }).includes('Cancelled'));
    });

    test('the meter reflects severity against the context limit', () => {
        assert.ok(render({ totalTokens: 1_000, contextLimit: 10_000 })
            .includes('data-severity="ok"'));
        assert.ok(render({ totalTokens: 8_500, contextLimit: 10_000 })
            .includes('data-severity="warning"'));
        assert.ok(render({ totalTokens: 12_000, contextLimit: 10_000 })
            .includes('data-severity="error"'));
    });

    test('the meter figure never claims a threshold the caption has not crossed', () => {
        // Rounding used to print "100% — Approaching the … limit" at 99.7%, and
        // "80%" with the unwarned styling at 79.99%: the number and the words
        // beside it said different things.
        const caption = (html: string): string => {
            const inner = /<div class="meter-caption">([\s\S]*?)<\/div>/.exec(html)?.[1];
            assert.ok(inner, 'no meter caption was rendered');
            return inner.replace(/<[^>]*>/g, '').trim();
        };

        const nearLimit = render({ totalTokens: 9_970, contextLimit: 10_000 });
        assert.ok(nearLimit.includes('data-severity="warning"'));
        assert.ok(!caption(nearLimit).startsWith('100%'), `said "${caption(nearLimit)}" while under the limit`);

        const nearWarning = render({ totalTokens: 7_999, contextLimit: 10_000 });
        assert.ok(nearWarning.includes('data-severity="ok"'));
        assert.ok(!caption(nearWarning).startsWith('80%'), `said "${caption(nearWarning)}" while unwarned`);

        // And the thresholds themselves still read exactly.
        assert.ok(caption(render({ totalTokens: 8_000, contextLimit: 10_000 })).startsWith('80%'));
        assert.ok(caption(render({ totalTokens: 10_000, contextLimit: 10_000 })).startsWith('100%'));
    });

    test('the meter fill never runs past the end of its track', () => {
        // A count far over the limit would otherwise produce a width of several
        // hundred percent and spill out of the panel.
        const html = render({ totalTokens: 500_000, contextLimit: 10_000 });
        const widths = [...html.matchAll(/class="meter-fill" style="width: ([\d.]+)%/g)]
            .map(m => Number(m[1]));

        assert.strictEqual(widths.length, 1);
        assert.ok(widths[0] <= 100, `fill width was ${widths[0]}%`);
    });

    test('a model with no published limit shows no meter', () => {
        const html = render({ contextLimit: undefined });
        // The class always exists in the stylesheet; what matters is that no
        // meter element is rendered.
        assert.ok(!/<div class="meter"/.test(html), 'a meter was rendered with no limit to meter against');
        assert.ok(html.includes('no published context limit'));
    });

    test('bar widths are relative to the largest row and stay within bounds', () => {
        const html = render({
            byFolder: [
                { label: 'src', tokens: 800, files: 1, share: 0.8 },
                { label: 'docs', tokens: 200, files: 1, share: 0.2 },
            ],
            // Cleared so the language chart's own bars do not join the match.
            byLanguage: [],
        });
        const widths = [...html.matchAll(/class="row-bar" style="width: ([\d.]+)%/g)]
            .map(m => Number(m[1]));

        assert.deepStrictEqual(widths, [100, 25]);
    });

    test('discloses files counted but not listed', () => {
        assert.ok(render({ filesNotListed: 1_500 }).includes('1,500'));
        assert.ok(!render({ filesNotListed: 0 }).includes('not listed'));
    });

    test('the copy and CSV exports carry the truncation note too', () => {
        // The page said so in its own note while Copy and Export CSV emitted a
        // silently truncated list — the exact failure the on-page note exists to
        // prevent, one surface along. The note is embedded server-side so the
        // wording is absent entirely when nothing was dropped.
        const truncated = render({ filesNotListed: 1_500 });
        assert.ok(
            truncated.includes('TRUNCATION_NOTE'),
            'the export handlers should reference the note',
        );
        assert.ok(
            /TRUNCATION_NOTE = "[^"]*1,500 smaller files/.test(truncated),
            'the note should be embedded with the real count',
        );

        const complete = render({ filesNotListed: 0 });
        assert.ok(
            /TRUNCATION_NOTE = ""/.test(complete),
            'a complete list should embed an empty note',
        );
    });

    test('escapes workspace-controlled text everywhere it appears', () => {
        // File and folder names are attacker-controlled: these are all legal
        // names on macOS and Linux, and the page runs with scripts enabled.
        const payload = '<img src=x onerror=alert(1)>';
        const html = render({
            modelLabel: payload,
            byFolder: [{ label: payload, tokens: 1, files: 1, share: 1 }],
            byLanguage: [{ label: payload, tokens: 1, files: 1, share: 1 }],
            skipped: [{ display: payload, reason: payload }],
            ignored: [{ display: payload }],
        });

        assert.ok(!html.includes('<img src=x'), 'a raw tag reached the document');
        assert.ok(html.includes('&lt;img src=x'), 'the payload should be escaped');
    });

    test('embedded file data cannot break out of the script block', () => {
        // A file literally named `</script><script>…` would otherwise end the
        // page's own script early and start a new one.
        const html = render({
            files: [{ path: '/repo/x.ts', display: '</script><script>alert(1)</script>', tokens: 1 }],
        });

        assert.ok(!html.includes('</script><script>alert(1)'), 'the payload closed the script block');
        assert.ok(html.includes('\\u003c/script'), 'angle brackets should be escaped in the payload');
    });

    test('carries the nonce and a strict policy', () => {
        const nonce = createNonce();
        const html = renderSummary(view(), nonce, contentSecurityPolicy(nonce));

        assert.ok(html.includes(`<script nonce="${nonce}">`));
        assert.ok(html.includes("default-src 'none'"));
        assert.ok(!/script-src[^;"]*unsafe-inline/.test(html));
    });

    test('renders an empty run without throwing or showing NaN', () => {
        const html = render({
            totalTokens: 0,
            filesCounted: 0,
            byFolder: [],
            byLanguage: [],
            files: [],
        });

        assert.ok(!html.includes('NaN'), 'a zero total produced NaN somewhere');
        assert.ok(!html.includes('Infinity'));
    });

    test('skipped and ignored sections appear only when they have rows', () => {
        assert.ok(!render().includes('Skipped'));
        assert.ok(render({ skipped: [{ display: 'a.png', reason: 'Binary' }] }).includes('Skipped'));
    });
});
