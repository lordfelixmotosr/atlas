import {useEffect, useRef, useState} from 'react';
import type {ClaudeUsage} from './claude-usage';

type Model = {provider?: string} | null;
const empty = (status: ClaudeUsage['status']): ClaudeUsage => ({status, windows: []});

export function ClaudeUsageControl({model}: {model: Model}) {
  const enabled = model?.provider === 'anthropic';
  const [usage, setUsage] = useState<ClaudeUsage>(empty('loading'));
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef<(force?: boolean) => void>(() => {});

  useEffect(() => {
    setUsage(empty('loading'));
    if (!enabled) return;
    let active = true;
    let requestId = 0;
    const refresh = async (force = false) => {
      const request = ++requestId;
      setRefreshing(true);
      try {
        const value = await window.modmixer.getClaudeUsage(force);
        if (active && request === requestId) setUsage(value);
      } catch {
        if (active && request === requestId)
          setUsage(previous => previous.updatedAt ? {...previous, status: 'stale'} : empty('unavailable'));
      } finally {
        if (active && request === requestId) setRefreshing(false);
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => {if (!document.hidden) void refresh();}, 300000);
    const visible = () => {if (!document.hidden) void refresh();};
    document.addEventListener('visibilitychange', visible);
    const unsubscribe = window.modmixer.onOAuthEvent(event => {
      if (event.type === 'links-changed' || event.providerId === 'anthropic') {
        requestId++;
        setUsage(empty('loading'));
        void refresh(true);
      }
    });
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      unsubscribe();
      refreshRef.current = () => {};
    };
  }, [enabled]);
  if (!enabled) return null;

  const now = Date.now();
  const windows = usage.windows.map(window => ({
    ...window,
    remaining: window.resetsAt && now >= window.resetsAt * 1000
      ? null : Math.max(0, Math.min(100, 100 - window.usedPercent)),
  }));
  const statusText: Record<ClaudeUsage['status'], string> = {
    loading: 'Claude usage loading…',
    ready: 'Claude usage unavailable',
    stale: 'Claude usage unavailable',
    unavailable: 'Claude usage unavailable',
    disconnected: 'Sign in to Claude for usage',
    'api-key': 'Claude plan usage needs Claude sign-in',
  };
  const description = windows.length
    ? windows.map(window => `${window.label} ${window.remaining === null ? 'awaiting refresh' : `${Math.round(window.remaining)}% left`}`).join(' · ')
    : statusText[usage.status];
  const tooltip = [
    'Claude plan usage (shared with Claude and Claude Code).',
    ...windows.map(window => `${window.label}: ${window.remaining === null ? 'reset time passed; refresh for current usage' : `${Math.round(window.remaining)}% remaining`}${window.resetsAt ? `; resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : ''}`),
    usage.status === 'api-key' ? 'API-key billing is separate from Claude plan limits.' : '',
    usage.status === 'stale' ? 'Refresh failed. Showing the last known usage.' : '',
    usage.status === 'unavailable' ? 'Claude did not provide plan usage. Try Claude Code /usage or Claude Settings > Usage.' : '',
    usage.updatedAt ? `Last updated ${new Date(usage.updatedAt).toLocaleTimeString()}` : '',
    'Refreshes at most every five minutes. Click to check again.',
  ].filter(Boolean).join('\n');

  return <button type="button" className="felix-usage" data-atlas-claude-usage=""
    onClick={() => refreshRef.current(true)} disabled={refreshing}
    aria-label={`Claude usage: ${description}`} aria-busy={refreshing} title={tooltip}>
    {windows.length ? windows.map(window => <span key={window.id}
      className={`felix-usage-item${window.remaining !== null && window.remaining <= 10 ? ' felix-usage-low' : ''}`}>
      <span className="felix-status-label">{window.label}</span>
      <strong>{window.remaining === null ? '—' : `${Math.round(window.remaining)}% left`}</strong>
    </span>) : <span className="felix-status-label">{statusText[usage.status]}</span>}
    {usage.status === 'stale' && <span className="felix-usage-stale">Stale</span>}
    <svg aria-hidden="true" className="felix-usage-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" />
    </svg>
  </button>;
}
