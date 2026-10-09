import * as assert from 'assert';

import { meter, rankedBars } from '../../src/charts';

suite('charts', () => {
    test('a meter fills to its share, never past the end of its track', () => {
        const width = (html: string): number =>
            Number(/class="meter-fill" style="width: ([\d.]+)%/.exec(html)?.[1]);

        assert.strictEqual(width(meter(0.25, 'ok', '25%', 'of 4')), 25);
        assert.strictEqual(width(meter(50, 'error', '5000%', 'over')), 100);
        assert.ok(meter(0.9, 'warning', '90%', 'close').includes('data-severity="warning"'));
    });

    test('a meter escapes its figure and caption', () => {
        const html = meter(0.5, 'ok', '<b>', '<img src=x onerror=alert(1)>');
        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('&lt;img'), html);
        assert.ok(!html.includes('<b>'), html);
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
