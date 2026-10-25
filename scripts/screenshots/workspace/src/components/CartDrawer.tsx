import { useMemo } from 'react';
import { subtotal, type Cart } from '../cart';
import { formatPrice } from '../utils/currency';

interface CartDrawerProps {
    cart: Cart;
    open: boolean;
    onClose(): void;
    onCheckout(): void;
}

export function CartDrawer({ cart, open, onClose, onCheckout }: CartDrawerProps) {
    const total = useMemo(() => subtotal(cart), [cart]);
    if (!open) {
        return null;
    }
    return (
        <aside className="cart-drawer" aria-label="Shopping cart">
            <header>
                <h2>Your cart</h2>
                <button onClick={onClose} aria-label="Close cart">×</button>
            </header>
            <ul>
                {cart.lines.map(line => (
                    <li key={line.productId}>
                        <span>{line.name}</span>
                        <span>{line.quantity} × {formatPrice(line.unitPrice)}</span>
                    </li>
                ))}
            </ul>
            <footer>
                <strong>{formatPrice(total)}</strong>
                <button onClick={onCheckout} disabled={cart.lines.length === 0}>Checkout</button>
            </footer>
        </aside>
    );
}
