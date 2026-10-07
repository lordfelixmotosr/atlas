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
  const core = require('./atlas/sprite-studio.cjs');
  const store = new core.SpriteStudio({
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
  h('create-master', async (recipe, mode = 'reference', slot) => {
    const normalized = core.validateRecipe(recipe);
    if (!['reference', 'slot'].includes(mode) || mode === 'slot' && !core.getSlots(normalized).includes(slot)) throw new Error('Choose a reference or a required asset view for the master artwork.');
    const selected = await electron.dialog.showOpenDialog(getWindow(), {
      title: 'Import master artwork into a new sprite family',
      filters: [{ name: 'PNG artwork', extensions: ['png'] }], properties: ['openFile'],
    });
    if (selected.canceled) return null;
    return store.importMaster(normalized, mode, selected.filePaths[0], slot);
  });
  h('read', id => store.read(id));
  h('archive', (id, archived, version) => { editable(id); return store.archive(id, archived, version); });
  h('delete', (id, version) => {
    editable(id); store.deleteProject(id, version);
    for (const [token, item] of plans) if (item.id === id) plans.delete(token);
  });
  h('recipe', (id, recipe, version) => { editable(id); return store.saveRecipe(id, recipe, version); });
  h('approve', (id, candidate, directions, version) => { editable(id); return store.approve(id, candidate, directions, version); });
  h('import', async (id, direction, version) => {
    editable(id);
    if (direction !== 'reference' && !core.getSlots(store.read(id).recipe).includes(direction)) throw new Error('Choose an asset view or reference for this family.');
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
    let timer;
    runtime.tasks.update(task, { kind: 'sprite', projectId: id, title: 'Design selected sprite views', status: 'running', phase: 'Preparing recipe and artwork references', fraction: null, spriteProgress: { stage: 'preparing', completed: 0, total: 0 }, canRetry: false, restart: true }, 'Generating a candidate; approved artwork stays in place');
    try {
      const prepared = await store.prepareGeneration(id, request.directions, request.instruction, request.version);
      if (controller.signal.aborted) throw new Error('Sprite generation cancelled.');
      const slots = core.validateDirections(request.directions, prepared.project.recipe);
      const batches = Array.from({length:Math.ceil(slots.length/4)},(_,index)=>slots.slice(index*4,index*4+4));
      const combined = {directions:{}}, modelNames = new Set();
      const label = slot => slot.replace(/_/g, ' · ').replace(/\b(south|east|north|west|item)\b/g, word => word[0].toUpperCase() + word.slice(1));
      for (let index=0;index<batches.length;index++) {
        const batch=batches[index];
        if (controller.signal.aborted) throw new Error('Sprite generation cancelled.');
        timer=setTimeout(()=>controller.abort(),240000);
        const chosen=prepared.approvedPaths.filter(file=>batch.some(slot=>path.basename(file)===slot+'-preview.png'));
        for(const file of prepared.approvedPaths) if(chosen.length<4&&!chosen.includes(file))chosen.push(file);
        runtime.tasks.update(task, { phase: `Designing ${batch.map(label).join(', ')} · model request ${index + 1} of ${batches.length}`, fraction: null, spriteProgress: { stage: 'designing', completed: index, total: batches.length } }, 'Using the selected connected account for '+batch.join(', '));
        const result=await host.generateSpriteScenes({...prepared,approvedPaths:chosen.slice(0,4),directions:batch,instruction:request.instruction,model:request.model},controller.signal);
        clearTimeout(timer);
        if(controller.signal.aborted)throw new Error('Sprite generation cancelled.');
        Object.assign(combined.directions,core.parseResponse(result.response,batch,prepared.project.recipe));
        modelNames.add(result.model);
        runtime.tasks.update(task, { phase: `Model request ${index + 1} of ${batches.length} validated`, fraction: null, spriteProgress: { stage: 'designing', completed: index + 1, total: batches.length } });
      }
      runtime.tasks.update(task, { phase: 'Validating artwork for PNG rendering', fraction: null }, 'Checking safe geometry and canvas; composing fixed-body frames');
      const project = await store.saveGeneration(id, combined, [...modelNames].join(', '), slots, request.version, controller.signal, progress => {
        const detail = progress.direction ? ` · ${label(progress.direction)} ${progress.frame == null ? 'preview' : 'flight frame ' + progress.frame}` : '';
        runtime.tasks.update(task, {
          phase: progress.stage === 'saving' ? 'Saving the completed revision' : `Rendering PNGs · ${progress.completed} of ${progress.total}${detail}`,
          fraction: progress.stage === 'rendering' && progress.total ? progress.completed / progress.total : null,
          spriteProgress: progress,
        });
      });
      if (controller.signal.aborted) throw new Error('Sprite generation cancelled.');
      const pngCount = slots.reduce((count, slot) => count + (prepared.project.recipe.kind === 'bird' && combined.directions[slot].wingNear && combined.directions[slot].wingFar ? 9 : 1), 0);
      runtime.tasks.update(task, { status: 'completed', phase: `${slots.length} selected ${slots.length === 1 ? 'view' : 'views'} ready for review`, fraction: 1, spriteProgress: { stage: 'complete', completed: pngCount, total: pngCount } }, 'Review directions and flight before approving or exporting');
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
