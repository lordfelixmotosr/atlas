type StreamActivity = {
  state: string;
  phase: string;
  requestStartedAt: number;
  lastEventAt: number | null;
  lastContentAt: number | null;
};
type Activity = {startedAt: number; lastEventAt: number; phase: string; stream?: StreamActivity | null};

export function activityPresentation(activity: Activity | null, now: number, compacting = false) {
  const seconds = (at: number) => Math.max(0, Math.floor((now - at) / 1000));
  const elapsed = activity ? seconds(activity.startedAt) : 0;
  const stream = activity?.stream;
  const streaming = !!stream && !['done', 'error', 'cancelled'].includes(stream.state);
  const since = streaming ? seconds(stream.lastEventAt ?? stream.requestStartedAt) : activity ? seconds(activity.lastEventAt) : 0;
  const phase = compacting ? 'Compacting context' : streaming && since >= 60 ? 'Waiting for response data' : activity?.phase || 'Starting request';
  const dataStatus = streaming
    ? stream.lastEventAt === null ? 'Waiting for first response' : since < 3 ? 'Response data just received' : `Last response data ${since}s ago`
    : since < 3 ? 'Activity just now' : `Last activity ${since}s ago`;
  let note = '';
  if (!compacting && streaming && since >= 60) {
    note = 'No new response data. The model may still be reasoning; this alone does not mean the connection is lost. You can wait or press Stop. A connection error will offer Retry.';
  } else if (since >= 30) {
    note = phase.startsWith('Running ') ? 'The tool is still running. You can steer the next step or stop it.'
      : compacting ? 'Compaction is still running. Your previous context stays in place until a complete summary is saved.'
      : phase === 'Waiting to retry' ? 'The provider asked Atlas to wait before retrying.'
      : 'Waiting for the model. High thinking levels and large context can take longer.';
  }
  return {phase, elapsed, since, dataStatus, note, waiting: streaming && (since >= 60 || ['connecting', 'waiting'].includes(stream.state))};
}
