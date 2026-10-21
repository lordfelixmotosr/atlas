import path from 'node:path';
import {getWorkspaceMod,getWorkspacePaths,getRimWorldModsDir,unsyncModFromGame} from '../../agent/workspace.js';
import {isRimWorldRunning} from '../../agent/rimworld/game.js';
import {isBuildInProgress} from '../../agent/rimworld/build-state.js';
import {withRuntimeSync} from '../../agent/rimworld/runtime-mirror.js';
import {emitModChanged} from '../../agent/mod-events.js';
import {getRegistry} from '../../agent/registry/index.js';
import type {RouteContext} from './context.js';

export function registerModUninstallRoute(ctx: RouteContext): void {
  ctx.ipc.handle('modmixer:mods:unsync-from-game', async (_event, folder: string) => {
    ctx.requireConsent();
    if (!folder || folder==='.' || folder==='..' || /[\\/\x00:]/.test(folder)) throw new Error('Invalid mod folder.');
    const mod = await getWorkspaceMod(folder);
    if (!mod || mod.prefs.game!=='rimworld') throw new Error('Choose an existing RimWorld project.');
    const result = await withRuntimeSync(getRimWorldModsDir(), async () => {
      if(ctx.host.hasActiveWork())throw new Error('Wait for active agent work to finish before uninstalling.');
      if(isBuildInProgress(path.join(getWorkspacePaths().workspaceDir,folder)))throw new Error('Wait for the C# build to finish before uninstalling.');
      if(await isRimWorldRunning())throw new Error('Save and close RimWorld, then choose Uninstall from RimWorld again.');
      return unsyncModFromGame(folder);
    });
    emitModChanged(folder);
    // Refresh installed-file inventory only. Preserve normal ModsConfig.xml,
    // subscriptions, workspace projects, conversations and saved runtime history.
    try {await getRegistry().refresh();} catch(error) {console.warn('[uninstall] Registry refresh:',String(error));}
    return result;
  });
}
