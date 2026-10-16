import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

/**
 * Atlas stores the user's requested effort independently of model capabilities.
 * Pi 0.82 supports Max natively. Never translate it into Extra High or mutate
 * a model's effort map. This module is renderer-safe (type-only SDK imports).
 */
export type MixerThinkingLevel = ThinkingLevel;

export const THINKING_LEVELS: MixerThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const LEVEL_LABELS: Record<MixerThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

export function isThinkingLevel(v: unknown): v is MixerThinkingLevel {
  return (
    typeof v === 'string' && THINKING_LEVELS.includes(v as MixerThinkingLevel)
  );
}

export interface ThinkingCapabilities {
  /** Distinct efforts supported by this model/provider. */
  levels: MixerThinkingLevel[];
  /** What each saved preference runs as, including legacy unsupported values. */
  effectiveLevels: Record<MixerThinkingLevel, MixerThinkingLevel>;
}
