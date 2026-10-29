'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');

test('bundled host and external OAuth module share cooldown, including across app restart', async () => {
  const root = path.resolve(__dirname, '..');
  const fixtureRoot = path.join(root, 'build-check');
  fs.mkdirSync(fixtureRoot, {recursive: true});
  const temporary = fs.mkdtempSync(path.join(fixtureRoot, 'atlas-claude-state-test-'));
  try {
    const stateFile = path.join(root, 'src/atlas/claude-oauth-state.cjs');
    fs.copyFileSync(stateFile, path.join(temporary, 'host-state.cjs'));
    fs.copyFileSync(stateFile, path.join(temporary, 'external-state.cjs'));
    fs.copyFileSync(stateFile, path.join(temporary, 'another-external-state.cjs'));
    fs.writeFileSync(path.join(temporary, 'host.mjs'), 'import * as state from "./host-state.cjs"; export const inspect=()=>state.read();');
    const {build} = await import(pathToFileURL(path.join(root, 'build-tools/native/node_modules/vite/dist/node/index.js')).href);
    await build({
      configFile: false, logLevel: 'silent', root,
      build: {
        outDir: path.join(temporary, 'bundle'), minify: false, target: 'node22',
        lib: {entry: path.join(temporary, 'host.mjs'), formats: ['cjs'], fileName: () => 'host.cjs'},
        rollupOptions: {external: [/^node:/]},
      },
    });
    const run = source => JSON.parse(execFileSync(process.execPath, ['-e', source], {
      env: {...process.env, ATLAS_ROOT: temporary, ATLAS_TEST_ROOT: temporary},
      encoding: 'utf8', windowsHide: true,
    }));
    const prefix = `
      const assert=require('node:assert/strict'), path=require('node:path');
      const root=process.env.ATLAS_TEST_ROOT;
      assert.equal(process.env.ATLAS_ROOT,root);
      const host=require(path.join(root,'bundle/host.cjs'));
      const external=require(path.join(root,'external-state.cjs'));
      const other=require(path.join(root,'another-external-state.cjs'));
    `;
    const first = run(prefix + `
      assert.equal(host.inspect().retryAt,0);
      assert.equal(other.read().retryAt,0);
      external.rateLimit('120',{status:429,requestId:'req_fixture',errorType:'rate_limit_error',at:Date.now()});
      assert.deepEqual(host.inspect(),external.read());
      assert.deepEqual(other.read(),external.read());
      assert(require('node:fs').existsSync(path.join(root,'data/profile/claude-oauth-status.json')),'cooldown must be saved to the portable profile');
      console.log(JSON.stringify(host.inspect()));
    `);
    assert.equal(first.retrySource, 'provider');
    assert.equal(first.diagnostic.requestId, 'req_fixture');
    assert(first.retryAt > Date.now());
    const restored = run(prefix + `
      const previous=host.inspect();
      assert.deepEqual(external.read(),previous);
      external.clear();
      assert.equal(host.inspect().retryAt,0);
      console.log(JSON.stringify(previous));
    `);
    assert.deepEqual(restored, first, 'a new process restores the exact persisted provider cooldown');
    assert.equal(run(prefix + 'console.log(JSON.stringify(host.inspect()));').retryAt, 0, 'successful clearing survives another restart');
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(fixtureRoot), 'cleanup remains inside the temporary fixture directory');
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
