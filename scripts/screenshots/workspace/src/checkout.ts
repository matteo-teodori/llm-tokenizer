import { placeOrder, type Order } from './api/orders';
import { subtotal, type Cart } from './cart';

export const MIN_ORDER_CENTS = 500;

export type CheckoutResult = { ok: true; order: Order } | { ok: false; reason: 'empty' | 'below-minimum' };

export async function checkout(cart: Cart): Promise<CheckoutResult> {
    if (cart.lines.length === 0) {
        return { ok: false, reason: 'empty' };
    }
    if (subtotal(cart) < MIN_ORDER_CENTS) {
        return { ok: false, reason: 'below-minimum' };
    }
    return { ok: true, order: await placeOrder(cart) };
}
