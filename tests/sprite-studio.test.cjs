'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const { SpriteStudio, getSlots, validateDirections, validateRecipe, profileMeta, parseResponse, pngInfo } = require('../src/atlas/sprite-studio.cjs');
const COLORS = ['#f4ead2', '#81917b', '#181b18'];
const recipe = (extra = {}) => ({ name: 'Forest bird', kind: 'bird', brief: 'Small ivory forest bird, green wings, dark beak.', palette: COLORS, canvasSize: 128, frameCount: 8, ticksPerFrame: 2, drawSize: 1.5, textureName: 'ForestBird', ...extra });
const scene = () => ({ body: { svg: '<rect x="54" y="47" width="20" height="36" rx="8" fill="#f4ead2"/><circle cx="68" cy="51" r="2" fill="#181b18"/>' }, wingNear: { svg: '<path d="M64 59 L97 64 L82 74 L64 68 Z" fill="#81917b" stroke="#181b18" stroke-width="2"/>', pivot: { x: 64, y: 64 } }, wingFar: { svg: '<path d="M64 59 L32 64 L45 74 L64 68 Z" fill="#81917b"/>', pivot: { x: 64, y: 64 } } });
const response = directions => ({ directions: Object.fromEntries(directions.map(direction => [direction, scene()])) });
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc(data) { let value = 0xffffffff; for (const b of data) value = crcTable[(value ^ b) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([name, data])), data.length + 8); return out; }
function png(size = 128, solid = false, color = 6) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = color;
  const channels = color === 6 ? 4 : 3, rows = Buffer.alloc((size * channels + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const p = y * (size * channels + 1) + 1 + x * channels; rows[p] = 244; rows[p + 1] = 234; rows[p + 2] = 210; if (color === 6) rows[p + 3] = solid || x > 40 && x < 85 && y > 40 && y < 85 ? 255 : 0; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function indexedPng(size = 128) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 3;
  const pixels = Buffer.alloc((size + 1) * size);
  for (let y = 40; y < 85; y++) for (let x = 40; x < 85; x++) pixels[y * (size + 1) + 1 + x] = 1;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('PLTE', Buffer.from([0, 0, 0, 129, 145, 123])), chunk('tRNS', Buffer.from([0, 255])), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const mockRasterize = async (svg, opts) => ({ png: png(opts.fitTo.value), width: opts.fitTo.value, height: opts.fitTo.value });
function fixture(t, rasterize = mockRasterize) {
  const base = path.resolve(__dirname, '../build-check/fixtures'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'sprite-studio-')), studioRoot = path.join(root, 'studio'), modRoot = path.join(root, 'mod'), backups = path.join(root, 'backups'); fs.mkdirSync(modRoot);
  const store = new SpriteStudio({ root: studioRoot, rasterize });
  t.after(() => { assert(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, studioRoot, modRoot, backups, store };
}
async function approved(f, kind = 'bird') { let project = f.store.create(recipe(kind === 'sprite' ? { kind, frameCount: 1 } : {})); project = await f.store.saveGeneration(project.id, response(['south', 'east', 'north']), 'Test model', ['south', 'east', 'north'], project.version); return f.store.approve(project.id, project.candidates[0].id, ['south', 'east', 'north'], project.version); }

test('recipes create portable projects and a typed Forge asset manifest before generation', t => {
  const f = fixture(t), project = f.store.create(recipe()), manifest = JSON.parse(fs.readFileSync(path.join(f.store.projectDir(project.id), 'ASSETS-NEEDED.json')));
  assert.equal(project.version, 1); assert.equal(f.store.list()[0].name, 'Forest bird');
  assert.deepEqual(manifest.canvas, [128, 128]); assert.equal(manifest.transparent, true); assert.equal(manifest.framesPerDirection, 8); assert.equal(manifest.gameLoopTicks, 18); assert.equal(manifest.evidence.gameVisualTest.includes('pending'), true);
  assert.equal(project.recipe.groundedDrawSize, 0.7); assert.equal(manifest.groundedDrawSize, 0.7); assert.equal(manifest.flightDrawSize, 1.5);
  assert.equal(f.store.create(recipe({ kind: 'sprite', frameCount: 1, drawSize: 1.2 })).recipe.groundedDrawSize, 1.2);
  assert.equal(f.store.create(recipe({ kind: 'sprite', frameCount: 1, drawSize: 1.2, groundedDrawSize: 0.4 })).recipe.groundedDrawSize, 1.2);
  for (const changes of [{ textureName: '../outside' }, { frameCount: 9 }, { drawSize: Infinity }, { groundedDrawSize: 0 }, { groundedDrawSize: Infinity }, { canvasSize: 4096 }]) assert.throws(() => f.store.create(recipe(changes)));
  const noPalette = recipe(); delete noPalette.palette; assert.deepEqual(f.store.create(noPalette).recipe.palette, ['#000000', '#ffffff']);
  assert.deepEqual(f.store.create(recipe({ palette: ['red', 'green'] })).recipe.palette, ['#000000', '#ffffff']);
});

test('model output allows safe artwork colors while rejecting scripts, unsafe paint, XML entities and excessive geometry', () => {
  const r = recipe();
  for (const svg of ['<script>alert(1)</script>', '<image href="file:///private.png"/>', '<use href="#shape"/>', '<text>bird</text>', '<path d="M0 0 L10 10" style="fill:red"/>', '<path d="M0 0 L10 10" fill="hsl(120 90% 30%)"/>', '<path d="M0 0 L10 10" fill="rgb(255,0,0)"/>', '<path d="M0 0 L10 10" stroke="javascript:alert(1)"/>', '<g onload="alert(1)"><path d="M1 1 L2 2"/></g>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]>', '<path d="M0 0 L10 10" fill="url(https://example.com)"/>', '<path d="M0 0 L1000000 1"/>', '<g><path d="M0 0 L2 2"/>', '<g>&secret;</g>', '<path d="M0 0 L2 2" transform="translate(1 1) evil(0)"/>']) {
    assert.throws(() => parseResponse({ directions: { south: { body: { svg } } } }, ['south'], r), svg);
  }
  assert.throws(() => parseResponse(response(['south', 'east']), ['south'], r), /exactly/);
  assert.throws(() => parseResponse('x'.repeat(500001), ['south'], r), /500 KB/);
  assert.throws(() => parseResponse({ directions: { south: { body: { svg: '<circle cx="1" cy="1" r="1"/>'.repeat(2001) } } } }, ['south'], r), /shape limit/);
  const good = response(['south']); good.directions.south.body.svg = '<g fill="#f4ead2" transform="translate(1 2)"><path d="M2 2 C4 3 5 6 6 7 Z"/></g>';
  assert.equal(parseResponse('```json\n' + JSON.stringify(good) + '\n```', ['south'], r).south.body.svg.includes('<g'), true);
  const referenceColors = { directions: { south: { body: { svg: '<circle cx="64" cy="64" r="20" fill="#E632CD" stroke="#123456" stroke-width="2"/>' } } } };
  assert.equal(parseResponse(referenceColors, ['south'], r).south.body.svg, referenceColors.directions.south.body.svg);
  good.directions.south.wingNear.pivot.x = 1000; assert.throws(() => parseResponse(good, ['south'], r), /pivots/);
});

test('PNG validation decodes bounded pixels, checks integrity and rejects opaque-format, oversized or malformed images', () => {
  assert.deepEqual(pngInfo(png()).warnings, []);
  assert.equal(pngInfo(png(128, true)).warnings.length, 2);
  assert.throws(() => pngInfo(png(128, false, 2)), /alpha channel/);
  const corrupted = png(); corrupted[corrupted.length - 5] ^= 1; assert.throws(() => pngInfo(corrupted), /checksum/);
  assert.throws(() => pngInfo(png().subarray(0, 80)), /Truncated|Incomplete/);
  const oversized = png(); oversized.writeUInt32BE(2049, 16); assert.throws(() => pngInfo(oversized), /2048/);
  const deceptive = png(), header = deceptive.subarray(16, 29); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); deceptive.writeUInt32BE(crc(deceptive.subarray(12, 29)), 29); assert.throws(() => pngInfo(deceptive), /pixel data/);
});

test('rendered bird body stays identical across all deterministic frame poses and saves immutable candidates', async t => {
  const calls = [], f = fixture(t, async (svg, opts) => { calls.push(svg); return mockRasterize(svg, opts); });
  let project = f.store.create(recipe()); project = await f.store.saveGeneration(project.id, JSON.stringify(response(['south'])), 'Test', ['south'], project.version);
  const candidate = project.candidates[0], art = candidate.directions.south;
  assert.equal(calls.length, 9); assert.equal(art.frames.length, 8); assert.equal(art.hasWingRig, true);
  for (const svg of calls) { assert.equal(svg.split(scene().body.svg).length, 2); assert(svg.includes('viewBox="0 0 128 128"')); }
  assert.equal(new Set(calls.slice(1)).size, 8);
  assert.equal(fs.existsSync(path.join(f.store.projectDir(project.id), art.preview)), true);
  const snapshot = fs.readFileSync(path.join(f.store.projectDir(project.id), art.preview));
  let second = await f.store.saveGeneration(project.id, response(['south']), 'Revision', ['south'], project.version);
  assert.notEqual(second.candidates[1].id, candidate.id); assert.deepEqual(fs.readFileSync(path.join(f.store.projectDir(project.id), art.preview)), snapshot);
  second = f.store.approve(project.id, candidate.id, ['south'], second.version); assert.equal(second.approved.south, candidate.id);
});

test('actual resvg renders three rigged views into 27 valid alpha PNGs and exports the native Odyssey names', async t => {
  const mod = require('../build-tools/native/node_modules/@resvg/resvg-wasm'); await mod.initWasm(fs.readFileSync(path.join(path.dirname(require.resolve('../build-tools/native/node_modules/@resvg/resvg-wasm')), 'index_bg.wasm')));
  const rasterize = async (svg, opts) => { const resvg = new mod.Resvg(svg, opts), rendered = resvg.render(); try { return { png: Buffer.from(rendered.asPng()), width: rendered.width, height: rendered.height }; } finally { rendered.free?.(); resvg.free?.(); } };
  const f = fixture(t, rasterize), project = await approved(f), plan = f.store.planExport(project.id, f.modRoot, project.version);
  assert.equal(plan.rows.length, 27); assert.equal(plan.rows.filter(row => /_Flying_/.test(row.path)).length, 24); assert.equal(plan.rows.some(row => /west|\.xml/.test(row.path)), false);
  for (const direction of ['south', 'east', 'north']) { assert(plan.rows.some(row => row.path.endsWith(`ForestBird_Flying_1_${direction}.png`))); assert(plan.rows.some(row => row.path.endsWith(`ForestBird_Flying_8_${direction}.png`))); }
  assert(plan.xml.includes('<flyingAnimationFrameCount>8</flyingAnimationFrameCount>')); assert(plan.xml.includes('<flyingAnimationTicksPerFrame>2</flyingAnimationTicksPerFrame>')); assert(plan.warnings.some(x => x.includes('not been')));
  assert(plan.xml.includes('<flyingAnimationDrawSize>1.5</flyingAnimationDrawSize>')); assert(plan.xml.includes('<drawSize>0.7</drawSize>'));
  const candidate = project.candidates[0], frames = candidate.directions.south.frames.map(file => fs.readFileSync(path.join(f.store.projectDir(project.id), file)));
  assert.equal(new Set(frames.map(bytes => bytes.toString('base64'))).size, 8); for (const bytes of frames) { const info = pngInfo(bytes); assert.equal(info.width, 128); assert.equal(info.height, 128); assert.equal(info.warnings.length, 0); }
  const result = f.store.applyExport(plan, f.backups); assert.equal(result.files, 27); assert.equal(result.backup, null);
  for (const row of plan.rows) assert.equal(pngInfo(fs.readFileSync(path.join(f.modRoot, row.path))).width, 128);
  assert.equal(fs.existsSync(path.join(f.modRoot, 'ASSETS-NEEDED.json')), false);
  let imported = f.store.create(recipe({ kind: 'sprite', frameCount: 1 }));
  const rgbFile = path.join(f.root, 'RGB.png'), indexedFile = path.join(f.root, 'indexed.png'); fs.writeFileSync(rgbFile, png(128, true, 2)); fs.writeFileSync(indexedFile, indexedPng());
  imported = await f.store.importPng(imported.id, 'south', rgbFile, imported.version);
  assert(imported.candidates[0].directions.south.warnings.some(w => w.includes('fully opaque')));
  imported = await f.store.importPng(imported.id, 'east', indexedFile, imported.version);
  const normalized = pngInfo(fs.readFileSync(path.join(f.store.projectDir(imported.id), imported.candidates[1].directions.east.preview))); assert.equal(normalized.visible, true); assert.equal(normalized.warnings.length, 0);
  imported = await f.store.importPng(imported.id, 'reference', rgbFile, imported.version); assert.notEqual(imported.references[0].hash, imported.references[0].sourceHash);
  const noPaletteRecipe = recipe({ kind: 'sprite', frameCount: 1 }); delete noPaletteRecipe.palette;
  let freeColors = f.store.create(noPaletteRecipe); freeColors = await f.store.saveGeneration(freeColors.id, { directions: { south: { body: { svg: '<circle cx="64" cy="64" r="20" fill="#e632cd" stroke="#123456" stroke-width="3"/>' } } } }, 'Reference colors', ['south'], freeColors.version);
  assert.equal(pngInfo(fs.readFileSync(path.join(f.store.projectDir(freeColors.id), freeColors.candidates[0].directions.south.preview))).visible, true);
  const freeManifest = JSON.parse(fs.readFileSync(path.join(f.store.projectDir(freeColors.id), 'ASSETS-NEEDED.json'))); assert.equal(freeManifest.palette, undefined); assert.equal(freeManifest.profile.palette, undefined); assert(freeManifest.colorSource.includes('not restricted'));
  const freePrompt = f.store.prepareGeneration(freeColors.id, ['east'], 'Use blue shading from my reference', freeColors.version).prompt; assert(!freePrompt.includes('"palette"')); assert(freePrompt.includes('any safe #RRGGBB'));
});

test('approval is explicit, structural recipe changes are locked after artwork, and stale UI writes are rejected', async t => {
  const f = fixture(t); let project = f.store.create(recipe()); const oldVersion = project.version;
  project = await f.store.saveGeneration(project.id, response(['south']), 'Test', ['south'], project.version);
  assert.deepEqual(project.approved, {}); assert.throws(() => f.store.planExport(project.id, f.modRoot, project.version), /Approve/);
  for (const changes of [{ canvasSize: 256 }, { palette: ['#000000', '#ffffff'] }, { ticksPerFrame: 3 }, { drawSize: 2 }, { groundedDrawSize: 1.5 }, { textureName: 'ChangedName' }, { kind: 'sprite', frameCount: 1 }]) assert.throws(() => f.store.saveRecipe(project.id, { ...project.recipe, ...changes }, project.version), /locked/);
  assert.throws(() => f.store.approve(project.id, project.candidates[0].id, ['south'], oldVersion), /changed/);
  assert.throws(() => f.store.approve(project.id, project.candidates[0].id, ['east'], project.version), /selected directions/);
  project = f.store.saveRecipe(project.id, { ...project.recipe, name: 'Renamed bird', brief: 'Preserve markings; refine eyes.' }, project.version); assert.equal(project.recipe.name, 'Renamed bird');
  assert.throws(() => f.store.saveRecipe(project.id, { ...project.recipe, groundedDrawSize: 0.8 }, oldVersion), /changed/);
});

test('reference import is additive, bounded, copied into the project and included with approved view references', async t => {
  const f = fixture(t), file = path.join(f.root, 'reference.png'); fs.writeFileSync(file, png());
  let project = f.store.create(recipe()); project = await f.store.importPng(project.id, 'reference', file, project.version); assert.equal(project.references.length, 1); assert.equal(project.version, 2);
  const prepared = f.store.prepareGeneration(project.id, ['south'], 'Keep this palette', project.version); assert.equal(prepared.referencePaths.length, 1); assert(prepared.prompt.includes('West flight will mirror east'));
  fs.writeFileSync(file, png(128, true)); assert.deepEqual(fs.readFileSync(prepared.referencePaths[0]), png());
  for (let count = 1; count < 6; count++) project = await f.store.importPng(project.id, 'reference', file, project.version);
  await assert.rejects(f.store.importPng(project.id, 'reference', file, project.version), /six/);
  const stored = path.join(f.store.projectDir(project.id), project.references[0].path); fs.writeFileSync(stored, png(128, true)); assert.throws(() => f.store.prepareGeneration(project.id, ['east'], '', project.version), /reference changed/);
});

test('flat PNGs produce static candidates and cannot masquerade as bird wing rigs', async t => {
  const f = fixture(t), file = path.join(f.root, 'flat.png'); fs.writeFileSync(file, png());
  let bird = f.store.create(recipe());
  for (const direction of ['south', 'east', 'north']) { bird = await f.store.importPng(bird.id, direction, file, bird.version); bird = f.store.approve(bird.id, bird.candidates.at(-1).id, [direction], bird.version); }
  assert.equal(bird.candidates[0].directions.south.hasWingRig, false); assert.throws(() => f.store.planExport(bird.id, f.modRoot, bird.version), /layered wing rigs/);
  let sprite = f.store.create(recipe({ kind: 'sprite', frameCount: 1 }));
  for (const direction of ['south', 'east', 'north']) { sprite = await f.store.importPng(sprite.id, direction, file, sprite.version); sprite = f.store.approve(sprite.id, sprite.candidates.at(-1).id, [direction], sprite.version); }
  const staticPlan = f.store.planExport(sprite.id, f.modRoot, sprite.version); assert.equal(staticPlan.rows.length, 3); assert(staticPlan.xml.includes('<drawSize>1.5</drawSize>'));
});

test('junctions and traversal cannot redirect project storage, imports or export writes', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.png'), png());
  const link = path.join(f.root, 'linked'); fs.symlinkSync(outside, link, 'junction'); assert.throws(() => new SpriteStudio({ root: path.join(link, 'studio'), rasterize: mockRasterize }), /junction/);
  const project = await approved(f); assert.throws(() => f.store.read('../outside'), /Invalid/);
  await assert.rejects(f.store.importPng(project.id, 'reference', path.join(link, 'secret.png'), project.version), /junction/);
  fs.symlinkSync(outside, path.join(f.modRoot, 'Textures'), 'junction'); assert.throws(() => f.store.planExport(project.id, f.modRoot, project.version), /junction/); assert.equal(fs.readdirSync(outside).length, 1);
});

test('tampered project asset paths and reference links cannot escape the owned store', t => {
  const f = fixture(t), project = f.store.create(recipe()), file = path.join(f.store.projectDir(project.id), 'project.json');
  project.references.push({ id: 'a'.repeat(24), path: '../private.png', hash: 'b'.repeat(64) }); fs.writeFileSync(file, JSON.stringify(project)); assert.throws(() => f.store.read(project.id), /reference path/);
});

test('late generation and cancelled rendering save no stale candidates', async t => {
  let release, called; const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { called = resolve; });
  const f = fixture(t, async (svg, opts) => { called(); await gate; return mockRasterize(svg, opts); });
  let project = f.store.create(recipe()), job = f.store.saveGeneration(project.id, response(['south']), 'Test', ['south'], project.version); await began;
  project = f.store.saveRecipe(project.id, { ...project.recipe, name: 'Updated while rendering' }, project.version); release(); await assert.rejects(job, /changed/); assert.equal(f.store.read(project.id).candidates.length, 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.store.saveGeneration(project.id, response(['south']), 'Test', ['south'], project.version, controller.signal), /cancelled/); assert.equal(f.store.read(project.id).candidates.length, 0);
  assert.equal(fs.readdirSync(path.join(f.store.projectDir(project.id), 'candidates')).length, 0);
});

