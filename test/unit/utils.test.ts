import * as assert from 'assert';
import { formatNumber } from '../../src/utils';

suite('formatNumber', () => {
    test('picks the unit after rounding, so no boundary renders as 1000', () => {
        // The unit used to be chosen before rounding: 999,990 took the K branch
        // and printed "1000.0K". Every boundary is checked from both sides.
        assert.strictEqual(formatNumber(999), '999');
        assert.strictEqual(formatNumber(1_000), '1.0K');
        assert.strictEqual(formatNumber(999_949), '999.9K');
        assert.strictEqual(formatNumber(999_950), '1.0M');
        assert.strictEqual(formatNumber(999_949_999), '999.9M');
        assert.strictEqual(formatNumber(999_950_000), '1.0B');
    });

    test('counts in the billions get their own unit', () => {
        // There was no unit above M, so a billion tokens read "1000.0M" and
        // 28.64 billion read "28640.0M".
        assert.strictEqual(formatNumber(1_000_000_000), '1.0B');
        assert.strictEqual(formatNumber(28_640_000_000), '28.6B');
    });
});
