const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');
const realCore = require('../src/atlas/sprite-studio.cjs');
const profileModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/atlas/sprite-profiles.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: profileModule.exports, module: profileModule });
const responseFor = directions => JSON.stringify({ directions: Object.fromEntries(directions.map(slot => [slot, { body: { svg: '<rect x="30" y="30" width="50" height="50" fill="#f1e9d0"/>' } }])) });

const source = fs.readFileSync(path.resolve(__dirname, '../src/atlas/sprite-studio-routes.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const handlers = new Map(), jobs = new Map(), events = [], taskUpdates = [], writes = [], timers = new Map();
  let now = 1000000, token = 0, consent = 0, busy = false;
  const project = { id: 'family-id', version: 4, recipe: { name: 'Fixture family', kind: 'bird', brief: 'Fixture art', palette: ['#f1e9d0', '#414c39'], canvasSize: 128, frameCount: 8, ticksPerFrame: 2, drawSize: 1.5, groundedDrawSize: 0.7, textureName: 'FixtureFamily' }, approved: {} };
  let deleted = false;
  class Store {
    constructor(options) { this.options = options; }
    read(id) { if (deleted || id !== project.id) throw new Error('Unknown sprite project'); return project; }
    list() { return [project]; }
    create(recipe) { return { recipe }; }
    saveRecipe(id, recipe, version) { this.checkVersion(id, version); return { ...project, recipe }; }
    approve(id, _candidate, _directions, version) { this.checkVersion(id, version); return project; }
    importPng(id, _direction, _source, version) { this.checkVersion(id, version); return project; }
    importMaster(recipe, mode, source, slot) { writes.push({ master: { recipe, mode, source, slot } }); return { ...project, recipe }; }
    archive(id, archived, version) { this.checkVersion(id, version); project.archived = archived; project.version++; return project; }
    deleteProject(id, version) { this.checkVersion(id, version); deleted = true; writes.push('deleted'); }
    projectDir(id) { this.read(id); return path.join('fixture', id); }
    checkVersion(id, version) { this.read(id); if (version !== project.version) throw new Error('Sprite project changed; reload'); }
    async prepareGeneration(id, _directions, _instruction, version) { this.checkVersion(id, version); return { project, referencePaths: [], approvedPaths: [] }; }
    async saveGeneration(id, _response, _model, _directions, version, signal) {
      this.checkVersion(id, version); if (signal.aborted) throw new Error('cancelled'); writes.push('candidate'); return { ...project, version: 5 };
    }
    async planExport(id, projectRoot, version) { this.checkVersion(id, version); return { projectRoot, rows: [{ path: 'Textures/Bird.png', bytes: 100, action: 'create' }], xml: '<PawnKindDef/>', warnings: [] }; }
    async applyExport(plan, backup) { writes.push({ plan, backup }); return { files: 1, backup: null }; }
  }
  const host = { generateSpriteScenes: async args => ({ response: responseFor(args.directions), model: 'Fixture model' }) };
  const electron = {
    app: { on: (name, fn) => events.push({ name, fn }) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['fixture.png'] }) },
    shell: { openPath: async () => '' },
  };
  const moduleFixture = { exports: {} };
  const fakeDate = { now: () => now };
  vm.runInNewContext(compiled, {
    exports: moduleFixture.exports, module: moduleFixture, process: { env: { ATLAS_ROOT: 'C:/owned/Atlas' } },
    AbortController, Date: fakeDate, Map,
    setTimeout: fn => { const id = ++token; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => {
      if (name === 'electron') return electron;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { randomUUID: () => 'plan-token-' + ++token };
      if (name.endsWith('resvg-init')) return { rasterizeSvg: () => { throw new Error('unexpected rasterizer call'); } };
      if (name.endsWith('mod-prefs')) return { readModPrefs: async () => ({ game: 'rimworld' }) };
      if (name.endsWith('mod-events')) return { emitModChanged: folder => events.push({ changed: folder }) };
      if (name.endsWith('sprite-studio.cjs')) return {
        SpriteStudio: Store, validateRecipe: realCore.validateRecipe, getSlots: profileModule.exports.getSpriteSlots,
        validateDirections: (slots, recipe) => {
          const allowed = profileModule.exports.getSpriteSlots(recipe);
          if (!Array.isArray(slots) || !slots.length || new Set(slots).size !== slots.length || slots.some(slot => !allowed.includes(slot))) throw new Error('Invalid sprite slots');
          return allowed.filter(slot => slots.includes(slot));
        }, parseResponse: realCore.parseResponse,
      };
      throw new Error('Unexpected dependency: ' + name);
    },
  });
  const store = moduleFixture.exports.registerSpriteStudioRoutes({
    ipc: { handle: (name, fn) => handlers.set(name, fn) }, host, getWindow: () => ({}), requireConsent: () => consent++,
  }, {
    runtime: { tasks: { update: (...args) => taskUpdates.push(args) } }, jobs,
    busy: () => busy || jobs.size > 0 || host.atlasSpriteExport,
    modRoot: folder => { if (folder !== 'OwnedMod') throw new Error('Unknown mod'); return 'C:/owned/Mods/OwnedMod'; },
  });
  const call = (name, ...args) => handlers.get('atlas:sprites:' + name)({}, ...args);
  const request = { projectId: project.id, version: project.version, directions: ['south', 'east', 'north'], instruction: '', model: null };
  return { host, store, jobs, call, request, project, events, taskUpdates, writes, timers, electron,
    setNow: value => { now = value; }, setBusy: value => { busy = value; }, consent: () => consent };
}

