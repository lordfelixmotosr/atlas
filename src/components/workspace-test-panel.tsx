import {useEffect, useState} from 'react';
import type {MonitorConnectionState} from '../agent/monitor/protocol';
import {MonitorView} from './monitor-view';

export function WorkspaceTestPanel() {
  const [connection, setConnection] = useState<MonitorConnectionState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let received = false;
    const off = window.modmixer.onMonitorState(value => {
      received = true;
      if (alive) setConnection(value);
    });
    window.modmixer.getMonitorState().then(value => {
      if (alive && !received) setConnection(value);
    }).catch(error => { if (alive) setError(String(error)); });
    return () => { alive = false; off(); };
  }, []);
  return <section className="atlas-test-panel">
    <div className="atlas-section-intro">
      <h2>Test in game</h2>
      <p>Use <strong>Test in RimWorld</strong> above to ask the assistant to build, refresh the runtime copy and launch an isolated test. Follow its progress in chat or Activity.</p>
      <p className="text-muted">Normal saves and your regular mod configuration stay separate. If a DLL is locked, close RimWorld before installing the update.</p>
    </div>
    <div className="atlas-test-monitor">
      {error && <p role="alert" className="atlas-warning">{error}</p>}
      {connection ? <MonitorView connection={connection}/> : !error && <p className="p-5 text-muted">Checking bridge status…</p>}
    </div>
  </section>;
}