test('a project metadata write failure removes uncommitted artwork and preserves the existing project', async t => {
  const f = fixture(t), project = f.store.create(recipe()), original = fs.renameSync;
  fs.renameSync = (from, to) => { if (to.endsWith('project.json')) { const error = new Error('Simulated locked project file'); error.code = 'EPERM'; throw error; } return original(from, to); };
  try { await assert.rejects(f.store.saveGeneration(project.id, response(['south']), 'Test', ['south'], project.version), /locked/); }
  finally { fs.renameSync = original; }
  assert.equal(f.store.read(project.id).version, 1); assert.equal(f.store.read(project.id).candidates.length, 0); assert.equal(fs.readdirSync(path.join(f.store.projectDir(project.id), 'candidates')).length, 0);
});

test('exports reject changed targets, changed source artwork and stale reviewed project versions', async t => {
  const f = fixture(t), project = await approved(f), plan = f.store.planExport(project.id, f.modRoot, project.version);
  const first = path.join(f.modRoot, plan.rows[0].path); fs.mkdirSync(path.dirname(first), { recursive: true }); fs.writeFileSync(first, png()); assert.throws(() => f.store.applyExport(plan, f.backups), /target texture changed/);
  fs.unlinkSync(first); const candidate = project.candidates[0], source = path.join(f.store.projectDir(project.id), candidate.directions.south.preview); fs.writeFileSync(source, png(128, true)); assert.throws(() => f.store.applyExport(plan, f.backups), /artwork changed/);
  fs.writeFileSync(source, png());
  const fresh = f.store.planExport(project.id, f.modRoot, project.version); f.store.saveRecipe(project.id, { ...project.recipe, name: 'Later name' }, project.version); assert.throws(() => f.store.applyExport(fresh, f.backups), /changed/);
});

