const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** A price in cents, as the API sends it, for display. */
export function formatPrice(cents: number): string {
    return formatter.format(cents / 100);
}
