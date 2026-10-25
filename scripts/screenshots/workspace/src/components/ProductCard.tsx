import type { Product } from '../products';
import { formatPrice } from '../utils/currency';

export function ProductCard({ product, onAdd }: { product: Product; onAdd(id: string): void }) {
    return (
        <article className="product-card">
            <img src={product.image} alt="" loading="lazy" />
            <h3>{product.name}</h3>
            <p>{formatPrice(product.price)}</p>
            <button onClick={() => onAdd(product.id)} disabled={!product.inStock}>
                {product.inStock ? 'Add to cart' : 'Sold out'}
            </button>
        </article>
    );
}