test('generation reserves the account before asynchronous reference preparation and requires review before export', async () => {
  const f = fixture(), preparation = deferred();
  f.store.prepareGeneration = async () => { assert.equal(f.host.atlasSpriteJobs, 1); return preparation.promise; };
  const pending = f.call('generate', f.request);
  assert.equal(f.jobs.size, 1);
  assert.equal(f.host.atlasSpriteJobs, 1);
  assert.equal(f.consent(), 1);
  assert.throws(() => f.call('recipe', f.project.id, {}, 4), /Stop or finish/);
  await assert.rejects(f.call('generate', f.request), /Stop or finish|Finish or stop/);
  preparation.resolve({ project: f.project, referencePaths: [], approvedPaths: [] });
  const result = await pending;
  assert.equal(result.version, 5);
  assert.deepEqual(f.writes, ['candidate']);
  assert.equal(f.host.atlasSpriteJobs, 0);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.taskUpdates.at(-1)[1].status, 'completed');
  assert.equal(f.events.some(event => event.changed), false);
});

test('cancel before model invocation and late model output cannot save a candidate', async () => {
  for (const phase of ['preparation', 'provider']) {
    const f = fixture(), gate = deferred(), started = deferred();
    let providerCalls = 0;
    if (phase === 'preparation') f.store.prepareGeneration = async () => gate.promise;
    f.host.generateSpriteScenes = async () => { providerCalls++; started.resolve(); return phase === 'provider' ? gate.promise : { response: '{}', model: 'Fixture' }; };
    const pending = f.call('generate', f.request);
    if (phase === 'provider') await started.promise;
    f.call('cancel', f.project.id);
    gate.resolve(phase === 'preparation' ? { project: f.project, referencePaths: [], approvedPaths: [] } : { response: '{}', model: 'Fixture' });
    await assert.rejects(pending, /stopped or timed out/);
    assert.equal(providerCalls, phase === 'preparation' ? 0 : 1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.jobs.size, 0);
    assert.equal(f.host.atlasSpriteJobs, 0);
    assert.equal(f.taskUpdates.at(-1)[1].status, 'cancelled');
  }
});

