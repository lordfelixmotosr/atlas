import { useEffect, useMemo, useState } from 'react';
import type { ModelOption } from '../agent/models';
import type { ModelSelection } from '../agent/settings';

const OLDER_MODELS_KEY = 'atlas.models.showOlder';
const TOGGLE_OLDER_KEY = '__atlas_toggle_older_models__';

function storedOlderModelsPreference(): boolean {
  try {
    return localStorage.getItem(OLDER_MODELS_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeOlderModelsPreference(value: boolean): void {
  try {
    localStorage.setItem(OLDER_MODELS_KEY, String(value));
  } catch {
    // Opaque test/demo origins may not expose local storage. The control still
    // works for this session; normal Atlas windows persist the preference.
  }
}

export function ModelPicker({
  models,
  current,
  onChange,
  onConnect,
}: {
  models: ModelOption[];
  current: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  onConnect: () => void;
}) {
  const [showOlder, setShowOlder] = useState(
    storedOlderModelsPreference,
  );
  const [catalogModels, setCatalogModels] = useState<ModelOption[] | null>(null);

  const currentKey = current ? `${current.provider}/${current.modelId}` : '';
  const currentMissing = !!currentKey && !models.some((m) => m.key === currentKey);

  useEffect(() => {
    if (!showOlder && !currentMissing) {
      setCatalogModels(null);
      return;
    }
    let currentRequest = true;
    void window.modmixer
      .listModels(true)
      .then((list) => {
        if (currentRequest) setCatalogModels(list);
      })
      .catch(() => {
        if (currentRequest) setCatalogModels(null);
      });
    return () => {
      currentRequest = false;
    };
  }, [showOlder, currentMissing, models]);

  const visibleModels = useMemo(() => {
    if (showOlder) return catalogModels ?? models;
    if (!currentMissing || !catalogModels) return models;
    const selected = catalogModels.find((m) => m.key === currentKey);
    return selected ? [...models, selected] : models;
  }, [catalogModels, currentKey, currentMissing, models, showOlder]);

  if (models.length === 0) {
    return (
      <button onClick={onConnect} className="felix-connect">
        Connect AI
      </button>
    );
  }

  // Recommended models float to the top so the picker leads with the
  // suggested default; within each group the original order is preserved
  // (sort is stable in modern JS engines).

  const sorted = [...visibleModels].sort((a, b) => {
    const ar = a.recommended ? 0 : 1;
    const br = b.recommended ? 0 : 1;
    return ar - br;
  });

  // If the saved selection isn't in the available list (e.g., the user just
  // logged out the provider it pointed at), implicitly fall back to the first
  // available model so the dropdown reflects what the agent will actually use.
  const effectiveKey =
    sorted.find((m) => m.key === currentKey)?.key ?? sorted[0].key;

  const onSelect = (key: string) => {
    if (key === TOGGLE_OLDER_KEY) {
      const next = !showOlder;
      setShowOlder(next);
      storeOlderModelsPreference(next);
      return;
    }
    const m = sorted.find((x) => x.key === key);
    if (m) onChange({ provider: m.provider, modelId: m.modelId });
  };

  return (
    <label className="felix-control felix-model-control">
      <span className="sr-only">Model</span>
      <select
        value={effectiveKey}
        onChange={(e) => onSelect(e.target.value)}
        className="felix-select felix-model-select"
      >
        {sorted.map((m) => (
          <option key={m.key} value={m.key} className="font-mono">
            {m.recommended ? '★ ' : ''}
            {m.providerLabel} — {m.label}{m.older ? ' (older)' : ''}
          </option>
        ))}
        <option disabled>──────────</option>
        <option value={TOGGLE_OLDER_KEY}>
          {showOlder ? 'Hide older models…' : 'Show older models…'}
        </option>
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
