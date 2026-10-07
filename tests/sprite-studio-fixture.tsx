// @ts-nocheck
// Real Sprite Studio component and real native asset protocol; provider calls are mocked.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SpriteStudio } from '../src/atlas/sprite-studio';

const input = window.__atlasSpriteSnapshot;
if (!input?.project || !input?.plan) throw new Error('Native sprite snapshot is missing');
const clone = value => JSON.parse(JSON.stringify(value));
let project = clone(input.project), taskListeners = [], pending, taskState = [], applyCalls = 0, generateCalls = 0, approveCalls = 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => { const deadline = Date.now() + 10000; while (!check() && Date.now() < deadline) await wait(50); assert(check(), message); };
const emit = value => { taskState = value; for (const listener of taskListeners) listener(value); };
const summary = () => ({ id: project.id, name: project.recipe.name, kind: project.recipe.kind, updatedAt: project.updatedAt, approvedCount: Object.keys(project.approved).length, preview: project.candidates[0].directions.south.preview });
window.modmixer = {
  spriteList: async () => [summary()], spriteRead: async () => clone(project),
  spriteCreate: async () => { throw new Error('No unexpected create'); },
  spriteSaveRecipe: async (_id, recipe, version) => { assert(version === project.version, 'Recipe version changed'); project.recipe = clone(recipe); project.version++; return clone(project); },
  spriteImport: async () => null, spriteReveal: async () => {},
  spriteApprove: async (_id, candidate, directions, version) => { assert(version === project.version, 'Approval version changed'); for (const direction of directions) project.approved[direction] = candidate; project.version++; approveCalls++; return clone(project); },
  spriteGenerate: request => { generateCalls++; assert(request.model.provider === 'openai-codex', 'Selected model was not sent'); emit([{ id: 'sprite:' + project.id, projectId: project.id, kind: 'sprite', status: 'running', phase: 'Fixture candidate in progress' }]); return new Promise((resolve, reject) => { pending = { resolve, reject }; }); },
  spriteCancel: async () => { emit([]); pending?.reject(new Error('Sprite generation stopped or timed out. Your approved artwork is preserved.')); pending = null; },
  spriteExportPlan: async () => clone(input.plan), spriteExportApply: async token => { assert(token === input.plan.token, 'Unreviewed export token'); applyCalls++; return { files: input.plan.rows.length, backup: null }; },
  atlasTasksStatus: async () => taskState, onAtlasTasksState: listener => { taskListeners.push(listener); return () => { taskListeners = taskListeners.filter(item => item !== listener); }; },
};
const root = createRoot(document.getElementById('root'));
root.render(<SpriteStudio mods={[{ folder: 'atlas-sprite-fixture', title: 'Atlas verification mod', game: 'rimworld' }]} models={[{ key: 'openai-codex/fixture-model', provider: 'openai-codex', providerLabel: 'ChatGPT', modelId: 'fixture-model', label: 'Fixture model', vision: true }]} onConnect={() => { throw new Error('No live sign-in'); }} />);
function button(text) { return [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text); }
function setSelect(selector, value) { const element = document.querySelector(selector); assert(element, 'Missing select: ' + selector); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('change', { bubbles: true })); }
async function tab(name) { document.getElementById('sprite-tab-' + name).click(); await wait(100); }
async function images() { for (const image of document.querySelectorAll('.sprite-art')) { await image.decode(); assert(image.naturalWidth === 128 && image.naturalHeight === 128, 'Sprite PNG did not load at locked canvas size'); } }
window.__atlasSpriteTest = {
  async open() { await until(() => document.querySelector('.sprite-family'), 'Saved family is missing'); document.querySelector('.sprite-family').click(); await until(() => document.querySelector('.sprite-workspace'), 'Sprite workspace did not open'); await images(); },
  async run() {
    await this.open();
    assert(document.querySelector('#sprite-recipe-palette').disabled, 'Identity palette is not locked after artwork');
    assert(document.querySelector('#sprite-revision').options.length === 3, 'Immutable revision history is missing');
    const west = document.querySelector('.sprite-mirrored .sprite-art');
    assert(getComputedStyle(west).transform.startsWith('matrix(-1'), 'West preview is not mirrored east');
    await tab('animation'); await images();
    assert(document.querySelector('.sprite-animation').textContent.includes('0.30s loop'), 'Native eight-plus-one flight timing is missing');
    assert(document.querySelectorAll('.sprite-flight-grid .sprite-art').length === 4, 'Flight does not compare all three directions and mirrored west');
    for (let frame = 0; frame < 7; frame++) { document.querySelector('[aria-label="Next flight frame"]').click(); await wait(25); }
    assert(document.querySelector('.sprite-playback').textContent.includes('8 / 8 frames'), 'Flight frame stepping is incorrect');
    assert(document.querySelector('.sprite-art').getAttribute('src').includes('frame-8.png'), 'Flight preview does not use individual numbered PNGs');
    assert([...document.querySelectorAll('.sprite-flight-grid .sprite-art')].every(image => image.getAttribute('src').includes('frame-8.png')), 'Flight directions do not share the same frame');
    document.querySelector('[aria-label="Play flight preview"]').click(); await wait(150);
    assert(document.querySelector('[aria-label="Pause flight preview"]'), 'Flight preview does not play');
    document.querySelector('[aria-label="Pause flight preview"]').click(); await wait(50);
    // Drive the actual AnimationPanel clock at game tick boundaries, including
    // its extra final-frame hold, rather than relying only on the displayed text.
    const originalInterval = window.setInterval, originalClear = window.clearInterval;
    const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
    let clock = 1000, playback;
    try {
      Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
      window.setInterval = callback => { playback = callback; return 123456; };
      window.clearInterval = id => { if (id !== 123456) originalClear(id); };
      document.querySelector('[aria-label="Play flight preview"]').click();
      await until(() => playback, 'Animation did not schedule its clock');
      for (const [tick, expected] of [[0, 1], [2, 2], [14, 8], [16, 8], [17, 8], [18, 1]]) {
        clock = 1000 + (tick + 0.01) * 1000 / 60; playback(); await wait(30);
        assert([...document.querySelectorAll('.sprite-flight-grid .sprite-art')].every(image => image.getAttribute('src').includes('frame-' + expected + '.png')), 'Native animation timing differs at tick ' + tick);
      }
      document.querySelector('[aria-label="Pause flight preview"]').click(); await wait(30);
    } finally {
      window.setInterval = originalInterval; window.clearInterval = originalClear;
      if (originalNow) Object.defineProperty(performance, 'now', originalNow); else delete performance.now;
    }
    await tab('compare'); await images();
    assert(document.querySelectorAll('.sprite-compare .sprite-art').length === 2, 'Approved and selected revision are not shown together');
    const approvedBefore = project.approved.south;
    button('Use this revision').click(); await until(() => approveCalls === 1 && button('Use this revision')?.disabled, 'Revision approval did not complete');
    assert(project.approved.south !== approvedBefore && project.candidates.length === 2, 'Approval did not preserve older revisions');
    setSelect('#sprite-revision', project.candidates[0].id); await wait(100);
    button('Use this revision').click(); await until(() => approveCalls === 2, 'Earlier approved revision could not be restored');
    assert(project.approved.south === approvedBefore, 'Restoring an earlier revision failed');
    await tab('directions');
    const generation = [...document.querySelectorAll('button')].find(node => /^Generate 1 direction$/.test(node.textContent.trim()));
    assert(generation && !generation.disabled, 'Generation action is unavailable with a configured model'); generation.click();
    await until(() => button('Stop'), 'Generation has no Stop control'); button('Stop').click();
    await until(() => document.querySelector('[role="alert"]')?.textContent.includes('stopped'), 'Cancellation is not reported');
    assert(project.approved.south === approvedBefore && applyCalls === 0, 'Cancelled generation changed approved or exported artwork');
    document.querySelector('[aria-label="Dismiss Sprite Studio error"]').click();
    setSelect('[aria-label="Target RimWorld mod"]', 'atlas-sprite-fixture'); await wait(50);
    button('Preview export').click(); await until(() => document.querySelector('.sprite-export-preview'), 'Reviewed export plan is missing');
    assert(document.querySelectorAll('.sprite-export-rows>div').length === 27, 'Reviewed export does not list every PNG');
    assert(applyCalls === 0, 'Opening the export preview applied files automatically');
    assert(document.querySelector('.sprite-export-preview').textContent.includes('not been'), 'Export lacks honest game-test evidence');
    button('Export approved PNGs').click(); await until(() => applyCalls === 1, 'Explicit export action did not apply the reviewed token');
    return { directionsLoaded: true, mirroredWest: true, individualFlightFrames: true, nativeFlightTiming: true, animationPlays: true, comparisonLoaded: true, identityLocked: true, historyRetained: true, restoredEarlierRevision: true, cancellationPreservesApproval: true, reviewedExportOnly: true, providerCalls: generateCalls, paidProviderRequests: 0 };
  },
  async state(name) { if (name === 'export') { await tab('directions'); button('Preview export').click(); await until(() => document.querySelector('.sprite-export-preview'), 'Export screenshot preview is missing'); } else { button('Close preview')?.click(); await tab(name); } await images(); document.querySelector('.sprite-workspace-scroll').scrollTop = name === 'export' ? 100000 : 0; document.querySelector('.atlas-sprite-studio').scrollTop = 0; await wait(100); },
  async layout() {
    await wait(100);
    assert(document.documentElement.scrollWidth <= window.innerWidth + 1, 'Sprite Studio overflowed the viewport horizontally');
    const studio = document.querySelector('.atlas-sprite-studio'), workspace = document.querySelector('.sprite-workspace');
    assert(studio.scrollWidth <= studio.clientWidth + 1, 'Sprite Studio content overflowed horizontally');
    const workspaceBox = workspace.getBoundingClientRect(); assert(workspaceBox.width > 120, 'Sprite workspace is too narrow');
    const panes = [...document.querySelectorAll('.sprite-family-pane,.sprite-workspace,.sprite-inspector')].map(node => { const box = node.getBoundingClientRect(); return { name: node.className, x: box.x, y: box.y, width: box.width, height: box.height }; });
    for (let first = 0; first < panes.length; first++) for (let second = first + 1; second < panes.length; second++) {
      const a = panes[first], b = panes[second]; const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert(overlapX <= 1 || overlapY <= 1, 'Sprite Studio panes overlap: ' + a.name + ' and ' + b.name);
    }
    return { width: window.innerWidth, noHorizontalOverflow: true, noPaneOverlap: true, panes };
  },
  close() { root.unmount(); },
};
