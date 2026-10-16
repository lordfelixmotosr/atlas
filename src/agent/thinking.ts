import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { THINKING_LEVELS, isThinkingLevel, type MixerThinkingLevel, type ThinkingCapabilities } from '../lib/thinking-levels.js';

/** Use the same catalog and clamp as the session and provider adapter. */
export function effectiveThinkingLevel(model: Model<Api>, requested: MixerThinkingLevel): MixerThinkingLevel {
  const level = clampThinkingLevel(model, requested);
  const mapped = model.thinkingLevelMap?.[level];
  if (isThinkingLevel(mapped) && getSupportedThinkingLevels(model).includes(mapped)) return mapped;
  // The adaptive Anthropic adapter treats Minimal as Low when not overridden.
  if (level === 'minimal' && mapped === undefined && model.api === 'anthropic-messages'
      && (model as Model<'anthropic-messages'>).compat?.forceAdaptiveThinking === true) return 'low';
  return level;
}

export function thinkingCapabilities(model: Model<Api>): ThinkingCapabilities {
  const effectiveLevels = Object.fromEntries(THINKING_LEVELS.map(level =>
    [level, effectiveThinkingLevel(model, level)])) as ThinkingCapabilities['effectiveLevels'];
  return {
    levels: [...new Set(getSupportedThinkingLevels(model).map(level => effectiveLevels[level]))],
    effectiveLevels,
  };
}

/** Resolve only for execution. The persisted preference is never rewritten. */
export function toPiThinking<TApi extends Api>(model: Model<TApi> | undefined, level: MixerThinkingLevel) {
  return { model, level: model ? effectiveThinkingLevel(model, level) : level };
}

/** Pi represents Off by omitting reasoning. Codex needs explicit `none`;
 * otherwise the server may choose its default effort instead of disabling it. */
export function withThinkingControls(stream: StreamFn): StreamFn {
  return (model, context, options) => {
    if (model.api !== 'openai-codex-responses' || !model.reasoning || options?.reasoning !== undefined
        || !getSupportedThinkingLevels(model).includes('off')) return stream(model, context, options);
    const onPayload = options?.onPayload;
    return stream(model, context, {
      ...options,
      onPayload: async (payload, activeModel) => {
        const body = (await onPayload?.(payload, activeModel) ?? payload) as Record<string, unknown>;
        return { ...body, reasoning: { ...(body.reasoning as object), effort: model.thinkingLevelMap?.off ?? 'none' } };
      },
    });
  };
}
