import { useState } from 'react';
import { CartDrawer } from './components/CartDrawer';
import { ProductCard } from './components/ProductCard';
import { addLine, emptyCart } from './cart';
import { useProducts } from './products';

export function App() {
    const products = useProducts();
    const [cart, setCart] = useState(emptyCart);
    const [open, setOpen] = useState(false);
    return (
        <main>
            <section className="grid">
                {products.map(p => (
                    <ProductCard key={p.id} product={p} onAdd={id => setCart(c => addLine(c, products, id))} />
                ))}
            </section>
            <CartDrawer cart={cart} open={open} onClose={() => setOpen(false)} onCheckout={() => setOpen(false)} />
        </main>
    );
}
