'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm'), zlib = require('node:zlib');
const ts = require('../build-tools/native/node_modules/typescript');
const sourceRoot = path.resolve(__dirname, '../src');
const resvg = require('../build-tools/native/node_modules/@resvg/resvg-wasm');
let initialized;
async function rasterizeSvg(svg, opts) {
  initialized ??= resvg.initWasm(fs.readFileSync(path.join(path.dirname(require.resolve('../build-tools/native/node_modules/@resvg/resvg-wasm')), 'index_bg.wasm'))); await initialized;
  const renderer = new resvg.Resvg(svg, opts), rendered = renderer.render();
  try { return { png: Buffer.from(rendered.asPng()), width: rendered.width, height: rendered.height }; } finally { rendered.free?.(); renderer.free?.(); }
}
const nativeImage = {
  createFromBuffer(bytes) {
    const valid = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    return { isEmpty: () => !valid, getSize: () => valid ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : { width: 0, height: 0 }, toPNG: () => Buffer.from(bytes), resize() { throw new Error('Fixture image should not need resizing'); } };
  },
};
function load(relative, imports = {}, extra = '') {
  const module = { exports: {} }, source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const requireFor = name => name in imports ? imports[name] : name.startsWith('node:') ? require(name) : {};
  vm.runInNewContext('(function(require,module,exports){' + compiled + '\n' + extra + '\n})', { Buffer, URL, Set, Map, Date, console, process, setTimeout, clearTimeout })(requireFor, module, module.exports);
  return module.exports;
}
const normalizer = load('agent/assets/preview-normalize.ts', { electron: { nativeImage } });
const preview = load('agent/assets/workshop-preview.ts', { './preview-normalize.js': normalizer, '../tools/lib/resvg-init.js': { rasterizeSvg } });
function animatedGif(width = 16, height = 16, frames = 2) {
  const header = Buffer.alloc(13); header.write('GIF89a'); header.writeUInt16LE(width, 6); header.writeUInt16LE(height, 8); header[10] = 0x81;
  const palette = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255]), chunks = [header, palette];
  for (let frame = 0; frame < frames; frame++) {
    chunks.push(Buffer.from('21f9040802000000', 'hex'));
    const descriptor = Buffer.alloc(10); descriptor[0] = 0x2c; descriptor.writeUInt16LE(width, 5); descriptor.writeUInt16LE(height, 7); chunks.push(descriptor, Buffer.from([2]));
    const codes = []; for (let pixel = 0; pixel < width * height; pixel++) codes.push(4, frame % 2 + 1); codes.push(5);
    const compressed = Buffer.alloc(Math.ceil(codes.length * 3 / 8)); let offset = 0;
    for (const code of codes) { for (let bit = 0; bit < 3; bit++) if ((code >> bit) & 1) compressed[(offset + bit) >> 3] |= 1 << ((offset + bit) & 7); offset += 3; }
    for (let pos = 0; pos < compressed.length; pos += 255) { const part = compressed.subarray(pos, pos + 255); chunks.push(Buffer.from([part.length]), part); } chunks.push(Buffer.from([0]));
  }
  chunks.push(Buffer.from([0x3b])); return Buffer.concat(chunks);
}
function fixture(t) {
  const base = path.resolve(__dirname, '../build-check/fixtures'); fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'workshop-preview-'));
  const workspace = path.join(root, 'workspace'), mod = path.join(workspace, 'Example'), about = path.join(mod, 'About'); fs.mkdirSync(about, { recursive: true });
  const store = load('agent/assets/store.ts', { '../workspace.js': { getWorkspacePaths: () => ({ workspaceDir: workspace }) }, './preview-normalize.js': normalizer, './workshop-preview.js': preview, '../mod-metadata.js': { metadataReadPath: (dir, rel) => path.join(path.dirname(dir), '.atlas', rel), metadataWritePath: (dir, rel) => path.join(path.dirname(dir), '.atlas', rel) } });
  t.after(() => { assert(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, mod, about, store, png: path.join(about, 'Preview.png'), gif: path.join(about, 'WorkshopPreview.gif') };
}
function pngPixels(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), parts = []; let offset = 8;
  while (offset + 12 <= bytes.length) { const size = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8); if (kind === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  const raw = zlib.inflateSync(Buffer.concat(parts)), channels = bytes[25] === 6 ? 4 : 3, widthBytes = width * channels, pixels = Buffer.alloc(widthBytes * height); let previous = Buffer.alloc(widthBytes);
  for (let y = 0; y < height; y++) { const filter = raw[y * (widthBytes + 1)], row = Buffer.from(raw.subarray(y * (widthBytes + 1) + 1, (y + 1) * (widthBytes + 1))); for (let x = 0; x < widthBytes; x++) { const a = x >= channels ? row[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0; let p = 0; if (filter === 1) p = a; else if (filter === 2) p = b; else if (filter === 3) p = Math.floor((a + b) / 2); else if (filter === 4) { const candidate = a + b - c, pa = Math.abs(candidate - a), pb = Math.abs(candidate - b), pc = Math.abs(candidate - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } row[x] = (row[x] + p) & 255; } row.copy(pixels, y * widthBytes); previous = row; }
  return { width, height, pixels, channels };
}

test('the real raster backend extracts the first GIF frame while retaining all original animation bytes', async () => {
  const gif = animatedGif(), info = preview.inspectWorkshopGif(gif); assert.equal(info.frames, 2); assert.equal(info.width, 16); assert.equal(info.height, 16);
  const prepared = await preview.prepareWorkshopPreviewBuffer(gif); assert.deepEqual(prepared.gif, gif); assert.equal(prepared.width, 16); assert.equal(prepared.height, 16);
  const image = pngPixels(prepared.png); assert.deepEqual([...image.pixels.subarray(0, 3)], [255, 0, 0]); assert(prepared.png.length < 1024 * 1024);
});

test('ordinary encoder GIFs with growing compression dictionaries and multiple frames remain accepted', async () => {
  const sharp = require('../build-tools/native/node_modules/sharp'), width = 64, frameHeight = 64, pixels = Buffer.alloc(width * frameHeight * 2 * 4);
  for (let frame = 0; frame < 2; frame++) for (let y = 0; y < frameHeight; y++) for (let x = 0; x < width; x++) { const index = ((frame * frameHeight + y) * width + x) * 4; pixels[index] = frame ? (x * 4) : 240; pixels[index + 1] = frame ? 220 : y * 4; pixels[index + 2] = (x * 17 + y * 23) % 256; pixels[index + 3] = 255; }
  const gif = await sharp(pixels, { raw: { width, height: frameHeight * 2, pageHeight: frameHeight, channels: 4 } }).gif({ colours: 64, dither: 0, loop: 0, delay: [80, 80] }).toBuffer();
  const info = preview.inspectWorkshopGif(gif); assert.equal(info.frames, 2); assert.equal(info.width, width); assert.equal(info.height, frameHeight);
  const prepared = await preview.prepareWorkshopPreviewBuffer(gif); assert.deepEqual(prepared.gif, gif); assert.equal(pngPixels(prepared.png).width, width); assert.equal(pngPixels(prepared.png).height, frameHeight);
});

test('preview import writes animated GIF plus a static PNG and both preview UI and publisher select the GIF', async t => {
  const f = fixture(t), gif = animatedGif(), source = path.join(f.root, 'animated.gif'); fs.writeFileSync(source, gif); await f.store.setPreviewImageFile('Example', source);
  assert.deepEqual(fs.readFileSync(f.gif), gif); assert.deepEqual([...pngPixels(fs.readFileSync(f.png)).pixels.subarray(0, 3)], [255, 0, 0]);
  assert.equal(preview.selectWorkshopPreviewPath(f.mod), f.gif); assert.equal(f.store.readPreviewImageDataUrl('Example'), 'data:image/gif;base64,' + gif.toString('base64'));
  const workshop = load('agent/rimworld/workshop.ts', { '../workspace.js': { getWorkspacePaths: () => ({ workspaceDir: f.workspace }) }, '../assets/preview-normalize.js': normalizer, '../assets/workshop-preview.js': preview }, 'module.exports.previewPathFor = previewPathFor;');
  assert.equal(workshop.previewPathFor('Example'), f.gif); assert.throws(() => workshop.previewPathFor('../Example'), /Invalid/);
});

test('oversized, truncated, corrupt and out-of-canvas GIFs leave existing previews unchanged', async t => {
  const f = fixture(t), original = animatedGif(), file = path.join(f.root, 'source.gif'); fs.writeFileSync(file, original); await f.store.setPreviewImageFile('Example', file); const pngBefore = fs.readFileSync(f.png), gifBefore = fs.readFileSync(f.gif);
  const outOfBounds = Buffer.from(original); outOfBounds.writeUInt16LE(4096, 6); const badFrame = Buffer.from(original), descriptor = badFrame.indexOf(0x2c, 25); badFrame.writeUInt16LE(17, descriptor + 5);
  const corrupt = Buffer.from(original); corrupt[descriptor + 12] = 0xff;
  for (const bad of [Buffer.concat([original, Buffer.alloc(1024 * 1024)]), original.subarray(0, original.length - 1), Buffer.from('GIF89a'), outOfBounds, badFrame, corrupt, animatedGif(1, 1, 201)]) {
    fs.writeFileSync(file, bad); await assert.rejects(f.store.setPreviewImageFile('Example', file)); assert.deepEqual(fs.readFileSync(f.png), pngBefore); assert.deepEqual(fs.readFileSync(f.gif), gifBefore);
  }
  assert.equal(preview.selectWorkshopPreviewPath(f.mod), f.gif);
});

test('static replacement clears a stale GIF only after the PNG is committed and keeps originals in private backups', async t => {
  const f = fixture(t), gifSource = path.join(f.root, 'animated.gif'); fs.writeFileSync(gifSource, animatedGif()); await f.store.setPreviewImageFile('Example', gifSource);
  const originalGif = fs.readFileSync(f.gif), originalPng = fs.readFileSync(f.png), staticSource = path.join(f.root, 'static.png'); fs.writeFileSync(staticSource, originalPng);
  await f.store.setPreviewImageFile('Example', staticSource); assert.equal(fs.existsSync(f.gif), false); assert.equal(preview.selectWorkshopPreviewPath(f.mod), f.png); assert(f.store.readPreviewImageDataUrl('Example').startsWith('data:image/png;'));
  const backupRoot = path.join(f.root, '.atlas', 'preview-import-backups', 'Example'), backups = fs.readdirSync(backupRoot); assert.equal(backups.length, 1); assert.deepEqual(fs.readFileSync(path.join(backupRoot, backups[0], 'WorkshopPreview.gif')), originalGif); assert.deepEqual(fs.readFileSync(path.join(backupRoot, backups[0], 'Preview.png')), originalPng);
  assert.equal(fs.existsSync(path.join(f.mod, '.atlas')), false);
});

test('a failed GIF or static commit restores original bytes and keeps the original GIF selection', async t => {
  const f = fixture(t), file = path.join(f.root, 'animated.gif'); fs.writeFileSync(file, animatedGif()); await f.store.setPreviewImageFile('Example', file); const beforePng = fs.readFileSync(f.png), beforeGif = fs.readFileSync(f.gif), rename = fsp.rename, unlink = fsp.unlink;
  let failed = false; fsp.rename = async (from, to) => { if (!failed && to === f.gif) { failed = true; throw new Error('Simulated locked GIF'); } return rename(from, to); };
  try { await assert.rejects(f.store.setPreviewImageFile('Example', file), /locked GIF/); } finally { fsp.rename = rename; }
  assert.deepEqual(fs.readFileSync(f.png), beforePng); assert.deepEqual(fs.readFileSync(f.gif), beforeGif); assert.equal(preview.selectWorkshopPreviewPath(f.mod), f.gif);
  const staticSource = path.join(f.root, 'static.png'); fs.writeFileSync(staticSource, beforePng); failed = false; fsp.unlink = async filename => { if (!failed && filename === f.gif) { failed = true; throw new Error('Simulated locked GIF removal'); } return unlink(filename); };
  try { await assert.rejects(f.store.setPreviewImageFile('Example', staticSource), /locked GIF removal/); } finally { fsp.unlink = unlink; }
  assert.deepEqual(fs.readFileSync(f.png), beforePng); assert.deepEqual(fs.readFileSync(f.gif), beforeGif); assert.equal(preview.selectWorkshopPreviewPath(f.mod), f.gif);
});

test('direct generation of a newer Preview.png supersedes an older GIF for UI and Steam upload', async t => {
  const f = fixture(t), file = path.join(f.root, 'animated.gif'); fs.writeFileSync(file, animatedGif()); await f.store.setPreviewImageFile('Example', file);
  const later = new Date(fs.statSync(f.gif).mtimeMs + 1000); fs.utimesSync(f.png, later, later); assert.equal(preview.selectWorkshopPreviewPath(f.mod), f.png); assert(f.store.readPreviewImageDataUrl('Example').startsWith('data:image/png;')); assert.equal(fs.existsSync(f.gif), true);
});

test('preview paths reject traversal and linked source, About directory and destination files', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); const source = path.join(outside, 'preview.gif'); fs.writeFileSync(source, animatedGif());
  const linked = path.join(f.root, 'linked'); fs.symlinkSync(outside, linked, 'junction'); await assert.rejects(f.store.setPreviewImageFile('Example', path.join(linked, 'preview.gif')), /junction/); await assert.rejects(f.store.setPreviewImageFile('../Example', source), /Invalid/);
  fs.rmSync(f.about, { recursive: true }); fs.symlinkSync(outside, f.about, 'junction'); await assert.rejects(f.store.setPreviewImageFile('Example', source), /junction/); assert.throws(() => preview.selectWorkshopPreviewPath(f.mod), /junction/); assert.equal(fs.readdirSync(outside).length, 1);
});

test('Workshop GIF picking is separate from the PNG-only RimWorld texture picker', async () => {
  const handlers = new Map(), filters = [];
  const dialog = { showOpenDialog: async (_window, options) => { filters.push(options.filters); return { canceled: true, filePaths: [] }; } };
  const routes = load('main/routes/assets.ts', { electron: { dialog } }); routes.registerAssetsRoutes({ ipc: { handle: (name, fn) => handlers.set(name, fn) }, getWindow: () => ({}) });
  await handlers.get('atlas:assets:pick-preview-image')({}); await handlers.get('modmixer:assets:pick-file')({}, 'texture');
  assert.deepEqual(Array.from(filters[0][0].extensions), ['png', 'jpg', 'jpeg', 'gif']); assert.deepEqual(Array.from(filters[1][0].extensions), ['png']);
});
