import { useEffect, useState } from 'react';
import type { ModelOption } from '../agent/models';
import type { ModelSelection } from '../agent/settings';
import {
  LEVEL_LABELS,
  type MixerThinkingLevel as ThinkingLevel,
} from '../lib/thinking-levels';

export function ThinkingPicker({
  current,
  onChange,
  models,
  model,
  disabled = false,
}: {
  current: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  models: ModelOption[];
  model: ModelSelection | null;
  disabled?: boolean;
}) {
  const [extraModel, setExtraModel] = useState<ModelOption | null>(null);
  const key = model ? `${model.provider}/${model.modelId}` : '';
  const selected = models.find(item => item.key === key);
  // A saved older model may not be in the featured list. Resolve its actual
  // metadata without changing the selection or the user's saved preference.
  useEffect(() => {
    setExtraModel(null);
    if (!key || selected?.thinking) return;
    let active = true;
    void window.modmixer.listModels(true).then(items => {
      if (active) setExtraModel(items.find(item => item.key === key) ?? null);
    }).catch(() => {});
    return () => { active = false; };
  }, [key, selected]);
  const capabilities = (selected?.thinking ? selected : extraModel?.key === key ? extraModel : null)?.thinking;
  const effective = capabilities?.effectiveLevels[current];
  const usesFallback = effective !== undefined && effective !== current;
  const levels = capabilities?.levels ?? [];
  const title = !capabilities
    ? 'Thinking options are unavailable until this model is connected. Your saved preference is preserved.'
    : usesFallback
      ? `Saved preference: ${LEVEL_LABELS[current]}. This model uses ${LEVEL_LABELS[effective]}. Switching models keeps your saved preference.`
      : 'Thinking effort for this model. Higher effort may take longer. Effort levels differ between providers.';
  return (
    <label className="felix-control" title={title}>
      <span className="sr-only">Thinking</span>
      <select
        value={current}
        disabled={disabled || !capabilities}
        onChange={(e) => onChange(e.target.value as ThinkingLevel)}
        className="felix-select"
      >
        {!levels.includes(current) && (
          <option value={current} disabled>
            Thinking: {LEVEL_LABELS[current]}{usesFallback ? ` (uses ${LEVEL_LABELS[effective]})` : ' (saved)'}
          </option>
        )}
        {levels.map((level) => (
          <option key={level} value={level} className="font-mono">
            Thinking: {LEVEL_LABELS[level]}
          </option>
        ))}
      </select>
      <svg
        aria-hidden
        className="felix-chevron"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M3 5l3 3 3-3" />
      </svg>
    </label>
  );
}
