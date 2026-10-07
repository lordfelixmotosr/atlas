// @ts-nocheck
import * as electron from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rasterizeSvg } from '../agent/tools/lib/resvg-init';
import { readModPrefs } from '../agent/mod-prefs';
import { emitModChanged } from '../agent/mod-events';

/** Native dialogs and provider access stay in main; the renderer receives PNGs only. */
export function registerSpriteStudioRoutes(ctx, { runtime, jobs, busy, modRoot }) {
  const { ipc, host, getWindow, requireConsent } = ctx;
  const atlasRoot = process.env.ATLAS_ROOT;
  const store = new (require('./atlas/sprite-studio.cjs').SpriteStudio)({
    root: path.join(atlasRoot, 'data/profile/sprite-studio'), rasterize: rasterizeSvg,
  });
  const plans = new Map();
  const h = (name, fn) => ipc.handle('atlas:sprites:' + name, (_event, ...args) => fn(...args));
  const editable = id => {
    store.read(id);
    if (jobs.has(id)) throw new Error('Stop or finish this sprite generation before changing its recipe or approval.');
  };
  h('list', () => store.list());
  h('create', recipe => store.create(recipe));
  h('read', id => store.read(id));
  h('recipe', (id, recipe, version) => { editable(id); return store.saveRecipe(id, recipe, version); });
  h('approve', (id, candidate, directions, version) => { editable(id); return store.approve(id, candidate, directions, version); });
  h('import', async (id, direction, version) => {
    editable(id);
    if (!['reference', 'south', 'east', 'north'].includes(direction)) throw new Error('Choose a sprite direction or reference.');
    const selected = await electron.dialog.showOpenDialog(getWindow(), {
      title: direction === 'reference' ? 'Add a PNG style or identity reference' : 'Import ' + direction + ' sprite (PNG)',
      filters: [{ name: 'PNG images', extensions: ['png'] }], properties: ['openFile'],
    });
    if (selected.canceled) return null;
    editable(id);
    return store.importPng(id, direction, selected.filePaths[0], version);
  });
  h('reveal', async id => {
    store.read(id);
    const error = await electron.shell.openPath(store.projectDir(id));
    if (error) throw new Error(error);
  });
  const cancel = id => { store.read(id); jobs.get(id)?.abort(); };
  h('cancel', cancel);
  host.atlasSpriteTaskAction = (id, action) => {
    if (action !== 'cancel') throw new Error('Generate a new candidate from Sprite Studio to retry.');
    cancel(id);
  };
  h('generate', async request => {
    requireConsent();
    if (!request || typeof request !== 'object') throw new Error('Choose a sprite family first.');
    const id = request.projectId;
    editable(id);
    if (jobs.size) throw new Error('Finish or stop the current sprite generation first.');
    if (host.felixAccountOperation || host.pendingOAuth || host.atlasModImport) throw new Error('Finish sign-in or mod import before generating sprites.');
    const controller = new AbortController();
    jobs.set(id, controller);
    // Reserve before reading references, so switching accounts cannot race preparation.
    host.atlasSpriteJobs = jobs.size;
    const task = 'sprite:' + id;
    const timer = setTimeout(() => controller.abort(), 240000);
    runtime.tasks.update(task, { kind: 'sprite', projectId: id, title: 'Generate sprite family', status: 'running', phase: 'Preparing locked recipe and references', fraction: null, canRetry: false, restart: true }, 'Generating a candidate; approved artwork stays in place');
    try {
      const prepared = await store.prepareGeneration(id, request.directions, request.instruction, request.version);
      if (controller.signal.aborted) throw new Error('Sprite generation cancelled.');
      runtime.tasks.update(task, { phase: 'Designing directional layers with your model' }, 'Using the selected connected account');
      const result = await host.generateSpriteScenes({ ...prepared, directions: request.directions, instruction: request.instruction, model: request.model }, controller.signal);
      if (controller.signal.aborted) throw new Error('Sprite generation cancelled.');
      runtime.tasks.update(task, { phase: 'Validating artwork and rendering PNG frames' }, 'Checking safe geometry, canvas and palette; composing fixed-body frames');
      const project = await store.saveGeneration(id, result.response, result.model, request.directions, request.version, controller.signal);
      if (controller.signal.aborted) throw new Error('Sprite generation cancelled.');
      runtime.tasks.update(task, { status: 'completed', phase: 'Candidate ready for review', fraction: 1 }, 'Review directions and flight before approving or exporting');
      return project;
    } catch (error) {
      runtime.tasks.update(task, { status: controller.signal.aborted ? 'cancelled' : 'failed', phase: controller.signal.aborted ? 'Generation stopped' : 'Generation needs attention', fraction: null }, controller.signal.aborted ? 'No new candidate was approved or exported' : error.message);
      throw controller.signal.aborted ? new Error('Sprite generation stopped or timed out. Your approved artwork is preserved.') : error;
    } finally {
      clearTimeout(timer); jobs.delete(id); host.atlasSpriteJobs = jobs.size;
    }
  });
  h('export-plan', async (id, folder, version) => {
    editable(id);
    if (busy()) throw new Error('Finish active work before preparing a mod export.');
    const projectRoot = modRoot(folder);
    const prefs = await readModPrefs(folder);
    if (prefs.game && prefs.game !== 'rimworld') throw new Error('This export profile is for RimWorld.');
    const plan = await store.planExport(id, projectRoot, version);
    const token = randomUUID();
    plans.set(token, { plan, folder, id, version, createdAt: Date.now() });
    for (const [key, old] of plans) if (Date.now() - old.createdAt > 600000) plans.delete(key);
    return { token, rows: plan.rows, xml: plan.xml, warnings: plan.warnings };
  });
  h('export-apply', async token => {
    if (busy()) throw new Error('Finish active work before exporting sprites into a mod.');
    const item = plans.get(token);
    if (!item || Date.now() - item.createdAt > 600000) throw new Error('Preview this export again.');
    editable(item.id);
    if (store.read(item.id).version !== item.version) throw new Error('This sprite family changed. Preview the export again.');
    modRoot(item.folder);
    const task = 'sprite-export:' + token;
    runtime.tasks.update(task, { kind: 'sprite-export', title: 'Export approved sprites', status: 'running', phase: 'Checking files and creating backups', fraction: null, canRetry: false }, 'Applying the reviewed PNG file plan');
    host.atlasSpriteExport = true;
    try {
      const result = await store.applyExport(item.plan, path.join(atlasRoot, 'backups/sprite-exports'));
      plans.delete(token); emitModChanged(item.folder);
      runtime.tasks.update(task, { status: 'completed', phase: 'Approved PNGs exported', fraction: 1 }, 'XML is a suggested fragment; review it in the mod before testing in RimWorld');
      return result;
    } catch (error) {
      runtime.tasks.update(task, { status: 'failed', phase: 'Export needs attention' }, error.message);
      throw error;
    } finally { host.atlasSpriteExport = false; }
  });
  electron.app.on('before-quit', () => { for (const controller of jobs.values()) controller.abort(); });
  return store;
}
