'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const ts = require('../build-tools/native/node_modules/typescript');
const fixtureModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/atlas/sprite-profiles.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { module: fixtureModule, exports: fixtureModule.exports });
const { getSpriteGalleryEntries } = fixtureModule.exports;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = value => String(value).repeat(24);
function art(owner, slot = 'south', extra = {}) {
  return { preview: `candidates/${owner}/${slot}-preview.png`, previewHash: hash('same-preview'), frames: Array.from({ length: 8 }, (_, index) => `candidates/${owner}/${slot}/frame-${index + 1}.png`), frameHashes: Array.from({ length: 8 }, (_, index) => hash('same-frame-' + index)), hasWingRig: true, source: 'generated', warnings: [], ...extra };
}
const candidate = (value, directions, source = 'generated') => ({ id: id(value), createdAt: '2026-10-07T00:00:00Z', model: 'Generator ' + value, source, directions });
function project(candidates) { return { id: id('f'), version: 4, createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', recipe: { name: 'Gallery fixture', kind: 'bird', canvasSize: 128, frameCount: 8, ticksPerFrame: 2, drawSize: 1.5, textureName: 'GalleryFixture', brief: 'Fixture' }, candidates, references: [], approved: {} }; }

test('all generated revisions remain in the gallery even when a regeneration has identical pixels', () => {
  const first = candidate('1', { south: art(id('1'), 'south', { originCandidateId: id('1') }) });
  const second = candidate('2', { south: art(id('2'), 'south', { originCandidateId: id('2') }) });
  const rows = getSpriteGalleryEntries(project([first, second]), second, true);
  assert.equal(rows.length, 18);
  assert.equal(rows.filter(row => row.kind === 'preview').length, 2);
  assert.equal(rows.filter(row => row.kind === 'frame').length, 16);
  assert.deepEqual([...new Set(Array.from(rows, row => row.originRevisionId))].sort(), [id('1'), id('2')]);
  assert(rows.every(row => row.source === 'generated' && !row.carried));
});

test('a new import pointing to a legacy copied view resolves to its actual generation exactly once', () => {
  const first = candidate('1', { south: art(id('1')) });
  const legacyCopy = candidate('2', { south: art(id('2')) }, 'imported');
  const newCopy = candidate('3', { south: art(id('3'), 'south', { originCandidateId: id('2') }) }, 'imported');
  const rows = getSpriteGalleryEntries(project([first, legacyCopy, newCopy]), newCopy, true);
  assert.equal(rows.length, 9);
  assert(rows.every(row => row.originRevisionId === first.id && row.model === first.model && row.source === 'generated'));
  assert.deepEqual(Array.from(rows.filter(row => row.kind === 'frame'), row => row.frame), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('partial selected revisions display their earlier working views without inventing mirrored west files', () => {
  const first = candidate('1', Object.fromEntries(['south', 'east', 'north'].map(slot => [slot, art(id('1'), slot, { originCandidateId: id('1') })])));
  const second = candidate('2', { south: art(id('2'), 'south', { originCandidateId: id('2') }) });
  const rows = getSpriteGalleryEntries(project([first, second]), second, false);
  assert.equal(rows.length, 27);
  assert.deepEqual([...new Set(Array.from(rows, row => row.slot))], ['south', 'east', 'north']);
  assert(rows.filter(row => row.slot !== 'south').every(row => row.originRevisionId === first.id));
  assert(rows.filter(row => row.slot === 'south').every(row => row.originRevisionId === second.id));
});

test('legacy generated revisions keep their own history and imported static artwork remains distinguishable', () => {
  const first = candidate('1', { south: art(id('1')) });
  const identicalLegacyGeneration = candidate('2', { south: art(id('2')) });
  const imported = candidate('3', { east: art(id('3'), 'east', { frames: [], frameHashes: [], hasWingRig: false, source: 'imported', originCandidateId: id('3') }) }, 'imported');
  const rows = getSpriteGalleryEntries(project([first, identicalLegacyGeneration, imported]), imported, true);
  assert.equal(rows.length, 19);
  assert.equal(rows.filter(row => row.source === 'generated').length, 18);
  assert.equal(rows.filter(row => row.source === 'imported').length, 1);
});
