# Chat connection and activity behavior

Atlas 0.2.16 repairs misleading thinking status and the default Codex transport.

## What changes

`felixWithSpeed` selects SSE for Codex requests whose transport is missing or `auto`. An explicit transport is respected. Priority/default service still follows the Fast/Standard setting. Other providers and all reasoning, caching, account and token-limit options pass through unchanged. This changes only subsequent model requests after installing and restarting.

`felixGuardStream` reports connecting before calling the provider, waiting when it receives a start event, and reasoning/reply when it receives a nonempty corresponding delta. Tool argument streaming is distinguished from tool execution. The observer uses timestamps and state metadata; it neither copies chat content nor sends an IPC event per delta. Activity-list notifications happen on phase changes and use the existing throttle.

Status polling reads the latest metadata every three seconds when the visible chat is busy. It preserves the stream's own response-data timestamp. After 60 seconds without response data, the UI switches to a waiting notice. This is a notice, not proof of a failed connection or a cancellation timer. An empty assistant message says Waiting for response rather than Thinking.

Network-shaped provider errors get an actionable message. Other errors, including quota and authentication errors, keep their original meaning. Already received text and thinking are retained on stream exceptions; unfinished tool calls are excluded from synthetic failure messages. There is no added automatic retry. Retry continues from the last settled user/tool result and retains the failed assistant message in persisted history. Tools are not restarted automatically.

The existing ten-minute provider inactivity guard and app-level retry policy are unchanged. Stop propagates cancellation and settles the wrapper even if the provider never responds. Tools are outside that guard. A status observer failure cannot terminate a model request.

## Verification and limits

Local tests exercise both speeds against the bundled provider with a mocked HTTP response and a WebSocket trap, preserving supplied reasoning. They cover partial failures, source error events, cancellation, missing completion, silence, polling and phase transitions. Native Electron verification renders the real chat/progress components with production CSS and content policy, including a partial reply, explicit Retry, settled spinner and narrow layouts.

No real account request or paid model call is made by these checks. HTTP streaming can still fail, and provider reasoning time is not shortened by this repair. WebSocket continuation can have performance benefits on healthy connections; SSE is chosen here to address the observed disconnections. Monitor normal Atlas use after installation before claiming an improvement in end-to-end reply time.
