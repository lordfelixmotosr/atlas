const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../src/atlas/sprite-studio-routes.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const handlers = new Map(), jobs = new Map(), events = [], taskUpdates = [], writes = [], timers = new Map();
  let now = 1000000, token = 0, consent = 0, busy = false;
  const project = { id: 'family-id', version: 4, recipe: { kind: 'bird' } };
  class Store {
    constructor(options) { this.options = options; }
    read(id) { if (id !== project.id) throw new Error('Unknown sprite project'); return project; }
    list() { return [project]; }
    create(recipe) { return { recipe }; }
    saveRecipe(id, recipe, version) { this.checkVersion(id, version); return { ...project, recipe }; }
    approve(id, _candidate, _directions, version) { this.checkVersion(id, version); return project; }
    importPng(id, _direction, _source, version) { this.checkVersion(id, version); return project; }
    projectDir(id) { this.read(id); return path.join('fixture', id); }
    checkVersion(id, version) { this.read(id); if (version !== project.version) throw new Error('Sprite project changed; reload'); }
    async prepareGeneration(id, _directions, _instruction, version) { this.checkVersion(id, version); return { project, referencePaths: [], approvedPaths: [] }; }
    async saveGeneration(id, _response, _model, _directions, version, signal) {
      this.checkVersion(id, version); if (signal.aborted) throw new Error('cancelled'); writes.push('candidate'); return { ...project, version: 5 };
    }
    async planExport(id, projectRoot, version) { this.checkVersion(id, version); return { projectRoot, rows: [{ path: 'Textures/Bird.png', bytes: 100, action: 'create' }], xml: '<PawnKindDef/>', warnings: [] }; }
    async applyExport(plan, backup) { writes.push({ plan, backup }); return { files: 1, backup: null }; }
  }
  const host = { generateSpriteScenes: async () => ({ response: '{}', model: 'Fixture model' }) };
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
      if (name.endsWith('sprite-studio.cjs')) return { SpriteStudio: Store };
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
    assert.equal(id, f.project.id); assert.equal(version, 4); assert.equal(response, '{}'); assert.equal(model, 'Fixture model');
    assert.deepEqual(Array.from(directions), f.request.directions);
    receivedSignal = signal; f.call('cancel', id);
    if (signal.aborted) throw new Error('cancelled');
  };
  await assert.rejects(f.call('generate', f.request), /stopped or timed out/);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(f.writes.length, 0);
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
