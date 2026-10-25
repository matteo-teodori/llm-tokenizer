import { useEffect, useState } from 'react';
import { request } from './api/client';

export interface Product {
    id: string;
    name: string;
    price: number;
    image: string;
    inStock: boolean;
}

export function useProducts(): Product[] {
    const [products, setProducts] = useState<Product[]>([]);
    useEffect(() => {
        void request<Product[]>('/products').then(setProducts);
    }, []);
    return products;
}
