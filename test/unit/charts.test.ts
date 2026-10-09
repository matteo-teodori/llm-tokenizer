import * as assert from 'assert';

import { meter, rankedBars } from '../../src/charts';

suite('charts', () => {
    test('a meter fills to its share, never past the end of its track', () => {
        const width = (html: string): number =>
            Number(/class="meter-fill" style="width: ([\d.]+)%/.exec(html)?.[1]);

        assert.strictEqual(width(meter(0.25, 'ok', '25%', 'of 4', 'Used')), 25);
        assert.strictEqual(width(meter(50, 'error', '5000%', 'over', 'Used')), 100);
        assert.ok(meter(0.9, 'warning', '90%', 'close', 'Used').includes('data-severity="warning"'));
    });

    test('a meter tells a screen reader its name and value, within range', () => {
        const html = meter(0.25, 'ok', '25%', 'of 4', 'Context window used');
        assert.ok(/role="meter"/.test(html), html);
        assert.ok(html.includes('aria-label="Context window used"'), html);
        assert.ok(/aria-valuemin="0" aria-valuemax="100" aria-valuenow="25"/.test(html), html);
        assert.ok(html.includes('aria-valuetext="25% of 4"'), html);

        // Over the limit, the value is clamped to the range and the text keeps
        // the real figure.
        const over = meter(5, 'error', '500%', 'over the limit', 'Used');
        assert.ok(over.includes('aria-valuenow="100"'), over);
        assert.ok(over.includes('aria-valuetext="500% over the limit"'), over);
    });

    test('a meter escapes its figure, caption and name', () => {
        const html = meter(0.5, 'ok', '<b>', '<img src=x onerror=alert(1)>', '"><img src=y>');
        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('&lt;img'), html);
        assert.ok(!html.includes('<b>'), html);
        assert.ok(html.includes('aria-label="&quot;&gt;&lt;img src=y&gt;"'), html);
    });

    test('ranked bars are sized against the widest, in the order given', () => {
        const html = rankedBars([
            { label: 'b', tokens: 200, share: 0.2 },
            { label: 'a', tokens: 800, share: 0.8 },
        ]);
        const widths = [...html.matchAll(/class="row-bar" style="width: ([\d.]+)%/g)].map(m => Number(m[1]));
        assert.deepStrictEqual(widths, [25, 100]);
        assert.ok(html.indexOf('>b<') < html.indexOf('>a<'), 'the bars were reordered');
    });

    test('ranked bars escape their labels and survive an all-zero series', () => {
        const html = rankedBars([{ label: '<img src=x>', tokens: 0, share: 0 }]);
        assert.ok(!html.includes('<img'), html);
        assert.ok(!html.includes('NaN') && !html.includes('Infinity'), html);
    });
});