test('candidate hashes reject file edits before approval, reference reuse and export review', async t => {
  const f = fixture(t), project = await approved(f), candidate = project.candidates[0], art = candidate.directions.south;
  const preview = path.join(f.store.projectDir(project.id), art.preview); fs.writeFileSync(preview, png(128, true));
  assert.throws(() => f.store.approve(project.id, candidate.id, ['south'], project.version), /artwork changed/);
  assert.throws(() => f.store.prepareGeneration(project.id, ['east'], '', project.version), /artwork changed/);
  assert.throws(() => f.store.planExport(project.id, f.modRoot, project.version), /artwork changed/);
  fs.writeFileSync(preview, png()); fs.writeFileSync(path.join(f.store.projectDir(project.id), art.frames[0]), png(128, true));
  assert.throws(() => f.store.planExport(project.id, f.modRoot, project.version), /artwork changed/);
});

test('replacement export backs up original bytes outside mods and rolls back an interrupted multi-file write', async t => {
  const f = fixture(t), project = await approved(f), provisional = f.store.planExport(project.id, f.modRoot, project.version), first = path.join(f.modRoot, provisional.rows[0].path), before = png(128, true);
  fs.mkdirSync(path.dirname(first), { recursive: true }); fs.writeFileSync(first, before); const plan = f.store.planExport(project.id, f.modRoot, project.version), original = fs.renameSync; let failed = false;
  fs.renameSync = (from, to) => { if (!failed && to.endsWith('ForestBird_Flying_1_south.png')) { failed = true; throw new Error('Simulated disk write failure'); } return original(from, to); };
  try { assert.throws(() => f.store.applyExport(plan, f.backups), /disk write failure/); } finally { fs.renameSync = original; }
  assert.deepEqual(fs.readFileSync(first), before); assert.equal(fs.existsSync(path.join(f.modRoot, provisional.rows[1].path)), false);
  const backups = fs.readdirSync(f.backups); assert.equal(backups.length, 1); assert.deepEqual(fs.readFileSync(path.join(f.backups, backups[0], plan.rows[0].path)), before);
  const success = f.store.applyExport(plan, f.backups); assert.equal(success.files, 27); assert.equal(success.backup.startsWith(f.backups + path.sep), true); assert.deepEqual(fs.readFileSync(path.join(success.backup, plan.rows[0].path)), before);
});

