import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {DEFAULT_SUBAGENT_SETTINGS, type SubagentChange, type SubagentSettings, type SubagentSnapshot, type SubagentTask} from './subagents-types';
import './subagents.css';

type SettingsState = {settings: SubagentSettings; loaded: boolean; busy: boolean; error: string | null};
let settingsState: SettingsState = {settings: DEFAULT_SUBAGENT_SETTINGS, loaded: false, busy: false, error: null};
let settingsRequest: Promise<void> | null = null;
let settingsRevision = 0;
const settingsListeners = new Set<() => void>();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const publishSettings = (patch: Partial<SettingsState>) => {
  settingsState = {...settingsState, ...patch};
  settingsListeners.forEach(listener => listener());
};
const receiveSettings = (settings: SubagentSettings) => {
  settingsRevision++;
  publishSettings({settings, loaded: true, error: null});
};
const subscribeSettings = (listener: () => void) => {
  settingsListeners.add(listener);
  return () => {settingsListeners.delete(listener);};
};

async function loadSettings() {
  if (settingsState.loaded || settingsRequest) return settingsRequest;
  const revision = settingsRevision;
  publishSettings({error: null});
  settingsRequest = window.modmixer.getSettings().then(value => {
    if (revision === settingsRevision) receiveSettings(value.subagents ?? DEFAULT_SUBAGENT_SETTINGS);
  }).catch(error => {
    if (revision === settingsRevision) publishSettings({error: message(error)});
  }).finally(() => {settingsRequest = null;});
  return settingsRequest;
}

async function updateSettings(patch: Partial<SubagentSettings>) {
  // One in-flight save keeps settings and every composer in sync.
  if (settingsState.busy || !settingsState.loaded) return;
  settingsRevision++;
  publishSettings({busy: true, error: null});
  try {
    receiveSettings(await window.modmixer.setSubagentSettings(patch));
  } catch (error) {
    publishSettings({error: message(error)});
  } finally {
    publishSettings({busy: false});
  }
}

function useHelperSettings() {
  const state = useSyncExternalStore(subscribeSettings, () => settingsState, () => settingsState);
  useEffect(() => {void loadSettings();}, []);
  return state;
}

function modeLabel(settings: SubagentSettings) {
  return settings.enabled ? settings.mode === 'match' ? 'Match main' : 'Efficient' : 'Off';
}

