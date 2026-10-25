import { request } from './client';
import type { Cart } from '../cart';

export interface Order {
    id: string;
    total: number;
    status: 'pending' | 'paid' | 'shipped';
}

export function placeOrder(cart: Cart): Promise<Order> {
    return request<Order>('/orders', { method: 'POST', body: JSON.stringify(cart) });
}

export function getOrder(id: string): Promise<Order> {
    return request<Order>(`/orders/${encodeURIComponent(id)}`);
}