test('export rejects backup destinations inside mods before writing any texture', async t => {
  const f = fixture(t), project = await approved(f), plan = f.store.planExport(project.id, f.modRoot, project.version);
  assert.throws(() => f.store.applyExport(plan, path.join(f.modRoot, '.backups')), /outside/); assert.equal(fs.existsSync(path.join(f.modRoot, plan.rows[0].path)), false); assert.equal(fs.existsSync(path.join(f.modRoot, '.backups')), false);
});

const staticResponse = slots => ({ directions: Object.fromEntries(slots.map(slot => [slot, { body: scene().body }])) });
async function approvedProfile(f, options) {
  let project = f.store.create(recipe({ frameCount: 1, ...options }));
  const slots = getSlots(project.recipe); project = await f.store.saveGeneration(project.id, staticResponse(slots), 'Test', slots, project.version);
  return f.store.approve(project.id, project.candidates[0].id, slots, project.version);
}

test('profile slot names follow native adult apparel, hat and building conventions', () => {
  const apparel = recipe({ kind: 'apparel', frameCount: 1 }); assert.equal(getSlots(apparel).length, 16);
  assert.deepEqual(getSlots(apparel).slice(0, 4), ['item', 'Male_south', 'Male_east', 'Male_north']);
  assert.deepEqual(getSlots(recipe({ kind: 'hat', frameCount: 1 })), ['item', 'south', 'east', 'north']);
  assert.deepEqual(getSlots(recipe({ kind: 'building', frameCount: 1 })), ['south', 'east', 'north', 'west']);
  assert.deepEqual(getSlots(recipe({ kind: 'furniture', frameCount: 1, graphicMode: 'single' })), ['item']);
  assert.deepEqual(validateDirections(['Fat_north', 'item'], apparel), ['item', 'Fat_north']);
  for (const slots of [['Child_south'], ['Baby_east'], ['male_south'], ['../secret'], ['west']]) assert.throws(() => validateDirections(slots, apparel), /slots/);
  assert.throws(() => parseResponse(response(['south']), ['south'], recipe({ kind: 'sprite', frameCount: 1 })), /Only Odyssey/);
  assert.equal(parseResponse(staticResponse(['Male_south']), ['Male_south'], apparel).Male_south.body.svg, scene().body.svg);
});

