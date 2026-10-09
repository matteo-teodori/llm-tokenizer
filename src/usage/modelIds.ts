/**
 * Model ids as Claude Code records them.
 *
 * `message.model` is kept verbatim: it is what the API answered with, and
 * usage is never attributed through the tokenizer registry's aliases, which
 * map retired ids onto different live models. `requestedModel`, on the few
 * records that carry it, adds a routing suffix in brackets, as in
 * `claude-opus-5-5[1m]`. The bracket is not part of a public id, so it is kept
 * apart, as the variant.
 */

/**
 * The model Claude Code writes on the placeholder records of API errors. They
 * always carry zero usage, so they are counted in diagnostics, never as
 * requests.
 */
export const SYNTHETIC_MODEL = '<synthetic>';

export function isSyntheticModel(model: string): boolean {
    return model === SYNTHETIC_MODEL;
}

/**
 * The routing suffix of a requested model id, `1m` for `claude-opus-5-5[1m]`,
 * or null when it has none.
 */
export function variantOf(requestedModel: string | undefined): string | null {
    if (!requestedModel) {
        return null;
    }
    const match = /\[([^[\]]+)\]$/.exec(requestedModel);
    return match ? match[1] : null;
}
