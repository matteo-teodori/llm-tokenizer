/**
 * The model registry: what the extension knows about each model.
 *
 * `package.json` used to carry its own hand-maintained copy of the model ids and
 * labels for the settings dropdown, and the two drifted. The enum is now
 * generated from `MODELS` by `scripts/sync-manifest.mjs`, which CI verifies, so
 * there is exactly one source of truth.
 */

import type { EncoderSpec } from './encoders';
import { MODELS, MODEL_ALIASES } from './models';

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

export { MODELS, MODEL_ALIASES };

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

/** The model used when nothing has been chosen, or the choice no longer exists. */
export function defaultModel(): ModelInfo {
    return MODELS[0];
}

/** Providers in registry order, for grouping the picker. */
export function providers(): string[] {
    return [...new Set(MODELS.map(model => model.provider))];
}

export function modelsByProvider(provider: string): ModelInfo[] {
    return MODELS.filter(model => model.provider === provider);
}

/** Whether counts for this model are exact without downloading anything. */
export function isBundledExact(model: ModelInfo): boolean {
    return model.encoder.kind === 'tiktoken';
}