export function SubagentSettingsFields({settings, disabled, onChange}: {
  settings: SubagentSettings;
  disabled: boolean;
  onChange: (patch: Partial<SubagentSettings>) => void;
}) {
  return <div className="atlas-helper-settings-fields">
    <div className="atlas-helper-settings-inputs">
      <label>Helper mode
        <select aria-label="Helper mode" value={settings.enabled ? settings.mode : 'off'} disabled={disabled}
          onChange={event => onChange(event.target.value === 'off' ? {enabled: false}
            : {enabled: true, mode: event.target.value as SubagentSettings['mode']})}>
          <option value="off">Off</option><option value="efficient">Efficient</option><option value="match">Match main</option>
        </select>
      </label>
      <label>Maximum helpers
        <select aria-label="Maximum helpers" value={settings.maxHelpers} disabled={disabled || !settings.enabled}
          onChange={event => onChange({maxHelpers: Number(event.target.value)})}>
          {Array.from({length: 8}, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
        </select>
      </label>
    </div>
    <p className="atlas-helper-hint">
      {!settings.enabled ? 'Helpers are off.' : settings.mode === 'efficient'
        ? 'Routine research uses a lighter available model. Implementation and reviews keep your main model.'
        : 'Helpers use the main chat’s model and thinking level.'}
      {' '}Your main chat’s thinking stays unchanged.
    </p>
    <p className="atlas-helper-hint">Turning helpers off stops active helpers.</p>
  </div>;
}

export function SubagentSettingsControl() {
  const state = useHelperSettings();
  return <section className="atlas-helper-settings" aria-label="Helper settings">
    <h3>Helpers</h3>
    <p className="atlas-helper-hint">Let Atlas delegate independent tasks. These settings apply across chats.</p>
    <SubagentSettingsFields settings={state.settings} disabled={!state.loaded || state.busy} onChange={patch => {void updateSettings(patch);}} />
    {state.error && <p className="atlas-helper-error" role="alert">{state.error}
      {!state.loaded && <button type="button" onClick={() => {void loadSettings();}}>Reload settings</button>}
    </p>}
  </section>;
}

type TaskAction = 'cancel' | 'retry' | 'steer' | 'extend' | 'review' | 'apply';
type PatchReview = {changes: SubagentChange[]; diff: string; truncated?: boolean};
type RunTaskAction = (task: SubagentTask, action: TaskAction, text?: string) => Promise<PatchReview | void>;

function remainingTime(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s left`;
}

export function SubagentTaskRow({task, onAction}: {task: SubagentTask; onAction: RunTaskAction}) {
  const [pending, setPending] = useState<TaskAction | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [steering, setSteering] = useState('');
  const [notice, setNotice] = useState('');
  const [review, setReview] = useState<PatchReview | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const active = task.status === 'running' || task.status === 'queued';
  const continuingPartial = !!task.applied && !!task.partialPatch;
  const retryable = task.status === 'failed' || task.status === 'interrupted' || task.status === 'cancelled' && continuingPartial;
  const deadline = Number.isFinite(task.deadlineAt) ? task.deadlineAt : undefined;
  useEffect(() => {
    setNow(Date.now());
    if (task.status !== 'running' || deadline === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.id, task.status, deadline]);
  useEffect(() => {setReview(null);}, [task.id, task.status, task.stagingPath, task.applied]);
  const timeExpired = deadline !== undefined && now >= deadline;
  const stopping = task.status === 'running' && (!!task.stopReason || timeExpired);
  const canExtend = task.status === 'running' && !stopping && deadline !== undefined
    && Number.isFinite(task.maxDeadlineAt) && deadline < task.maxDeadlineAt!;
  const run = async (action: TaskAction) => {
    if (pendingRef.current || (action === 'steer' && !steering.trim())) return;
    if (action === 'extend' && !canExtend || action === 'apply' && (!review || review.truncated)) return;
    pendingRef.current = true;
    setPending(action);
    setError(null);
    setNotice('');
    try {
      const result = await onAction(task, action, action === 'steer' ? steering.trim() : undefined);
      if (action === 'steer') {setSteering(''); setNotice('Instruction sent to this helper.');}
      if (action === 'extend') setNotice('Helper time extended. Your thinking settings are unchanged.');
      if (action === 'review') {
        if (!result || !Array.isArray(result.changes) || typeof result.diff !== 'string') throw Error('Saved work could not be reviewed. Its staging folder has been retained.');
        setReview({changes: result.changes, diff: result.diff.slice(0, 128 * 1024),
          truncated: !!result.truncated || result.diff.length > 128 * 1024 || /\[Diff truncated\b/.test(result.diff)});
      }
      if (action === 'apply' || action === 'cancel') setReview(null);
      if (action === 'apply') setNotice('Reviewed files applied. Ask the lead to finish and validate the work.');
    } catch (err) {
      if (action === 'review' || action === 'apply') setReview(null);
      setError(message(err));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };
  const changedFiles = task.changes?.length ?? 0;
  const recoverable = task.kind === 'implement' && ['failed', 'interrupted', 'cancelled'].includes(task.status)
    && !task.applied && !/^Patch (?:discarded|retired)/.test(task.phase) && (!!task.stagingPath || !!task.partialPatch);
  const discardable = recoverable || task.kind === 'implement' && task.status === 'completed' && changedFiles > 0 && !task.applied;
  const activityDate = new Date(task.lastActivityAt);
  return <li className="atlas-helper-task" data-helper-status={task.status}>
    <div className="atlas-helper-task-heading">
      <strong>{task.title}</strong>
      <span className="atlas-helper-role">{task.kind === 'implement' ? 'Implementation' : task.kind === 'review' ? 'Review' : 'Research'}</span>
    </div>
    <div className="atlas-helper-task-status">
      <span className={`atlas-helper-phase atlas-helper-phase-${task.status}`}>{task.phase || task.status}</span>
      <time dateTime={activityDate.toISOString()} title={activityDate.toLocaleString()}>
        Last activity {activityDate.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}
      </time>
    </div>
    <p className="atlas-helper-model"><span title={task.model.key}>{task.model.label}</span> · {task.model.thinkingLevel} thinking</p>
    <p className="atlas-helper-hint">{task.model.routingReason}</p>
    {task.status === 'running' && deadline !== undefined && <div className="atlas-helper-time-budget">
      <span className={stopping ? 'atlas-helper-error' : ''}>{stopping ? task.stopReason === 'cancelled' ? 'Stopping helper…' : 'Time limit reached; stopping…' : remainingTime(deadline - now)}</span>
      <button type="button" disabled={pending !== null || !canExtend} onClick={() => {void run('extend');}}
        title={stopping ? 'This helper is stopping.' : canExtend ? 'Add 15 minutes, up to two hours total.' : 'This helper has reached its two-hour maximum.'}>
        {pending === 'extend' ? 'Extending…' : 'Extend 15 min'}
      </button>
    </div>}
    {task.usage && <p className="atlas-helper-usage">Tokens: {task.usage.input.toLocaleString()} in · {task.usage.output.toLocaleString()} out</p>}
    {task.summary && <p className="atlas-helper-result">{task.summary}</p>}
    {changedFiles > 0 && <p className="atlas-helper-hint">{changedFiles} file{changedFiles === 1 ? '' : 's'} changed · {task.applied ? 'Integrated' : ['cancelled', 'failed', 'interrupted'].includes(task.status) ? 'Not integrated' : 'Pending lead review and integration'}</p>}
    {task.error && <p className="atlas-helper-error">{task.error}</p>}
    {task.patchError && <p className="atlas-helper-error">{task.patchError}</p>}
    {recoverable && <p className="atlas-helper-hint">Partial work is saved separately. It may be incomplete and has not been applied.</p>}
    {(active || retryable || discardable) && <details className="atlas-helper-task-actions">
      <summary>Actions</summary>
      <div className="atlas-helper-actions-body">
        {active && <form onSubmit={event => {event.preventDefault(); void run('steer');}}>
          <label>Instruction for this helper
            <textarea value={steering} onChange={event => setSteering(event.target.value)}
              placeholder="Clarify or redirect this task…" rows={2} maxLength={8000} disabled={pending !== null} />
          </label>
          <div className="atlas-helper-action-buttons">
            <button type="submit" disabled={pending !== null || !steering.trim()}>{pending === 'steer' ? 'Sending…' : 'Send instruction'}</button>
            <button type="button" disabled={pending !== null} onClick={() => {void run('cancel');}}>{pending === 'cancel' ? 'Cancelling…' : 'Cancel helper'}</button>
          </div>
        </form>}
        {retryable && <button type="button" disabled={pending !== null} onClick={() => {void run('retry');}}>{pending === 'retry' ? continuingPartial ? 'Continuing…' : 'Retrying…' : continuingPartial ? 'Continue remaining work' : 'Retry helper'}</button>}
        {recoverable && <button type="button" disabled={pending !== null} onClick={() => {void run('review');}}>{pending === 'review' ? 'Reviewing…' : 'Review saved work'}</button>}
        {discardable && <button type="button" disabled={pending !== null} onClick={() => {void run('cancel');}}>{pending === 'cancel' ? 'Discarding…' : recoverable ? 'Discard saved work' : 'Discard patch'}</button>}
        {recoverable && task.stagingPath && <p className="atlas-helper-hint atlas-helper-staging-path">Saved at {task.stagingPath}</p>}
        {review && <section className="atlas-helper-patch-review" aria-label="Saved helper patch review">
          <p className="atlas-helper-hint">This is an unfinished helper patch. Review the changes before applying them. The lead must finish the task and run validation.</p>
          <p className="atlas-helper-hint">{review.changes.length} file{review.changes.length === 1 ? '' : 's'} in saved work.</p>
          <pre>{review.diff || 'No file changes were saved.'}</pre>
          {review.truncated ? <p className="atlas-helper-hint" role="note">This preview is truncated. Ask the lead to review the saved patch in pages before applying it.</p>
            : <button type="button" disabled={pending !== null || review.changes.length === 0} onClick={() => {void run('apply');}}>{pending === 'apply' ? 'Applying…' : 'Apply reviewed partial patch'}</button>}
        </section>}
      </div>
    </details>}
    {error && <p className="atlas-helper-error" role="alert">{error}</p>}
    {notice && <p className="atlas-helper-hint" role="status">{notice}</p>}
  </li>;
}

export function SubagentsControl({conversationId}: {conversationId: string}) {
  const state = useHelperSettings();
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<SubagentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true;
    let revision = 0;
    setSnapshot(null);
    setLoading(true);
    setError(null);
    const receive = (value: SubagentSnapshot) => {
      if (!alive || !value) return;
      receiveSettings(value.settings);
      if (value.conversationId !== conversationId) return;
      revision++;
      setSnapshot(value);
      setLoading(false);
      setError(null);
    };
    const refresh = async () => {
      const request = ++revision;
      try {
        const value = await window.modmixer.getSubagents(conversationId);
        if (alive && request === revision) receive(value);
      } catch (err) {
        if (alive && request === revision) setError(message(err));
      } finally {
        if (alive && request <= revision) setLoading(false);
      }
    };
    refreshRef.current = refresh;
    const unsubscribe = window.modmixer.onSubagentsChanged(receive);
    void refresh();
    return () => {alive = false; unsubscribe(); refreshRef.current = async () => {};};
  }, [conversationId]);
  const tasks = snapshot?.conversationId === conversationId ? snapshot.tasks : [];
  const activeCount = tasks.filter(task => task.status === 'running').length;
  const queuedCount = tasks.filter(task => task.status === 'queued').length;
  const completedCount = tasks.filter(task => task.status === 'completed').length;
  const attentionCount = tasks.filter(task => task.status === 'failed' || task.status === 'interrupted').length;
  const action: RunTaskAction = async (task, kind, text) => {
    if (kind === 'review') {
      const reviewed = await window.modmixer.reviewSubagentPatch(conversationId, task.id);
      if (typeof reviewed.diff !== 'string') throw Error('The saved patch preview is unavailable. Its staging folder has been retained.');
      return {changes: reviewed.changes, diff: reviewed.diff};
    }
    if (kind === 'cancel') await window.modmixer.cancelSubagent(conversationId, task.id);
    else if (kind === 'retry') await window.modmixer.retrySubagent(conversationId, task.id);
    else if (kind === 'extend') await window.modmixer.extendSubagent(conversationId, task.id);
    else if (kind === 'apply') await window.modmixer.applySubagentPatch(conversationId, task.id);
    else await window.modmixer.steerSubagent(conversationId, task.id, text ?? '');
    await refreshRef.current();
  };
  return <section className="atlas-helpers" aria-label="Chat helpers" data-atlas-helpers="">
    <button type="button" className="atlas-helpers-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="atlas-helpers-label"><span className="atlas-helpers-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span><strong>Helpers</strong></span>
      <span>{modeLabel(state.settings)}{state.settings.enabled ? ` · Up to ${state.settings.maxHelpers}` : ''}</span>
      <span className="atlas-helpers-counts">{activeCount} active · {queuedCount} queued · {completedCount} completed</span>
      {attentionCount > 0 && <span className="atlas-helper-error">{attentionCount} need attention</span>}
      {(error || state.error) && <span className="atlas-helper-error">Unavailable</span>}
    </button>
    {expanded && <div className="atlas-helpers-body">
      <SubagentSettingsFields settings={state.settings} disabled={!state.loaded || state.busy} onChange={patch => {void updateSettings(patch);}} />
      {state.error && <p className="atlas-helper-error" role="alert">{state.error}
        {!state.loaded && <button type="button" onClick={() => {void loadSettings();}}>Reload settings</button>}
      </p>}
      {error && <p className="atlas-helper-error" role="alert">{error} <button type="button" onClick={() => {void refreshRef.current();}}>Reload helpers</button></p>}
      {tasks.length > 0 ? <ul className="atlas-helper-tasks">{tasks.map(task => <SubagentTaskRow key={task.id} task={task} onAction={action} />)}</ul>
        : <p className="atlas-helper-empty">{loading ? 'Loading helpers…' : 'No helper tasks in this chat yet.'}</p>}
    </div>}
  </section>;
}
