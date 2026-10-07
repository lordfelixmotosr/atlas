// Custom `modmixer-asset://` protocol — lets the renderer load mod-folder
// assets and chat image previews via
// <img src> instead of inlining base64 data URLs. Chromium then handles
// caching/decoding, which matters for the library list where the same
// preview can render in active+inactive columns and re-render frequently.
//
// Library URL: modmixer-asset://preview/<source>/<encoded-folder>
// Chat URL: modmixer-asset://chat/<encoded-folder>/<encoded-relative-path>
// Absolute URL: modmixer-asset://image/<encoded-absolute-path>
// Main validates both lexical and real paths against workspace / registry roots.

import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { getRegistry } from '../agent/registry/index.js';
import { getWorkspacePaths } from '../agent/workspace.js';
import { resolveAssetRequest } from './asset-paths.js';

const SCHEME = 'modmixer-asset';

/**
 * Register the privileged scheme. Must be called before `app.whenReady()`
 * so `<img src="modmixer-asset://...">` is permitted from the renderer.
 */
export function registerAssetSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        bypassCSP: false,
        stream: false,
      },
    },
  ]);
}

/**
 * Install the protocol handler. Must be called after `app.whenReady()`.
 */
export function installAssetProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    const studioRoot = process.env.ATLAS_ROOT ? path.join(process.env.ATLAS_ROOT, 'data/profile/sprite-studio') : undefined;
    const asset = await resolveAssetRequest(request.url, getWorkspacePaths().workspaceDir, getRegistry().getSnapshot().mods, studioRoot);
    if (!asset) return new Response(null, { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(asset.filePath).toString());
      // Keep existing library thumbnail caching; chat previews can be replaced
      // while a conversation is open, so those responses must not go stale.
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', asset.immutable ? 'public, max-age=31536000, immutable' : 'no-store');
      headers.set('Content-Type', asset.contentType);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch { return new Response(null, { status: 404 }); }
  });
}