test('apparel export requires all five adult fits and separates inventory from worn paths and XML', async t => {
  const f = fixture(t), project = await approvedProfile(f, { kind: 'apparel', textureName: 'FieldCoat', apparelLayer: 'Shell', apparelCoverage: 'full' }), plan = f.store.planExport(project.id, f.modRoot, project.version);
  assert.equal(plan.rows.length, 16); const base = 'Textures/Things/Pawn/Humanlike/Apparel/FieldCoat/';
  assert.equal(plan.rows[0].path, base + 'FieldCoat.png');
  for (const type of ['Male', 'Female', 'Thin', 'Fat', 'Hulk']) for (const direction of ['south', 'east', 'north']) assert(plan.rows.some(row => row.path === base + `FieldCoat_${type}_${direction}.png`));
  assert(!plan.rows.some(row => /Baby|Child|_west|_Flying_/.test(row.path)));
  assert(plan.xml.includes('<graphicClass>Graphic_Single</graphicClass>')); assert(plan.xml.includes('<wornGraphicPath>Things/Pawn/Humanlike/Apparel/FieldCoat/FieldCoat</wornGraphicPath>')); assert(plan.xml.includes('<parentTagDef>ApparelBody</parentTagDef>')); assert(plan.xml.includes('<developmentalStageFilter>Adult</developmentalStageFilter>')); assert(plan.xml.includes('<li>Shell</li>'));
  for (const group of ['Torso', 'Neck', 'Shoulders', 'Arms', 'Legs']) assert(plan.xml.includes(`<li>${group}</li>`));
  assert(!plan.xml.includes('<statBases>')); assert(plan.warnings.some(w => /Child\/Baby/.test(w)));
  const summary = f.store.list().find(item => item.id === project.id); assert.equal(summary.requiredCount, 16); assert.equal(summary.approvedCount, 16);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.store.projectDir(project.id), 'ASSETS-NEEDED.json'))); assert.equal(manifest.kind, 'vanilla_adult_apparel'); assert.equal(manifest.files.length, 16);
  const result = f.store.applyExport(plan, f.backups); assert.equal(result.files, 16); for (const row of plan.rows) assert.equal(pngInfo(fs.readFileSync(path.join(f.modRoot, row.path))).width, 128);
  assert.throws(() => f.store.saveRecipe(project.id, { ...project.recipe, apparelLayer: 'Middle' }, project.version), /locked/);
  assert.throws(() => f.store.saveRecipe(project.id, { ...project.recipe, apparelCoverage: 'lower' }, project.version), /locked/);
  const lower = profileMeta(recipe({ kind: 'apparel', frameCount: 1, apparelCoverage: 'lower' })); assert(lower.xml.includes('<li>Legs</li>')); assert(!lower.xml.includes('<li>Torso</li>'));
});

