'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { SpriteStudio } = require('../src/atlas/sprite-studio.cjs');
const crc = data => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const bytes = Buffer.alloc(data.length + 12), name = Buffer.from(type); bytes.writeUInt32BE(data.length); name.copy(bytes, 4); data.copy(bytes, 8); bytes.writeUInt32BE(crc(Buffer.concat([name, data])), data.length + 8); return bytes; };
function png(svg) {
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((128 * 4 + 1) * 128), color = crypto.createHash('sha256').update(svg).digest();
  const index = 64 * (128 * 4 + 1) + 1 + 64 * 4; pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = 255;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const rasterize = async svg => ({ png: png(svg), width: 128, height: 128 });
const recipe = { name: 'Progress test bird', kind: 'bird', brief: 'Bird with separate wings', canvasSize: 128, frameCount: 8, ticksPerFrame: 2, drawSize: 1.5, textureName: 'ProgressTestBird' };
const scene = mark => ({ body: { svg: `<rect x="54" y="44" width="20" height="35" fill="#${mark}"/>` }, wingNear: { svg: '<path d="M64 58 L90 62 L75 74Z" fill="#809178"/>', pivot: { x: 64, y: 58 } }, wingFar: { svg: '<path d="M64 58 L38 62 L53 74Z" fill="#809178"/>', pivot: { x: 64, y: 58 } } });
const response = (slots, mark = 'f0e6d0') => ({ directions: Object.fromEntries(slots.map(slot => [slot, scene(mark)])) });
const all = ['south', 'east', 'north'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sprite-progress-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^atlas-sprite-progress-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store: new SpriteStudio({ root: path.join(root, 'studio'), rasterize }) };
}
function pngFiles(root) { const files = []; const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile() && entry.name.endsWith('.png')) files.push(file); } }; walk(root); return files.sort(); }
async function baseline(f) { let project = f.store.create(recipe); project = await f.store.saveGeneration(project.id, response(all), 'Baseline', all, project.version, new AbortController().signal); return f.store.approve(project.id, project.candidates[0].id, all, project.version); }

