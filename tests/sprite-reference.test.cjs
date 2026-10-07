const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');
const fixtureModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/atlas/sprite-reference.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, { exports: fixtureModule.exports, module: fixtureModule, require, Buffer });
const { readSpriteReference, MAX_SPRITE_REFERENCE_BYTES } = fixtureModule.exports;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function ownedFixture(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sprite-ref-'));
  try { await fn(directory); }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^atlas-sprite-ref-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('sprite vision receives the exact original PNG bytes and alpha encoding', async () => ownedFixture(async directory => {
  const file = path.join(directory, 'master.png'); fs.writeFileSync(file, png);
  const reference = await readSpriteReference(file);
  assert.equal(reference.image.type, 'image'); assert.equal(reference.image.mimeType, 'image/png');
  assert.equal(reference.bytes, png.length);
  assert(Buffer.from(reference.image.data, 'base64').equals(png));
  assert.equal(Buffer.from(reference.image.data, 'base64')[25], 4, 'PNG alpha color type was not preserved');
}));

test('non-PNG data, oversized inputs and invalid canvases do not reach image requests', async () => ownedFixture(async directory => {
  const file = path.join(directory, 'bad.png');
  fs.writeFileSync(file, Buffer.alloc(70)); await assert.rejects(readSpriteReference(file), /invalid PNG header/);
  const oversized = path.join(directory, 'oversized.png'); fs.writeFileSync(oversized, png); fs.truncateSync(oversized, MAX_SPRITE_REFERENCE_BYTES + 1);
  await assert.rejects(readSpriteReference(oversized), /no larger than 8 MB/);
  const badCanvas = Buffer.from(png); badCanvas.writeUInt32BE(2049, 16); fs.writeFileSync(file, badCanvas);
  await assert.rejects(readSpriteReference(file), /invalid PNG header or canvas/);
  await assert.rejects(readSpriteReference('relative.png'), /local PNG files/);
}));

test('linked reference directories and non-regular PNG paths are rejected', async () => ownedFixture(async directory => {
  const source = path.join(directory, 'source'), linked = path.join(directory, 'linked');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'master.png'), png);
  fs.symlinkSync(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readSpriteReference(path.join(linked, 'master.png')), /Linked sprite reference paths/);
  const fakeImage = path.join(directory, 'directory.png'); fs.mkdirSync(fakeImage);
  await assert.rejects(readSpriteReference(fakeImage), /valid PNG|EISDIR|EPERM/);
}));