test('hat export keeps one inventory icon and a distinct unsuffixed-body-type worn prefix', async t => {
  const f = fixture(t), project = await approvedProfile(f, { kind: 'hat', textureName: 'ForestCap', hatCoverage: 'full' }), plan = f.store.planExport(project.id, f.modRoot, project.version), base = 'Textures/Things/Pawn/Humanlike/Apparel/ForestCap/';
  assert.deepEqual(plan.rows.map(row => row.path), [base + 'ForestCap.png', ...['south', 'east', 'north'].map(direction => base + `ForestCap_Worn_${direction}.png`)]);
  assert(plan.xml.includes('<wornGraphicPath>Things/Pawn/Humanlike/Apparel/ForestCap/ForestCap_Worn</wornGraphicPath>')); assert(plan.xml.includes('<li>FullHead</li>')); assert(plan.xml.includes('<li>Overhead</li>')); assert(plan.xml.includes('<parentTagDef>ApparelHead</parentTagDef>'));
  assert(!plan.xml.includes('Male')); assert.equal(f.store.applyExport(plan, f.backups).files, 4);
  assert.throws(() => f.store.saveRecipe(project.id, { ...project.recipe, hatCoverage: 'upper' }, project.version), /locked/);
});

test('building and furniture graphics require explicit west and distinguish footprint from draw dimensions', async t => {
  const f = fixture(t);
  for (const kind of ['building', 'furniture']) {
    const project = await approvedProfile(f, { kind, textureName: kind === 'building' ? 'Workshop' : 'ForestBed', footprintX: 1, footprintZ: 2, drawWidth: 2, drawHeight: 2 }), plan = f.store.planExport(project.id, f.modRoot, project.version);
    assert.equal(plan.rows.length, 4); assert(plan.rows.some(row => /_west\.png$/.test(row.path))); assert(plan.rows.every(row => row.path.startsWith('Textures/Things/Building/')));
    assert(plan.xml.includes('<graphicClass>Graphic_Multi</graphicClass>')); assert(plan.xml.includes('<drawSize>(2,2)</drawSize>')); assert(plan.xml.includes('<size>(1,2)</size>')); assert(plan.xml.includes('<rotatable>true</rotatable>')); assert(plan.xml.includes('<allowFlip>false</allowFlip>')); assert(!plan.xml.includes('<thingClass>')); assert(!plan.xml.includes('<building>'));
    assert.equal(f.store.applyExport(plan, f.backups).files, 4);
    for (const changes of [{ graphicMode: 'single' }, { footprintZ: 3 }, { drawHeight: 3 }, { rotatable: false }]) assert.throws(() => f.store.saveRecipe(project.id, { ...project.recipe, ...changes }, project.version), /locked/);
  }
  let incomplete = f.store.create(recipe({ kind: 'building', frameCount: 1 })); incomplete = await f.store.saveGeneration(incomplete.id, staticResponse(['south', 'east', 'north']), 'Test', ['south', 'east', 'north'], incomplete.version); incomplete = f.store.approve(incomplete.id, incomplete.candidates[0].id, ['south', 'east', 'north'], incomplete.version); assert.throws(() => f.store.planExport(incomplete.id, f.modRoot, incomplete.version), /Missing: west/);
  const single = await approvedProfile(f, { kind: 'furniture', graphicMode: 'single', rotatable: true, textureName: 'Planter' }), singlePlan = f.store.planExport(single.id, f.modRoot, single.version);
  assert.equal(single.recipe.rotatable, false); assert.equal(singlePlan.rows.length, 1); assert.equal(singlePlan.rows[0].path, 'Textures/Things/Building/Planter/Planter.png'); assert(singlePlan.xml.includes('<graphicClass>Graphic_Single</graphicClass>')); assert(singlePlan.xml.includes('<rotatable>false</rotatable>')); assert(singlePlan.xml.includes('<drawRotated>false</drawRotated>'));
});

test('profile normalization ignores irrelevant fields and rejects invalid category-specific values', () => {
  const legacy = validateRecipe(recipe({ apparelLayer: 'unsafe', footprintX: -99, graphicMode: 'unsafe' })); assert.equal(legacy.apparelLayer, undefined); assert.equal(legacy.footprintX, undefined);
  assert.equal(validateRecipe(recipe({ kind: 'apparel', frameCount: 1 })).apparelLayer, 'OnSkin'); assert.equal(validateRecipe(recipe({ kind: 'hat', frameCount: 1 })).hatCoverage, 'upper');
  for (const extra of [{ graphicMode: 'unsafe' }, { footprintX: 0 }, { footprintZ: 2.5 }, { drawWidth: Infinity }, { drawHeight: 21 }, { rotatable: 'yes' }]) assert.throws(() => validateRecipe(recipe({ kind: 'building', frameCount: 1, ...extra })));
  assert.throws(() => validateRecipe(recipe({ kind: 'apparel', frameCount: 1, apparelLayer: 'Overhead' }))); assert.throws(() => validateRecipe(recipe({ kind: 'hat', frameCount: 1, hatCoverage: 'neck' })));
});

