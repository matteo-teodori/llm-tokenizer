import { describe, expect, it } from 'vitest';
import { addLine, emptyCart, subtotal } from '../src/cart';

const products = [{ id: 'mug', name: 'Mug', price: 1200, image: '/mug.png', inStock: true }];

describe('cart', () => {
    it('adds one more of a product it has', () => {
        const cart = addLine(addLine(emptyCart, products, 'mug'), products, 'mug');
        expect(cart.lines).toHaveLength(1);
        expect(subtotal(cart)).toBe(2400);
    });

    it('ignores a product it does not know', () => {
        expect(addLine(emptyCart, products, 'lamp')).toBe(emptyCart);
    });
});
