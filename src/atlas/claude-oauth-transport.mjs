// Claude's token endpoint can reset Node TLS connections on networks where
// Chromium succeeds. Keep this transport confined to token exchange/refresh.
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

export function createClaudeOAuthPostJson(request, timeoutMs = 30_000) {
  return async function postJson(url, body, signal) {
    if (url !== TOKEN_URL) throw new Error('Unexpected Claude token endpoint.');
    signal?.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const signingIn = body.grant_type === 'authorization_code';
    const action = signingIn ? 'sign-in' : 'session refresh';
    try {
      let response;
      let text;
      try {
        response = await request(url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Accept: 'application/json'},
          body: JSON.stringify(body),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: combined,
        });
        text = await response.text();
        combined.throwIfAborted();
      } catch {
        if (signal?.aborted) throw new DOMException('Claude sign-in cancelled.', 'AbortError');
        if (timeout.signal.aborted) {
          throw new Error(`Claude ${action} timed out. Check your connection and ${signingIn ? 'click Sign in to start a new attempt' : 'retry your request'}.`);
        }
        // Never replay a token POST: the server may have consumed its one-time
        // code or rotated a refresh token before the response was interrupted.
        throw new Error(`The connection to Claude was interrupted during ${action}. Check your connection and ${signingIn ? 'click Sign in to start a new attempt' : 'retry your request; sign in again if it still fails'}.`);
      }
      if (!response.ok) {
        if ([400, 401].includes(response.status)) {
          throw new Error('Claude could not accept this sign-in attempt. Click Sign in to get a fresh authorization code.');
        }
        if (response.status === 429) throw new Error('Claude is limiting sign-in requests. Wait a little, then try again.');
        throw new Error(`Claude ${action} failed (HTTP ${response.status}). Try again shortly.`);
      }
      // Error bodies and tokens must never be embedded in diagnostics.
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}

export const atlasClaudeOAuthPostJson = createClaudeOAuthPostJson(async (url, options) => {
  const {net} = await import('electron');
  return net.fetch(url, options);
});
