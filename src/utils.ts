import type { ContextStatus } from './types';

/**
 * Format a token count for display.
 *
 * @example formatNumber(1500) // "1.5K"
 */
export function formatNumber(num: number): string {
    if (num >= 1_000_000) {
        return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1_000) {
        return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toString();
}

/** Colour for the summary webview, which cannot use ThemeColor. */
export function getStatusColor(status: ContextStatus): string {
    switch (status) {
        case 'error': return '#f44336';
        case 'warning': return '#ff9800';
        default: return '#4caf50';
    }
}