test('one, two and three selected bird views render only their requested PNGs and preserve existing approvals and files', async t => {
  const f = fixture(t); let project = await baseline(f);
  const original = JSON.parse(JSON.stringify(project)), originalFiles = pngFiles(f.store.projectDir(project.id)), originalHashes = originalFiles.map(file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  for (const slots of [['south'], ['east', 'north'], all]) {
    const history = project.candidates.length, beforePngs = pngFiles(f.store.projectDir(project.id)).length, events = [];
    project = await f.store.saveGeneration(project.id, response(slots, 'dceabc'), 'Selected views', slots, project.version, new AbortController().signal, event => {
      events.push({ ...event });
      assert.equal(pngFiles(f.store.projectDir(project.id)).length - beforePngs, event.completed, 'Progress led the number of PNGs actually committed to candidate files');
      assert.equal(f.store.read(project.id).candidates.length, history, 'A revision was committed before its saving stage completed');
    });
    assert.deepEqual(Object.keys(project.candidates.at(-1).directions), slots);
    assert.deepEqual(project.approved, original.approved);
    assert.equal(project.candidates.length, history + 1);
    assert.equal(pngFiles(f.store.projectDir(project.id)).length - beforePngs, slots.length * 9);
    assert.deepEqual(events.filter(event => event.stage === 'rendering').map(event => event.completed), Array.from({ length: slots.length * 9 + 1 }, (_, index) => index));
    assert(events.every(event => event.total === slots.length * 9));
    assert.equal(events.at(-1).stage, 'saving');
    assert(!events.some(event => event.stage === 'complete'), 'Core announced completion before the outer job received the committed project');
    for (const slot of slots) assert.deepEqual(events.filter(event => event.direction === slot).map(event => event.frame), [null, 1, 2, 3, 4, 5, 6, 7, 8]);
  }
  assert.deepEqual(originalFiles.map(file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')), originalHashes);
});

test('an unapproved generated direction guides the next direction without changing approval status', async t => {
  const f = fixture(t); let project = f.store.create(recipe);
  project = await f.store.saveGeneration(project.id, response(['south']), 'First direction', ['south'], project.version, new AbortController().signal);
  const identity = f.store.prepareGeneration(project.id, ['north'], '', project.version);
  assert(identity.approvedPaths.some(file => file.endsWith('south-preview.png')));
  assert.deepEqual(identity.project.approved, {});
  const south = project.candidates[0].directions.south;
  project = await f.store.saveGeneration(project.id, response(['north'], 'a0b078'), 'Next direction', ['north'], project.version, new AbortController().signal);
  assert.deepEqual(project.approved, {});
  assert.equal(project.candidates.length, 2);
  assert.deepEqual(project.candidates[0].directions.south, south);
  assert(fs.existsSync(path.join(f.store.projectDir(project.id), south.preview)));
});

test('cancellation during PNG rendering or saving cannot commit a partial revision or leave its images behind', async t => {
  for (const stage of ['rendering', 'saving']) {
    const f = fixture(t), project = await baseline(f), controller = new AbortController(), initialFiles = pngFiles(f.store.projectDir(project.id)), events = [];
    await assert.rejects(f.store.saveGeneration(project.id, response(['south']), 'Cancelled', ['south'], project.version, controller.signal, event => {
      events.push(event);
      if (stage === 'rendering' && event.completed === 3 || stage === 'saving' && event.stage === 'saving') controller.abort();
    }), /cancelled/);
    assert.deepEqual(f.store.read(project.id), project);
    assert.deepEqual(pngFiles(f.store.projectDir(project.id)), initialFiles);
    assert.equal(f.store.pending, 0);
    assert(!events.some(event => event.stage === 'complete'));
  }
});

test('a cancellation arriving while rasterization is awaiting cannot write that pending PNG', async t => {
  const f = fixture(t), project = await baseline(f), controller = new AbortController(), before = pngFiles(f.store.projectDir(project.id));
  let resolveRender, beginRender; const entered = new Promise(resolve => { beginRender = resolve; });
  f.store.rasterize = async svg => { beginRender(); return new Promise(resolve => { resolveRender = () => resolve({ png: png(svg), width: 128, height: 128 }); }); };
  const pending = f.store.saveGeneration(project.id, response(['east']), 'Interrupted render', ['east'], project.version, controller.signal);
  await entered; controller.abort(); resolveRender();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(pngFiles(f.store.projectDir(project.id)), before);
  assert.deepEqual(f.store.read(project.id).approved, project.approved);
});

test('copied views preserve their origin while a new generation owns its files even if pixels match', async t => {
  const f = fixture(t); let project = await baseline(f);
  const baselineId = project.candidates[0].id, source = path.join(f.root, 'import.png'); fs.writeFileSync(source, png('imported artwork'));
  project = await f.store.importPng(project.id, 'south', source, project.version);
  const imported = project.candidates.at(-1);
  assert.equal(imported.directions.east.originCandidateId, baselineId);
  assert.equal(imported.directions.north.originCandidateId, baselineId);
  assert.equal(imported.directions.south.originCandidateId, imported.id);
  project = await f.store.saveGeneration(project.id, response(['east']), 'Identical regeneration', ['east'], project.version, new AbortController().signal);
  const regenerated = project.candidates.at(-1);
  assert.equal(regenerated.directions.east.previewHash, project.candidates[0].directions.east.previewHash);
  assert.equal(regenerated.directions.east.originCandidateId, regenerated.id);
  assert.notEqual(regenerated.id, baselineId);
});

test('an unknown or mismatched origin cannot impersonate previous generated artwork', async t => {
  const f = fixture(t); let project = await baseline(f);
  project = await f.store.saveGeneration(project.id, response(['south'], '010203'), 'Different artwork', ['south'], project.version, new AbortController().signal);
  const file = path.join(f.store.projectDir(project.id), 'project.json');
  for (const origin of ['ffffffffffffffffffffffff', project.candidates[0].id]) {
    const invalid = JSON.parse(JSON.stringify(project)); invalid.candidates.at(-1).directions.south.originCandidateId = origin;
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => f.store.read(project.id), /origin|provenance/i);
  }
});
