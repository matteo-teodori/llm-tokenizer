const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
    });
    if (!response.ok) {
        throw new Error(`Request to ${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
}
