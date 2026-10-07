import {useEffect, useRef, useState} from 'react';
import {reconcileAgent} from '../conversations-store';
import {activityPresentation} from './activity-state';

type Progress = ReturnType<typeof activityPresentation> & {error?: string};
export function TaskActivityDisplay({phase, elapsed, dataStatus, note, waiting, error = ''}: Progress) {
  return <section className="atlas-activity" aria-label="Agent progress">
    <span className="atlas-status-dot"/>
    <div className="atlas-activity-content">
      <strong role="status">{phase}</strong>
      <p>{error || `${elapsed >= 60 ? Math.floor(elapsed / 60) + 'm ' : ''}${elapsed % 60}s elapsed · ${dataStatus}`}</p>
      <div className="atlas-task-progress" role="progressbar" aria-label="Task progress" aria-valuetext={error || phase}
        data-state={waiting || error || phase === 'Waiting to retry' ? 'waiting' : 'working'}
        title="The task has no known total. This bar shows activity, not a completion percentage."><span/></div>
      {note && <p>{note}</p>}
    </div>
  </section>;
}

export function AgentActivity({conversationId, busy, compacting}: {conversationId: string; busy: boolean; compacting: boolean}) {
  const [status, setStatus] = useState<any>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => {setStatus(null); setError(''); setNow(Date.now());}, [conversationId]);
  useEffect(() => {
    let alive = true, pending = false;
    const off = window.modmixer.onEvent(env => {if (env.conversationId === conversationId) revision.current++;});
    const check = async () => {
      if (pending || document.hidden) return;
      pending = true;
      const before = revision.current;
      try {
        const value = await window.modmixer.getAgentStatus(conversationId, true);
        if (alive && before === revision.current) {
          setStatus(value); setNow(Date.now()); reconcileAgent(conversationId, value); setError('');
        }
      } catch {
        if (alive && before === revision.current) setError('Activity status unavailable.');
      } finally {pending = false;}
    };
    void check();
    const visible = () => {if (!document.hidden) {setNow(Date.now()); void check();}};
    document.addEventListener('visibilitychange', visible);
    const timer = busy || compacting ? setInterval(() => {if (!document.hidden) {setNow(Date.now()); void check();}}, 3000) : undefined;
    return () => {alive = false; clearInterval(timer); off(); document.removeEventListener('visibilitychange', visible);};
  }, [conversationId, busy, compacting]);
  if (!busy && !compacting) return null;
  return <TaskActivityDisplay {...activityPresentation(status?.activity ?? null, now, compacting)} error={error}/>;
}
