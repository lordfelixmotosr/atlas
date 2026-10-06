'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');
const source = path.resolve(__dirname, '../src');
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(source, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { URL, Buffer, Set })(require, module, module.exports);
  return module.exports;
}
const { markdownImageUrl } = load('lib/markdown-image.ts');
const { resolveAssetRequest } = load('main/asset-paths.ts');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const base = path.resolve(__dirname, '../build-check/fixtures'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'chat-images-'));
  const workspace = path.join(root, 'workspace'), mod = path.join(workspace, 'Example Mod');
  const outside = path.join(root, 'outside'), registered = path.join(root, 'subscribed mod');
  for (const dir of [mod, outside, registered]) fs.mkdirSync(dir, { recursive: true });
  const image = path.join(mod, 'Tests', 'Previews', 'Colored icon #1.png');
  fs.mkdirSync(path.dirname(image), { recursive: true }); fs.writeFileSync(image, png);
  const mods = [{ source: 'workshop', folder: '123456', path: registered }];
  t.after(() => { assert(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, mod, outside, registered, image, mods };
}

test('Markdown maps mod-relative previews, Windows paths, encoded spaces, and local file URLs', () => {
  assert.equal(markdownImageUrl('Tests/Previews/ColoredActionIconsSample.png', 'abc'), 'modmixer-asset://chat/abc/Tests%2FPreviews%2FColoredActionIconsSample.png');
  assert.equal(markdownImageUrl('Tests/Colored%20icon.png', 'Example Mod'), 'modmixer-asset://chat/Example%20Mod/Tests%2FColored%20icon.png');
  const expected = 'modmixer-asset://image/C%3A%2FAtlas%2FMy%20Mod%2Ficon.png';
  assert.equal(markdownImageUrl('C:\\Atlas\\My Mod\\icon.png'), expected);
  assert.equal(markdownImageUrl('file:///C:/Atlas/My%20Mod/icon.png'), expected);
  assert.equal(markdownImageUrl('/C:/Atlas/My%20Mod/icon.png'), expected);
  assert.equal(markdownImageUrl('Example/Textures/icon.png'), 'modmixer-asset://workspace/Example%2FTextures%2Ficon.png');
});

test('Markdown permits image sources without admitting script schemes or network shares', () => {
  for (const value of ['https://example.com/icon.png', 'blob:https://example.com/id', 'modmixer-asset://preview/workshop/123456']) assert.equal(markdownImageUrl(value), value);
  assert.equal(markdownImageUrl('data:image/png;base64,' + png.toString('base64')), 'data:image/png;base64,' + png.toString('base64'));
  for (const value of ['javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'file://server/share/icon.png', '\\\\server\\share\\icon.png', 'modmixer-asset://other/file', 'C:private.png']) assert.equal(markdownImageUrl(value), '');
});

test('the protocol reads the requested preview from its mod and accepts allowed absolute files', async t => {
  const f = fixture(t);
  const relative = await resolveAssetRequest(markdownImageUrl('Tests/Previews/Colored icon #1.png', 'Example Mod'), f.workspace, f.mods);
  assert.equal(relative.filePath, fs.realpathSync(f.image)); assert.equal(relative.contentType, 'image/png'); assert.equal(relative.immutable, false);
  const absolute = await resolveAssetRequest(markdownImageUrl(f.image), f.workspace, f.mods);
  assert.equal(absolute.filePath, fs.realpathSync(f.image));
  const workspace = await resolveAssetRequest(markdownImageUrl('Example Mod/Tests/Previews/Colored icon #1.png'), f.workspace, f.mods);
  assert.equal(workspace.filePath, fs.realpathSync(f.image));
  const installed = path.join(f.registered, 'art image.png'); fs.writeFileSync(installed, png);
  assert.equal((await resolveAssetRequest(markdownImageUrl(installed), f.workspace, f.mods)).filePath, fs.realpathSync(installed));
});

test('existing registry thumbnails remain supported', async t => {
  const f = fixture(t), preview = path.join(f.registered, 'About', 'Preview.png');
  fs.mkdirSync(path.dirname(preview)); fs.writeFileSync(preview, png);
  const result = await resolveAssetRequest('modmixer-asset://preview/workshop/123456', f.workspace, f.mods);
  assert.equal(result.filePath, fs.realpathSync(preview)); assert.equal(result.immutable, true);
  assert.equal(await resolveAssetRequest('modmixer-asset://preview/workshop/missing', f.workspace, f.mods), null);
});

test('the protocol rejects outside files, traversal, malformed encoding, and non-image contents', async t => {
  const f = fixture(t), privateFile = path.join(f.outside, 'private.png'); fs.writeFileSync(privateFile, png);
  const sibling = path.join(f.workspace, 'sibling.png'); fs.writeFileSync(sibling, png);
  const text = path.join(f.mod, 'not-an-image.png'); fs.writeFileSync(text, '<html>not an image</html>');
  const json = path.join(f.mod, 'private.json'); fs.writeFileSync(json, '{}');
  for (const url of [markdownImageUrl(privateFile), markdownImageUrl('../sibling.png', 'Example Mod'),
    markdownImageUrl('../../outside/private.png', 'Example Mod'), markdownImageUrl('not-an-image.png', 'Example Mod'),
    markdownImageUrl(json), 'modmixer-asset://chat/Example%20Mod/%ZZ', 'modmixer-asset://image/%00',
    'modmixer-asset://chat/..%2Foutside/private.png', 'modmixer-asset://workspace/..%2Foutside%2Fprivate.png']) {
    assert.equal(await resolveAssetRequest(url, f.workspace, f.mods), null, url);
  }
});

test('a junction inside the workspace does not grant access to an outside image', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.outside, 'private.png'), png);
  const nestedLink = path.join(f.mod, 'linked'), folderLink = path.join(f.workspace, 'linked-mod');
  fs.symlinkSync(f.outside, nestedLink, 'junction'); fs.symlinkSync(f.outside, folderLink, 'junction');
  for (const url of [markdownImageUrl('linked/private.png', 'Example Mod'), markdownImageUrl('private.png', 'linked-mod'), markdownImageUrl(path.join(nestedLink, 'private.png'))]) assert.equal(await resolveAssetRequest(url, f.workspace, f.mods), null, url);
});
