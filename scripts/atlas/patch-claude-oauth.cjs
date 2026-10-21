'use strict';
const fs = require('node:fs');
const path = require('node:path');
const marker = '// Atlas Claude OAuth transport v1';

// Fail closed when the dependency changes, instead of applying a partial patch.
function patchClaudeOAuth(input) {
  if (input.startsWith(marker + '\n')) return input;
  let source = input.replace(/\r\n/g, '\n');
  function once(before, after) {
    if (source.split(before).length !== 2) throw new Error('Claude OAuth dependency changed: ' + before.slice(0, 75));
    source = source.replace(before, after);
  }
  const start = source.indexOf('async function postJson(url, body) {');
  const end = source.indexOf('async function exchangeAuthorizationCode(', start);
  if (start < 0 || end < start) throw new Error('Claude OAuth postJson boundary changed.');
  source = source.slice(0, start) + 'async function postJson(url, body, signal) {\n    return atlasClaudeOAuthPostJson(url, body, signal);\n}\n' + source.slice(end);
  once('async function exchangeAuthorizationCode(code, state, verifier, redirectUri)', 'async function exchangeAuthorizationCode(code, state, verifier, redirectUri, signal)');
  once('code_verifier: verifier,\n        });', 'code_verifier: verifier,\n        }, signal);');
  once('return exchangeAuthorizationCode(code, state, verifier, REDIRECT_URI);', 'interaction.signal?.throwIfAborted();\n        return await exchangeAuthorizationCode(code, state, verifier, REDIRECT_URI, interaction.signal);');
  once('interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });', 'manualAbort.abort();\n        interaction.notify({ type: "progress", message: "Finishing Claude sign-in..." });');
  once('async function refreshAnthropicToken(refreshToken)', 'async function refreshAnthropicToken(refreshToken, signal)');
  once('refresh_token: refreshToken,\n        });', 'refresh_token: refreshToken,\n        }, signal);');
  once('refresh: (credential) => refreshAnthropicToken(credential.refresh)', 'refresh: (credential, signal) => refreshAnthropicToken(credential.refresh, signal)');
  once('throw new Error(`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`);', 'throw error;');
  once('throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);', 'throw error;');
  once('throw new Error(`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`);', 'throw new Error("Claude returned an unreadable sign-in response. Click Sign in to start a new attempt.");');
  once('throw new Error(`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`);', 'throw new Error("Claude returned an unreadable session refresh response. Please sign in again.");');
  // The callback acknowledges receipt of a code, before the exchange succeeds.
  once('oauthSuccessHtml("Anthropic authentication completed. You can close this window.")', 'oauthSuccessHtml("Authorization received. Return to Atlas to finish signing in.")');
  return marker + '\nimport { atlasClaudeOAuthPostJson } from "./atlas-claude-oauth-transport.js";\n' + source;
}

function installClaudeOAuthPatch(directory) {
  const target = path.join(directory, 'anthropic.js');
  const result = patchClaudeOAuth(fs.readFileSync(target, 'utf8'));
  const transport = fs.readFileSync(path.join(__dirname, '../../src/atlas/claude-oauth-transport.mjs'));
  fs.writeFileSync(path.join(directory, 'atlas-claude-oauth-transport.js'), transport);
  fs.writeFileSync(target, result);
}

module.exports = {patchClaudeOAuth, installClaudeOAuthPatch};
if (require.main === module) {
  const directory = process.argv[2] || path.join(__dirname, '../../node_modules/@earendil-works/pi-ai/dist/auth/oauth');
  installClaudeOAuthPatch(directory);
}