test('save receives the request version and abort signal, and stale recipes fail without artwork', async () => {
  const f = fixture();
  await assert.rejects(f.call('generate', { ...f.request, version: 3 }), /changed; reload/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.host.atlasSpriteJobs, 0);
  let receivedSignal;
  f.store.saveGeneration = async (id, response, model, directions, version, signal) => {
    assert.equal(id, f.project.id); assert.equal(version, 4); assert.deepEqual(Object.keys(response.directions), f.request.directions); assert.equal(model, 'Fixture model');
    assert.deepEqual(Array.from(directions), f.request.directions);
    receivedSignal = signal; f.call('cancel', id);
    if (signal.aborted) throw new Error('cancelled');
  };
  await assert.rejects(f.call('generate', f.request), /stopped or timed out/);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(f.writes.length, 0);
});

test('a 16-slot apparel family is validated in four batches and saved once atomically', async () => {
  const f = fixture();
  Object.assign(f.project.recipe, { kind: 'apparel', frameCount: 1, apparelLayer: 'Shell', apparelCoverage: 'upper' });
  const slots = Array.from(profileModule.exports.getSpriteSlots(f.project.recipe));
  const approvedPaths = slots.map(slot => path.join('C:/owned/revisions', slot + '-preview.png'));
  f.store.prepareGeneration = async () => ({ project: f.project, referencePaths: ['C:/owned/master.png'], approvedPaths });
  const batches = [];
  f.host.generateSpriteScenes = async args => {
    assert.equal(f.host.atlasSpriteJobs, 1);
    assert.equal(f.jobs.size, 1);
    assert.equal(args.approvedPaths.length, 4);
    for (const slot of args.directions) assert(args.approvedPaths.some(file => path.basename(file) === slot + '-preview.png'), 'Current batch lost its approved identity view');
    assert.equal(f.writes.length, 0, 'Earlier batches were committed before the family completed');
    batches.push(Array.from(args.directions));
    return { response: responseFor(args.directions), model: 'Fixture model' };
  };
  let saved = 0;
  f.store.saveGeneration = async (id, combined, _model, directions, version, signal) => {
    saved++; assert.equal(id, f.project.id); assert.equal(version, 4); assert.equal(signal.aborted, false);
    assert.deepEqual(Object.keys(combined.directions), slots); assert.deepEqual(Array.from(directions), slots);
    f.writes.push('candidate'); return { ...f.project, version: 5 };
  };
  await f.call('generate', { ...f.request, directions: slots });
  assert.equal(batches.length, 4); assert.equal(saved, 1);
  assert.deepEqual(batches.flat(), slots);
  assert.deepEqual(f.taskUpdates.filter(update => /^Designing asset batch/.test(update[1].phase)).map(update => update[1].fraction), [0, 0.25, 0.5, 0.75]);
  assert.equal(f.host.atlasSpriteJobs, 0); assert.equal(f.timers.size, 0);
});

test('cancelling or returning unsafe SVG in a later apparel batch commits no partial revision', async () => {
  for (const mode of ['cancel', 'unsafe']) {
    const f = fixture(); Object.assign(f.project.recipe, { kind: 'apparel', frameCount: 1, apparelLayer: 'Shell', apparelCoverage: 'upper' });
    const slots = Array.from(profileModule.exports.getSpriteSlots(f.project.recipe));
    const approvedBefore = JSON.stringify(f.project.approved); let calls = 0;
    f.host.generateSpriteScenes = async args => {
      calls++;
      if (calls === 2 && mode === 'cancel') f.call('cancel', f.project.id);
      if (calls === 2 && mode === 'unsafe') return { response: JSON.stringify({ directions: Object.fromEntries(args.directions.map(slot => [slot, { body: { svg: '<script>bad()</script>' } }])) }), model: 'Fixture' };
      return { response: responseFor(args.directions), model: 'Fixture' };
    };
    await assert.rejects(f.call('generate', { ...f.request, directions: slots }), mode === 'cancel' ? /stopped or timed out/ : /SVG|Unsupported|forbidden|permitted/i);
    assert.equal(calls, 2); assert.equal(f.writes.length, 0); assert.equal(JSON.stringify(f.project.approved), approvedBefore);
    assert.equal(f.host.atlasSpriteJobs, 0); assert.equal(f.jobs.size, 0); assert.equal(f.timers.size, 0);
  }
});

