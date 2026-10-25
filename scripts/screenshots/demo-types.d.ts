/**
 * Just enough of React's, Vitest's and Vite's types for the demo workspace,
 * so that an editor opening its files reports nothing: the demo is never
 * built or installed, and has no dependencies of its own. Kept beside
 * workspace/ rather than in it, as the token summary counts that folder.
 */

declare module 'react' {
    export function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
    export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
    export function useMemo<T>(compute: () => T, deps: readonly unknown[]): T;
}

declare module 'react/jsx-runtime' {
    export function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element;
    export function jsxs(type: unknown, props: unknown, key?: unknown): JSX.Element;
    export const Fragment: unique symbol;
}

declare namespace JSX {
    type Element = object;
    interface IntrinsicAttributes {
        key?: string | number;
    }
    interface IntrinsicElements {
        [element: string]: Record<string, unknown>;
    }
}

declare module 'vitest' {
    export function describe(name: string, body: () => void): void;
    export function it(name: string, body: () => void | Promise<void>): void;
    export function expect(actual: unknown): {
        toBe(expected: unknown): void;
        toEqual(expected: unknown): void;
        toHaveLength(length: number): void;
    };
}

interface ImportMeta {
    readonly env: Readonly<Record<string, string | undefined>>;
}