test('old 0.2.13 bird projects retain approved artwork without rewriting their recipe or metadata', async t => {
  const f = fixture(t), original = await approved(f), file = path.join(f.store.projectDir(original.id), 'project.json'), raw = JSON.parse(fs.readFileSync(file)); delete raw.archivedAt; delete raw.recipe.groundedDrawSize; fs.writeFileSync(file, JSON.stringify(raw));
  const before = fs.readFileSync(file), opened = f.store.read(original.id);
  assert.equal(opened.recipe.groundedDrawSize, 0.7); assert.deepEqual(opened.approved, original.approved); assert.deepEqual(fs.readFileSync(file), before); assert.equal(f.store.planExport(opened.id, f.modRoot, opened.version).rows.length, 27);
});

test('master image creation preserves reference versus final-slot intent and rolls back only failed new families', async t => {
  const f = fixture(t), file = path.join(f.root, 'master.png'); fs.writeFileSync(file, png());
  const reference = await f.store.importMaster(recipe({ kind: 'apparel', frameCount: 1 }), 'reference', file); assert.equal(reference.references.length, 1); assert.equal(reference.candidates.length, 0); assert.deepEqual(reference.approved, {});
  const finalSlot = await f.store.importMaster(recipe({ kind: 'hat', frameCount: 1 }), 'slot', file, 'item'); assert.equal(finalSlot.references.length, 0); assert.equal(finalSlot.candidates.length, 1); assert.deepEqual(finalSlot.approved, {}); assert.equal(finalSlot.candidates[0].directions.item.previewHash.length, 64);
  const existingBytes = fs.readFileSync(path.join(f.store.projectDir(finalSlot.id), finalSlot.candidates[0].directions.item.preview)), ids = f.store.list().map(item => item.id).sort();
  const bad = path.join(f.root, 'bad.png'); fs.writeFileSync(bad, 'not a PNG'); await assert.rejects(f.store.importMaster(recipe({ kind: 'building', frameCount: 1 }), 'reference', bad), /valid PNG/); assert.deepEqual(f.store.list().map(item => item.id).sort(), ids); assert.deepEqual(fs.readFileSync(path.join(f.store.projectDir(finalSlot.id), finalSlot.candidates[0].directions.item.preview)), existingBytes);
  await assert.rejects(f.store.importMaster(recipe({ kind: 'apparel', frameCount: 1 }), 'slot', file, 'Child_south'), /slots/); assert.deepEqual(f.store.list().map(item => item.id).sort(), ids);
  const link = path.join(f.root, 'linked-master'); fs.symlinkSync(f.root, link, 'junction'); await assert.rejects(f.store.importMaster(recipe({ kind: 'hat', frameCount: 1 }), 'reference', path.join(link, 'master.png')), /junction/); assert.deepEqual(f.store.list().map(item => item.id).sort(), ids);
});

test('archiving is reversible and blocks editing, generation and export while retaining approval history', async t => {
  const f = fixture(t), original = await approvedProfile(f, { kind: 'hat' }), imagePath = path.join(f.store.projectDir(original.id), original.candidates[0].directions.item.preview), bytes = fs.readFileSync(imagePath), reviewed = f.store.planExport(original.id, f.modRoot, original.version);
  const archived = f.store.archive(original.id, true, original.version); assert(archived.archivedAt); assert.equal(f.store.list().find(item => item.id === original.id).archivedAt, archived.archivedAt); assert.deepEqual(f.store.read(original.id).approved, original.approved); assert.deepEqual(fs.readFileSync(imagePath), bytes);
  assert.throws(() => f.store.saveRecipe(original.id, { ...archived.recipe, name: 'Changed' }, archived.version), /Restore/); assert.throws(() => f.store.prepareGeneration(original.id, ['item'], '', archived.version), /Restore/); await assert.rejects(f.store.saveGeneration(original.id, staticResponse(['item']), 'Test', ['item'], archived.version), /Restore/); await assert.rejects(f.store.importPng(original.id, 'reference', imagePath, archived.version), /Restore/); assert.throws(() => f.store.approve(original.id, original.candidates[0].id, ['item'], archived.version), /Restore/); assert.throws(() => f.store.planExport(original.id, f.modRoot, archived.version), /Restore/); assert.throws(() => f.store.applyExport(reviewed, f.backups), /changed/);
  assert.throws(() => f.store.archive(original.id, false, original.version), /changed/); const restored = f.store.archive(original.id, false, archived.version); assert.equal(restored.archivedAt, null); assert.deepEqual(restored.approved, original.approved); assert.deepEqual(fs.readFileSync(imagePath), bytes); assert.equal(f.store.planExport(restored.id, f.modRoot, restored.version).rows.length, 4);
});

