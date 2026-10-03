import { app, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import type { RouteContext } from '../main/routes/context';
import { getWorkspacePaths } from '../agent/workspace';
import { emitModChanged } from '../agent/mod-events';
import { getRegistry } from '../agent/registry';
import {
  detectModMixerWorkspaces, resolveModMixerWorkspace, scanModMixerWorkspace,
  importModMixerBatch, type ModMixerImportPlan, type ModMixerImportProgress,
} from './modmixer-import';

export function registerModMixerImportRoutes(ctx: RouteContext, isBusy: () => boolean) {
  const plans = new Map<string, ModMixerImportPlan & { createdAt: number }>();
  let active: { token: string; cancelled: boolean } | null = null;
  let chosenSource: string | null = null;
  const publish = (state: ModMixerImportProgress) => {
    const win = ctx.getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('atlas:mods:import-progress', state);
  };
  ctx.ipc.handle('atlas:mods:import-plan', async (_event, choose = false): Promise<ModMixerImportPlan | null> => {
    if (active) throw new Error('A ModMixer import is already running.');
    const { workspaceDir } = getWorkspacePaths();
    const sources = await detectModMixerWorkspaces(app.getPath('appData'), workspaceDir);
    let source = chosenSource ? await resolveModMixerWorkspace(chosenSource, workspaceDir) : sources[0] ?? null;
    if (choose === true) {
      const win = ctx.getWindow();
      if (!win) return null;
      const selection = await dialog.showOpenDialog(win, {
        title: 'Choose the ModMixer profile or workspace',
        message: 'Choose the old ModMixer profile, portable folder, workspace, or workspace/Mods folder.',
        defaultPath: source ?? app.getPath('appData'),
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      source = await resolveModMixerWorkspace(selection.filePaths[0], workspaceDir);
      chosenSource = source;
    }
    if (source && !sources.includes(source)) sources.unshift(source);
    const plan = { token: randomUUID(), source, sources, rows: source ? await scanModMixerWorkspace(source, workspaceDir) : [] };
    for (const [token, previous] of plans) if (Date.now() - previous.createdAt > 600000) plans.delete(token);
    plans.set(plan.token, { ...plan, createdAt: Date.now() });
    if (plans.size > 8) plans.delete(plans.keys().next().value!);
    return plan;
  });
  ctx.ipc.handle('atlas:mods:import-apply', async (_event, token: string, selected: string[]) => {
    ctx.requireConsent();
    if (active || isBusy()) throw new Error('Finish active agent or account work before importing mods.');
    const plan = plans.get(token);
    if (!plan?.source || Date.now() - plan.createdAt > 600000) throw new Error('Refresh the import preview before continuing.');
    if (!Array.isArray(selected) || selected.some(x => typeof x !== 'string')) throw new Error('Invalid mod selection.');
    plans.delete(token);
    const operation = { token, cancelled: false };
    active = operation;
    // The shared Atlas busy check also blocks application replacement during a copy.
    (ctx.host as unknown as { atlasModImport: boolean }).atlasModImport = true;
    try {
      const result = await importModMixerBatch({
        source: plan.source, destination: getWorkspacePaths().workspaceDir,
        rows: plan.rows, token, selected, cancelled: () => operation.cancelled, progress: publish,
      });
      for (const mod of result.imported) emitModChanged(mod.folder);
      if (result.imported.length) await getRegistry().refresh().catch(error => console.error('Atlas import registry refresh:', error));
      return result;
    } finally {
      active = null;
      (ctx.host as unknown as { atlasModImport: boolean }).atlasModImport = false;
    }
  });
  ctx.ipc.handle('atlas:mods:import-cancel', (_event, token: string) => {
    if (active?.token === token) active.cancelled = true;
  });
}
