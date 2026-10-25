import { describe, expect, it } from 'vitest';
import { checkout } from '../src/checkout';
import { emptyCart } from '../src/cart';

describe('checkout', () => {
    it('refuses an empty cart', async () => {
        expect(await checkout(emptyCart)).toEqual({ ok: false, reason: 'empty' });
    });
});
