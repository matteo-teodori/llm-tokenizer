/**
 * Format a token count for display.
 *
 * @example formatNumber(1500) // "1.5K"
 */
export function formatNumber(num: number): string {
    // Thresholds are nudged below the round number because the unit used to be
    // chosen before rounding: 999,990 is under 1,000,000, so it took the K
    // branch, and `toFixed(1)` then rendered it as "1000.0K".
    if (num >= 999_950) {
        return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1_000) {
        return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toString();
}
