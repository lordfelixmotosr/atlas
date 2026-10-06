import {
  LEVEL_LABELS,
  THINKING_LEVELS,
  type MixerThinkingLevel as ThinkingLevel,
} from '../lib/thinking-levels';

export function ThinkingPicker({
  current,
  onChange,
}: {
  current: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
}) {
  return (
    <label className="felix-control" title="Thinking effort">
      <span className="sr-only">Thinking</span>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value as ThinkingLevel)}
        className="felix-select"
      >
        {THINKING_LEVELS.map((level) => (
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