test('deleting a family verifies version and ownership and preserves exported textures and backups', async t => {
  const f = fixture(t), project = await approvedProfile(f, { kind: 'building' }), plan = f.store.planExport(project.id, f.modRoot, project.version); f.store.applyExport(plan, f.backups); const target = path.join(f.modRoot, plan.rows[0].path), targetBytes = fs.readFileSync(target); f.store.applyExport(f.store.planExport(project.id, f.modRoot, project.version), f.backups); const backupNames = fs.readdirSync(f.backups);
  assert.throws(() => f.store.deleteProject(project.id, project.version - 1), /changed/); assert(fs.existsSync(f.store.projectDir(project.id))); assert.throws(() => f.store.deleteProject('../mod', project.version), /Invalid/);
  const moved = path.join(f.root, 'moved-family'); fs.renameSync(f.store.projectDir(project.id), moved); fs.symlinkSync(moved, path.join(f.studioRoot, project.id), 'junction'); assert.throws(() => f.store.deleteProject(project.id, project.version), /junction/); assert(fs.existsSync(path.join(moved, 'project.json'))); fs.unlinkSync(path.join(f.studioRoot, project.id)); fs.renameSync(moved, path.join(f.studioRoot, project.id));
  f.store.deleteProject(project.id, project.version); assert.equal(fs.existsSync(path.join(f.studioRoot, project.id)), false); assert.deepEqual(fs.readFileSync(target), targetBytes); assert.deepEqual(fs.readdirSync(f.backups), backupNames); assert.equal(f.store.list().some(item => item.id === project.id), false);
});

test('an unapproved imported bird master guides requested flight views without becoming approved output', async t => {
  const f = fixture(t), file = path.join(f.root, 'Drogon-east.png'); fs.writeFileSync(file, png());
  let project = await f.store.importMaster(recipe({ name: 'Drogon' }), 'slot', file, 'east');
  const masterArt = project.candidates[0].directions.east, masterPath = path.join(f.store.projectDir(project.id), masterArt.preview);
  assert.deepEqual(project.approved, {}); assert.equal(masterArt.frames.length, 0);
  let prepared = f.store.prepareGeneration(project.id, ['south', 'east', 'north'], 'Create the matching flight design.', project.version);
  assert.deepEqual(prepared.approvedPaths, [masterPath]); assert.equal(prepared.referencePaths.length, 0); assert(prepared.prompt.includes('Imported identity views may be unapproved')); assert.deepEqual(f.store.read(project.id).approved, {});
  assert.deepEqual(f.store.prepareGeneration(project.id, ['south'], '', project.version).approvedPaths, [masterPath]);
  project = await f.store.importPng(project.id, 'east', file, project.version); const latestPath = path.join(f.store.projectDir(project.id), project.candidates.at(-1).directions.east.preview);
  assert.deepEqual(f.store.prepareGeneration(project.id, ['east'], '', project.version).approvedPaths, [latestPath]);
  assert.deepEqual(f.store.prepareGeneration(project.id, ['south', 'east'], '', project.version).approvedPaths, [latestPath, masterPath]);
  project = f.store.approve(project.id, project.candidates[0].id, ['east'], project.version);
  assert.deepEqual(f.store.prepareGeneration(project.id, ['east'], '', project.version).approvedPaths, [masterPath]);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.store.saveGeneration(project.id, response(['east']), 'Test', ['east'], project.version, controller.signal), /cancelled/); assert.equal(f.store.read(project.id).candidates.length, 2);
  fs.writeFileSync(masterPath, png(128, true)); assert.throws(() => f.store.prepareGeneration(project.id, ['north'], '', project.version), /artwork changed/);
});

test('imported identity references retain integrity guards before approval and before cross-view fallback', async t => {
  const f = fixture(t), file = path.join(f.root, 'master.png'); fs.writeFileSync(file, png());
  const project = await f.store.importMaster(recipe(), 'slot', file, 'east'), art = project.candidates[0].directions.east;
  fs.writeFileSync(path.join(f.store.projectDir(project.id), art.preview), png(128, true));
  assert.throws(() => f.store.prepareGeneration(project.id, ['east'], '', project.version), /artwork changed/);
  assert.throws(() => f.store.prepareGeneration(project.id, ['south'], '', project.version), /artwork changed/);
  assert.deepEqual(f.store.read(project.id).approved, {});
});

test('sequential direction imports collect all views without losing earlier files or approvals', async t => {
  const f = fixture(t), file = path.join(f.root, 'master.png'); fs.writeFileSync(file, png());
  let project = f.store.create(recipe({kind:'sprite',frameCount:1}));
  project = await f.store.importPng(project.id, 'east', file, project.version);
  const first = project.candidates[0], firstArt = first.directions.east;
  project = f.store.approve(project.id, first.id, ['east'], project.version);
  project = await f.store.importPng(project.id, 'south', file, project.version);
  project = await f.store.importPng(project.id, 'north', file, project.version);
  const latest = project.candidates.at(-1);
  assert.deepEqual(Object.keys(latest.directions).sort(), ['east','north','south']);
  assert.equal(latest.directions.east.previewHash, firstArt.previewHash);
  assert.equal(project.approved.east, first.id);
  assert(fs.existsSync(path.join(f.store.projectDir(project.id),firstArt.preview)));
  assert.equal(project.candidates.length,3);
  project = f.store.approve(project.id, latest.id, ['south','north'], project.version);
  assert.equal(f.store.planExport(project.id,f.modRoot,project.version).rows.length,3);
});

test('importing one bird view preserves other rigged views and their frame provenance', async t => {
  const f = fixture(t), file = path.join(f.root, 'master.png'); fs.writeFileSync(file,png());
  let project = f.store.create(recipe());
  project = await f.store.saveGeneration(project.id,response(['south','east','north']),'Test',['south','east','north'],project.version);
  const original = project.candidates[0];
  project = await f.store.importPng(project.id,'east',file,project.version);
  const imported = project.candidates.at(-1);
  assert.equal(imported.directions.east.frames.length,0);
  assert.equal(imported.directions.south.frames.length,8);
  assert.equal(imported.directions.south.source,'generated');
  assert.deepEqual(imported.directions.south.frameHashes,original.directions.south.frameHashes);
  project = f.store.approve(project.id,imported.id,['south','north'],project.version);
  project = f.store.approve(project.id,original.id,['east'],project.version);
  assert.equal(f.store.planExport(project.id,f.modRoot,project.version).rows.length,27);
});
