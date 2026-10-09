// Claude plan limits are separate from Claude Platform API billing. This
// endpoint is used by Claude Code's /usage view, but is not a public API.
import {createHash} from 'node:crypto';

export type ClaudeUsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
};

export type ClaudeUsage = {
  status: 'loading' | 'ready' | 'stale' | 'unavailable' | 'disconnected' | 'api-key';
  windows: ClaudeUsageWindow[];
  updatedAt?: number;
};

type UsageHost = {
  modelRuntime?: {
    isUsingOAuth(provider: string): boolean;
    getAuth(provider: string): Promise<{auth?: {apiKey?: string}} | undefined>;
  };
};

type UsageCache = {
  key: string;
  value: ClaudeUsage | null;
  checkedAt: number;
  retryAt: number;
  inflight: Promise<ClaudeUsage> | null;
};

let cache: UsageCache | null = null;
let epoch = 0;
const empty = (status: ClaudeUsage['status']): ClaudeUsage => ({status, windows: []});

export function clearClaudeUsage(): void {
  epoch++;
  cache = null;
}

export function parseClaudeUsage(payload: unknown, now = Date.now()): ClaudeUsage {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const windows: ClaudeUsageWindow[] = [];
  const percent = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      ? value : null;
  const resetTime = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value / 1000 : value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed / 1000 : null;
    }
    return null;
  };
  const add = (id: string, label: string, value: unknown, field = 'utilization') => {
    if (!value || typeof value !== 'object' || windows.some(window => window.id === id)) return;
    const entry = value as Record<string, unknown>;
    const usedPercent = percent(entry[field]);
    if (usedPercent === null) return;
    windows.push({id, label, usedPercent, resetsAt: resetTime(entry.resets_at)});
  };

  add('session', '5h', data.five_hour);
  add('weekly', 'Week', data.seven_day);
  add('opus', 'Opus week', data.seven_day_opus);
  add('sonnet', 'Sonnet week', data.seven_day_sonnet);
  add('fable', 'Fable week', data.seven_day_overage_included);
  if (Array.isArray(data.limits)) for (const item of data.limits) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const kind = entry.kind;
    if (kind === 'session') add('session', '5h', entry, 'percent');
    else if (kind === 'weekly_all') add('weekly', 'Week', entry, 'percent');
    else if (kind === 'weekly_scoped') {
      const scope = entry.scope && typeof entry.scope === 'object' ? entry.scope as Record<string, unknown> : {};
      const model = scope.model && typeof scope.model === 'object' ? scope.model as Record<string, unknown> : {};
      const name = typeof model.display_name === 'string' ? model.display_name.trim().slice(0, 40) : '';
      if (name) add(`scoped:${name.toLowerCase()}`, `${name} week`, entry, 'percent');
    }
  }
  // Extra usage is paid overflow, not the included Claude plan or API credit balance.
  const extra = data.extra_usage;
  if (extra && typeof extra === 'object' && (extra as Record<string, unknown>).is_enabled === true)
    add('extra', 'Extra usage', extra);
  return {status: windows.length ? 'ready' : 'unavailable', windows, updatedAt: now};
}

export async function getClaudeUsage(host: UsageHost, force = false): Promise<ClaudeUsage> {
  const runtime = host.modelRuntime;
  if (!runtime) return empty('loading');
  let token: string | undefined;
  try {
    const oauth = runtime.isUsingOAuth('anthropic');
    const auth = await runtime.getAuth('anthropic');
    token = auth?.auth?.apiKey;
    if (!token) { clearClaudeUsage(); return empty('disconnected'); }
    if (!oauth) { clearClaudeUsage(); return empty('api-key'); }
  } catch { clearClaudeUsage(); return empty('unavailable'); }

  const key = createHash('sha256').update(token).digest('hex');
  if (!cache || cache.key !== key) cache = {key, value: null, checkedAt: 0, retryAt: 0, inflight: null};
  const current = cache;
  if (current.inflight) return current.inflight;
  const now = Date.now();
  if (now < current.retryAt) return current.value ?? empty('unavailable');
  if (current.value && now - current.checkedAt < (force ? 30000 : 300000)) return current.value;
  const requestEpoch = epoch;
  current.inflight = (async () => {
    let value: ClaudeUsage;
    let retryAt = 0;
    try {
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json'},
      });
      if (!response.ok) {
        if (response.status === 429) retryAt = Date.now() + 10 * 60_000;
        throw new Error('Claude usage request failed');
      }
      value = parseClaudeUsage(await response.json());
    } catch {
      value = current.value?.updatedAt ? {...current.value, status: 'stale'} : empty('unavailable');
    }
    if (cache !== current || epoch !== requestEpoch) return empty('loading');
    current.value = value;
    current.checkedAt = Date.now();
    current.retryAt = retryAt;
    return value;
  })();
  try { return await current.inflight; }
  finally { current.inflight = null; }
}
