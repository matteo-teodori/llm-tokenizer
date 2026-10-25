import type { Product } from './products';

export interface CartLine {
    productId: string;
    name: string;
    unitPrice: number;
    quantity: number;
}

export interface Cart {
    lines: CartLine[];
}

export const emptyCart: Cart = { lines: [] };

/** Add one of `productId`, or one more of it if the cart has it already. */
export function addLine(cart: Cart, products: readonly Product[], productId: string): Cart {
    const product = products.find(p => p.id === productId);
    if (!product || !product.inStock) {
        return cart;
    }
    const existing = cart.lines.find(line => line.productId === productId);
    const lines = existing
        ? cart.lines.map(line => (line === existing ? { ...line, quantity: line.quantity + 1 } : line))
        : [...cart.lines, { productId, name: product.name, unitPrice: product.price, quantity: 1 }];
    return { ...cart, lines };
}

export function removeLine(cart: Cart, productId: string): Cart {
    return { ...cart, lines: cart.lines.filter(line => line.productId !== productId) };
}

/** The cart's total in cents, before shipping and tax. */
export function subtotal(cart: Cart): number {
    return cart.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
}