test('master import validates the target slot and cancelled file selection creates nothing', async () => {
  const f = fixture();
  f.electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal(await f.call('create-master', f.project.recipe, 'reference'), null);
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.call('create-master', f.project.recipe, 'slot', 'west'), /required asset view/);
  f.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['master.png'] });
  const imported = await f.call('create-master', f.project.recipe, 'slot', 'east');
  assert.equal(imported.recipe.kind, 'bird'); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].master.mode, 'slot'); assert.equal(f.writes[0].master.slot, 'east');
});

test('archive and deletion check versions, block active jobs and invalidate reviewed exports', async () => {
  const f = fixture();
  f.jobs.set(f.project.id, new AbortController());
  assert.throws(() => f.call('archive', f.project.id, true, 4), /Stop or finish/);
  assert.throws(() => f.call('delete', f.project.id, 4), /Stop or finish/);
  f.jobs.clear();
  assert.throws(() => f.call('archive', f.project.id, true, 3), /changed; reload/);
  const archived = f.call('archive', f.project.id, true, 4); assert.equal(archived.archived, true);
  const restored = f.call('archive', f.project.id, false, 5); assert.equal(restored.archived, false);
  const plan = await f.call('export-plan', f.project.id, 'OwnedMod', 6);
  f.call('delete', f.project.id, 6);
  await assert.rejects(f.call('export-apply', plan.token), /Preview this export again/);
  assert.deepEqual(f.writes, ['deleted']);
});

test('task cancellation and quitting abort an in-flight job, and sign-in blocks generation', async () => {
  const f = fixture(), gate = deferred();
  f.store.prepareGeneration = async () => gate.promise;
  const pending = f.call('generate', f.request);
  assert.throws(() => f.host.atlasSpriteTaskAction(f.project.id, 'retry'), /Generate a new candidate/);
  f.events.find(event => event.name === 'before-quit').fn();
  assert.equal(f.jobs.get(f.project.id).signal.aborted, true);
  gate.resolve({ project: f.project, referencePaths: [], approvedPaths: [] });
  await assert.rejects(pending, /stopped or timed out/);
  for (const flag of ['felixAccountOperation', 'pendingOAuth', 'atlasModImport']) {
    f.host[flag] = true;
    await assert.rejects(f.call('generate', f.request), /Finish sign-in or mod import/);
    delete f.host[flag];
  }
});

test('PNG import rechecks editability after the native file dialog', async () => {
  const f = fixture(), dialog = deferred();
  f.electron.dialog.showOpenDialog = async () => dialog.promise;
  const pending = f.call('import', f.project.id, 'reference', 4);
  f.jobs.set(f.project.id, new AbortController());
  dialog.resolve({ canceled: false, filePaths: ['fixture.png'] });
  await assert.rejects(pending, /Stop or finish/);
});

test('export applies only a live reviewed token, once, and refreshes the target mod', async () => {
  const f = fixture();
  const plan = await f.call('export-plan', f.project.id, 'OwnedMod', 4);
  assert.equal(plan.rows[0].path, 'Textures/Bird.png');
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.call('export-apply', 'unknown-token'), /Preview this export again/);
  f.setBusy(true);
  await assert.rejects(f.call('export-apply', plan.token), /Finish active work/);
  f.setBusy(false);
  const applied = await f.call('export-apply', plan.token);
  assert.equal(applied.files, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.host.atlasSpriteExport, false);
  assert.equal(f.events.some(event => event.changed === 'OwnedMod'), true);
  await assert.rejects(f.call('export-apply', plan.token), /Preview this export again/);
  const expired = await f.call('export-plan', f.project.id, 'OwnedMod', 4);
  f.setNow(1600001);
  await assert.rejects(f.call('export-apply', expired.token), /Preview this export again/);
  assert.equal(f.writes.length, 1);
});
