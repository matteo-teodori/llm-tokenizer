/**
 * The model registry: what the extension knows about each model.
 *
 * `package.json` used to carry its own hand-maintained copy of the model ids and
 * labels for the settings dropdown, and the two drifted. The enum is now
 * generated from `MODELS` by `scripts/sync-manifest.mjs`, which CI verifies, so
 * there is exactly one source of truth.
 */

import type { EncoderSpec } from './encoders';
import { MODELS, MODEL_ALIASES, DEFAULT_MODEL_ID } from './models';

export interface ModelInfo {
    /** Stable id. Also what gets persisted in settings and global state. */
    id: string;
    /** Human-readable name shown in the picker and status bar. */
    label: string;
    provider: string;
    /** How this model's tokens are counted. */
    encoder: EncoderSpec;
    /** Input context window in tokens. Omitted when the model has no published limit. */
    contextLimit?: number;
}

export { MODELS, MODEL_ALIASES, DEFAULT_MODEL_ID };

const BY_ID = new Map(MODELS.map(model => [model.id, model]));

/** Look up a model by id, following aliases from removed ids. */
export function findModel(id: string): ModelInfo | undefined {
    const direct = BY_ID.get(id);
    if (direct) {
        return direct;
    }

    const alias = MODEL_ALIASES[id];
    return alias ? BY_ID.get(alias) : undefined;
}

/**
 * Look up a model by its exact id, never following an alias.
 *
 * For labelling what a model actually did, as opposed to choosing a tokenizer:
 * an alias maps a retired id onto a different, live model, so following one
 * would credit a retired model's usage to its replacement. An id the registry
 * does not list stays unresolved, and is shown as recorded.
 */
export function modelById(id: string): ModelInfo | undefined {
    return BY_ID.get(id);
}

/**
 * The model used when nothing has been chosen, or the choice no longer exists.
 *
 * Resolved from `DEFAULT_MODEL_ID` rather than being `MODELS[0]`, the first
 * row of a registry ordered roughly newest-first, which need not be one that
 * can be counted exactly. The same constant is written into the
 * manifest's `defaultModel` setting, and an invariant test asserts the two
 * agree.
 */
export function defaultModel(): ModelInfo {
    return BY_ID.get(DEFAULT_MODEL_ID) ?? MODELS[0];
}

/** Providers in registry order, for grouping the picker. */
export function providers(): string[] {
    return [...new Set(MODELS.map(model => model.provider))];
}

