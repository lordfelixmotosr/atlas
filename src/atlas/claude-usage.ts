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
  isOAuthLoginPending?(provider: string): boolean;
  modelRuntime?: {
    isUsingOAuth(provider: string): boolean;
    getAuth(provider: string): Promise<{auth?: {apiKey?: string}} | undefined>;
  };
};

type UsageCache = {
  runtime: NonNullable<UsageHost['modelRuntime']>;
  key: string | null;
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
  if (host.isOAuthLoginPending?.('anthropic')) return empty('loading');
  let oauth: boolean;
  try {
    oauth = runtime.isUsingOAuth('anthropic');
  } catch { return empty('unavailable'); }
  if (!oauth) {
    // This local auth lookup cannot refresh an OAuth credential. Detect logout
    // and API-key changes immediately instead of serving cached plan usage.
    if (cache) clearClaudeUsage();
    try {return empty((await runtime.getAuth('anthropic'))?.auth?.apiKey ? 'api-key' : 'disconnected');}
    catch {return empty('unavailable');}
  }
  if (cache && cache.runtime !== runtime) clearClaudeUsage();
  if (!cache) cache = {runtime, key: null, value: null, checkedAt: 0, retryAt: 0, inflight: null};
  const current = cache;
  // getAuth may POST to the token endpoint for expired credentials. It must
  // share the same single-flight and backoff as the usage request itself.
  if (current.inflight) return current.inflight;
  const now = Date.now();
  if (now < current.retryAt) return current.value ?? empty('unavailable');
  if (current.value && now - current.checkedAt < (force ? 30000 : 300000)) return current.value;
  const requestEpoch = epoch;
  current.inflight = (async () => {
    const store = (value: ClaudeUsage, retryAt = 0): ClaudeUsage => {
      if (cache !== current || epoch !== requestEpoch) return empty('loading');
      current.value = value;
      current.checkedAt = Date.now();
      current.retryAt = retryAt;
      return value;
    };
    const failed = (): ClaudeUsage => current.value?.updatedAt ? {...current.value, status: 'stale'} : empty('unavailable');
    let token: string | undefined;
    try {token = (await runtime.getAuth('anthropic'))?.auth?.apiKey;}
    catch {
      // Do not clear this failure state: visibility events, manual refreshes
      // and multiple open chats must not repeatedly trigger token refresh.
      return store(failed(), Date.now() + 300000);
    }
    if (cache !== current || epoch !== requestEpoch) return empty('loading');
    if (!token) return store(empty('disconnected'));
    const key = createHash('sha256').update(token).digest('hex');
    if (current.key !== key) {current.key = key;current.value = null;}
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
      value = failed();
    }
    return store(value, retryAt);
  })();
  try { return await current.inflight; }
  finally { current.inflight = null; }
}
