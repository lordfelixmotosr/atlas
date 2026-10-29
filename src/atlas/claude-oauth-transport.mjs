// Claude's token endpoint can reset Node TLS connections on networks where
// Chromium succeeds. Keep this transport confined to token exchange/refresh.
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
import oauthState from './claude-oauth-state.cjs';

export function createClaudeOAuthPostJson(request, timeoutMs = 30_000, {state=oauthState.createOAuthState(),now=Date.now}={}) {
  let active=false;
  return async function postJson(url, body, signal) {
    if (url !== TOKEN_URL) throw new Error('Unexpected Claude token endpoint.');
    signal?.throwIfAborted();
    const cooldown=state.read();
    if(cooldown.retryAt>now())throw Object.assign(new Error(oauthState.cooldownMessage(cooldown)),{retryAt:cooldown.retryAt,retrySource:cooldown.retrySource});
    if(active)throw new Error('Another Claude authentication request is still finishing. Wait for it before trying again.');
    active=true;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const signingIn = body.grant_type === 'authorization_code';
    const action = signingIn ? 'sign-in' : 'session refresh';
    try {
      let response;
      let text;
      let limited;
      let diagnostic;
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
        const contentType=response.headers?.get('content-type')??'';
        diagnostic={status:response.status,requestId:response.headers?.get('request-id')??response.headers?.get('x-request-id'),responseKind:contentType.includes('json')?'json':contentType.includes('html')?'html':'other',at:now()};
        // The server's wait applies even if its response body is interrupted.
        if(response.status===429)limited=state.rateLimit(response.headers?.get('retry-after'),diagnostic);
        text = await response.text();
        combined.throwIfAborted();
      } catch {
        if (signal?.aborted) throw new DOMException('Claude sign-in cancelled.', 'AbortError');
        if(limited)throw Object.assign(new Error(oauthState.cooldownMessage(limited)),{retryAt:limited.retryAt,retrySource:limited.retrySource});
        if (timeout.signal.aborted) {
          throw new Error(`Claude ${action} timed out. Check your connection and ${signingIn ? 'click Sign in to start a new attempt' : 'retry your request'}.`);
        }
        // Never replay a token POST: the server may have consumed its one-time
        // code or rotated a refresh token before the response was interrupted.
        throw new Error(`The connection to Claude was interrupted during ${action}. Check your connection and ${signingIn ? 'click Sign in to start a new attempt' : 'retry your request; sign in again if it still fails'}.`);
      }
      let errorType;
      if(!response.ok&&text.length<8192){try{const parsed=JSON.parse(text);const value=parsed?.error?.type??parsed?.error;if(typeof value==='string'&&/^[a-z_]{1,80}$/.test(value))errorType=value;}catch{/* HTML/gateway responses have no structured provider error. */}}
      diagnostic={...diagnostic,errorType};
      if (!response.ok) {
        if (response.status === 429) {
          state.noteResponse(diagnostic);limited=state.read();
          const details=[limited.diagnostic?.errorType,limited.diagnostic?.requestId?`request ${limited.diagnostic.requestId}`:null,limited.diagnostic?.responseKind==='html'?'HTML response':null].filter(Boolean).join('; ');
          throw Object.assign(new Error(oauthState.cooldownMessage(limited)+(details?` Details: ${details}.`:'')),{retryAt:limited.retryAt,retrySource:limited.retrySource});
        }
        state.noteResponse(diagnostic);
        if ([400, 401].includes(response.status)) {
          throw new Error(`Claude could not accept this ${action} (HTTP ${response.status}${errorType?`; ${errorType}`:''}). Click Sign in to get a fresh authorization code.`);
        }
        throw new Error(`Claude ${action} failed (HTTP ${response.status}). Try again shortly.`);
      }
      state.noteResponse(diagnostic);state.clear();
      // Error bodies and tokens must never be embedded in diagnostics.
      return text;
    } finally {
      clearTimeout(timer);
      active=false;
    }
  };
}

export const atlasClaudeOAuthPostJson = createClaudeOAuthPostJson(async (url, options) => {
  const {net} = await import('electron');
  return net.fetch(url, options);
}, 30_000, {state:oauthState});
