'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/main/asset-paths.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const moduleObject = { exports: {} };
vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { URL, Buffer, Set })(require, moduleObject, moduleObject.exports);
const { resolveAssetRequest } = moduleObject.exports;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
test('studio PNG protocol confines candidate and reference reads to their family', async t => {
  const base = path.resolve(__dirname, '../build-check/fixtures'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'sprite-images-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const studio = path.join(root, 'studio'), id = '111111111111111111111111';
  const family = path.join(studio, id), outside = path.join(root, 'outside');
  fs.mkdirSync(family, { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(family, 'preview.png'), png); fs.writeFileSync(path.join(outside, 'private.png'), png);
  const url = relative => 'modmixer-asset://studio/' + id + '/' + encodeURIComponent(relative);
  const asset = await resolveAssetRequest(url('preview.png'), root, [], studio);
  assert.equal(asset.filePath, path.join(family, 'preview.png')); assert.equal(asset.immutable, true);
  assert.equal(await resolveAssetRequest(url('preview.png'), root, []), null);
  for (const relative of ['../outside/private.png', '../../outside/private.png', path.join(outside, 'private.png'), 'preview.png:secret']) {
    assert.equal(await resolveAssetRequest(url(relative), root, [], studio), null);
  }
  fs.symlinkSync(outside, path.join(family, 'linked'), 'junction');
  assert.equal(await resolveAssetRequest(url('linked/private.png'), root, [], studio), null);
  fs.symlinkSync(outside, path.join(studio, '222222222222222222222222'), 'junction');
  assert.equal(await resolveAssetRequest('modmixer-asset://studio/222222222222222222222222/private.png', root, [], studio), null);
});
