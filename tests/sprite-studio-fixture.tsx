// @ts-nocheck
// Real Sprite Studio component and real native asset protocol; provider calls are mocked.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SpriteStudio } from '../src/atlas/sprite-studio';
import { AppDialog } from '../src/components/app-dialog';
import { getSpriteSlots } from '../src/atlas/sprite-profiles';

const input = window.__atlasSpriteSnapshot;
if (!input?.project || !input?.plan) throw new Error('Native sprite snapshot is missing');
const clone = value => JSON.parse(JSON.stringify(value));
const projects = new Map([input.project, ...Object.values(input.profiles ?? {}), input.master, input.importedSlot, input.importSequence, input.partialProject, input.disposable].filter(Boolean).map(value => [value.id, clone(value)]));
// Replicate existing 0.2.13 singleton imports without changing native files.
const legacyImports = projects.get(input.importSequence.id);
legacyImports.candidates.forEach((candidate, index) => { const slot = ['east', 'south', 'north'][index]; candidate.directions = { [slot]: candidate.directions[slot] }; });
let project = projects.get(input.project.id), taskListeners = [], pending, taskState = [], applyCalls = 0, generateCalls = 0, approveCalls = 0, deleteCalls = 0, masterCalls = 0, lastGeneration, lastApproval;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => { const deadline = Date.now() + 10000; while (!check() && Date.now() < deadline) await wait(50); assert(check(), message); };
const emit = value => { taskState = value; for (const listener of taskListeners) listener(value); };
const progressStage = (stage, completed, total, direction, frame) => emit([{ id: 'sprite:' + project.id, projectId: project.id, kind: 'sprite', status: 'running', phase: stage === 'designing' ? 'Designing selected views with your model' : stage === 'saving' ? 'Saving the completed revision' : stage === 'rendering' ? `Rendering PNGs · ${completed} of ${total}` : 'Preparing saved artwork', fraction: stage === 'rendering' && total ? completed / total : null, spriteProgress: { stage, completed, total, direction, frame } }]);
const summary = value => ({ id: value.id, name: value.recipe.name, kind: value.recipe.kind, updatedAt: value.updatedAt, archivedAt: value.archivedAt, approvedCount: Object.keys(value.approved).length, requiredCount: getSpriteSlots(value.recipe).length, preview: Object.values(value.candidates[0]?.directions ?? {})[0]?.preview ?? null });
const plans = new Map([input.plan, ...Object.values(input.profilePlans ?? {})].map(value => [value.token, value]));
window.modmixer = {
  spriteList: async () => [...projects.values()].map(summary), spriteRead: async id => { project = projects.get(id); assert(project, 'Unknown fixture family'); return clone(project); },
  spriteCreate: async () => { throw new Error('No unexpected create'); },
  spriteCreateFromMaster: async () => { masterCalls++; return null; },
  spriteSaveRecipe: async (_id, recipe, version) => { assert(version === project.version, 'Recipe version changed'); project.recipe = clone(recipe); project.version++; return clone(project); },
  spriteImport: async () => null, spriteReveal: async () => {},
  spriteApprove: async (_id, candidate, directions, version) => { assert(version === project.version, 'Approval version changed'); lastApproval = { candidate, directions }; for (const direction of directions) project.approved[direction] = candidate; project.version++; approveCalls++; return clone(project); },
  spriteGenerate: request => { generateCalls++; lastGeneration = clone(request); assert(request.model.provider === 'openai-codex', 'Selected model was not sent'); progressStage('preparing', 0, 0); return new Promise((resolve, reject) => { pending = { resolve, reject }; }); },
  spriteCancel: async () => { emit([]); pending?.reject(new Error('Sprite generation stopped or timed out. Your approved artwork is preserved.')); pending = null; },
  spriteExportPlan: async id => clone(id === input.project.id ? input.plan : input.profilePlans[projects.get(id).recipe.kind]), spriteExportApply: async token => { assert(plans.has(token), 'Unreviewed export token'); applyCalls++; return { files: plans.get(token).rows.length, backup: null }; },
  spriteArchive: async (id, archived, version) => { const value = projects.get(id); assert(version === value.version, 'Archive version changed'); value.archivedAt = archived ? new Date().toISOString() : null; value.version++; return clone(value); },
  spriteDelete: async (id, version) => { assert(projects.get(id).version === version, 'Delete version changed'); projects.delete(id); deleteCalls++; },
  atlasTasksStatus: async () => taskState, onAtlasTasksState: listener => { taskListeners.push(listener); return () => { taskListeners = taskListeners.filter(item => item !== listener); }; },
};
const root = createRoot(document.getElementById('root'));
root.render(<><SpriteStudio mods={[{ folder: 'atlas-sprite-fixture', title: 'Atlas verification mod', game: 'rimworld' }]} models={[{ key: 'openai-codex/fixture-model', provider: 'openai-codex', providerLabel: 'ChatGPT', modelId: 'fixture-model', label: 'Fixture model', vision: true }]} onConnect={() => { throw new Error('No live sign-in'); }} /><AppDialog /></>);
function button(text) { return [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text); }
function setSelect(selector, value) { const element = document.querySelector(selector); assert(element, 'Missing select: ' + selector); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('change', { bubbles: true })); }
function setText(selector, value) { const element = document.querySelector(selector); assert(element, 'Missing input: ' + selector); const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }
async function tab(name) { document.getElementById('sprite-tab-' + name).click(); await wait(100); }
async function images() { for (const image of document.querySelectorAll('.sprite-art')) { await image.decode(); assert(image.naturalWidth === 128 && image.naturalHeight === 128, 'Sprite PNG did not load at locked canvas size'); } }
async function openFamily(value) { setSelect('[aria-label="Sprite family list"]', 'active'); await wait(50); const family = [...document.querySelectorAll('.sprite-family')].find(node => node.textContent.includes(value.recipe.name)); assert(family, 'Missing profile family: ' + value.recipe.kind); family.click(); await until(() => document.querySelector('.sprite-project-heading h2')?.textContent === value.recipe.name, 'Selected profile did not open'); await images(); }
function fitGuide() { const input = [...document.querySelectorAll('.sprite-display-tools label')].find(node => node.textContent.includes('Schematic fit guide'))?.querySelector('input'); assert(input, 'Profile lacks fit guide control'); if (!input.checked) input.click(); }
async function selectDirections(slots) { const inputs = [...document.querySelectorAll('[data-sprite-design-direction]')]; assert(inputs.length >= slots.length, 'Visible design direction selection is missing'); for (const input of inputs) { if (input.checked !== slots.includes(input.value)) { input.click(); await wait(25); } } assert([...document.querySelectorAll('[data-sprite-design-direction]:checked')].map(node => node.value).join(',') === slots.join(','), 'Visible design direction selection did not update'); }
async function galleryCount() {
  const collected = [];
  for (;;) {
    const cards = [...document.querySelectorAll('[data-sprite-gallery-card]')]; assert(cards.length <= 36, 'Gallery exceeded its bounded page size');
    collected.push(...cards.map(card => ({ slot: card.dataset.gallerySlot, kind: card.dataset.galleryKind, frame: card.dataset.galleryFrame, revision: card.dataset.galleryRevision, src: card.querySelector('img')?.getAttribute('src') })));
    const next = [...document.querySelectorAll('[aria-label="Gallery pages"] button')].find(node => node.textContent === 'Next');
    if (!next || next.disabled) break;
    const previous = document.querySelector('[aria-label="Gallery pages"]').textContent; next.click(); await until(() => document.querySelector('[aria-label="Gallery pages"]').textContent !== previous, 'Gallery pagination did not advance');
  }
  return collected;
}
window.__atlasSpriteTest = {
  async open() { await until(() => document.querySelector('.sprite-family'), 'Saved family is missing'); document.querySelector('.sprite-family').click(); await until(() => document.querySelector('.sprite-workspace'), 'Sprite workspace did not open'); await images(); },
  async run() {
    await this.open();
    assert(!document.querySelector('#sprite-recipe-palette') && !document.querySelector('#sprite-new-palette'), 'Removed palette controls are still displayed');
    assert(document.querySelector('#sprite-recipe-canvas').disabled, 'Canvas is not locked after artwork');
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
    await selectDirections(['south']);
    const generation = document.querySelector('[data-sprite-design-primary]');
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
    const profileUi = {};
    for (const [kind, value] of Object.entries(input.profiles)) {
      await openFamily(value);
      assert(!document.getElementById('sprite-tab-animation'), 'Non-bird profile shows an unsupported animation view');
      fitGuide(); await wait(100);
      if (kind === 'apparel') {
        assert(document.querySelector('#sprite-body-type').options.length === 5, 'Adult apparel body-type selector is incomplete');
        assert(document.querySelector('[data-sprite-slot="item"]'), 'Apparel inventory image is not separate');
        assert(document.querySelectorAll('[data-sprite-guide="body"]').length >= 3, 'Worn apparel mannequin guides are missing');
        setSelect('#sprite-body-type', 'Fat'); await wait(100); await images();
        assert(document.querySelector('[data-sprite-slot="Fat_south"]') && !document.querySelector('[data-sprite-slot="Male_south"]'), 'Body type does not change the worn slots');
        assert(document.querySelector('.sprite-generation').textContent.includes('16') || document.querySelectorAll('.sprite-direction-checks input').length === 16, 'Apparel generation does not expose every native slot');
      } else if (kind === 'hat') {
        assert(document.querySelectorAll('[data-sprite-slot]').length === 4, 'Headwear inventory plus worn views are incomplete');
        assert(document.querySelectorAll('[data-sprite-guide="head"]').length >= 3, 'Headwear fit silhouettes are missing');
      } else {
        assert(!document.querySelector('.sprite-mirrored'), 'A building or furniture profile incorrectly mirrors west');
        assert(document.querySelector('[data-sprite-guide="footprint"]'), 'Building profile lacks a tile footprint guide');
        if (kind === 'building') assert(document.querySelector('[data-sprite-slot="west"]'), 'Explicit west building view is absent');
        if (kind === 'furniture') assert(document.querySelectorAll('[data-sprite-slot]').length === 1 && document.querySelector('[data-sprite-slot="item"]'), 'Single furniture texture is incorrectly split into rotations');
      }
      setSelect('[aria-label="Target RimWorld mod"]', 'atlas-sprite-fixture'); await wait(50);
      button('Preview export').click(); await until(() => document.querySelector('.sprite-export-preview'), 'Profile export preview is missing');
      assert(document.querySelectorAll('.sprite-export-rows>div').length === input.profilePlans[kind].rows.length, 'Profile export preview omitted files');
      assert(applyCalls === 1, 'Profile preview automatically exported assets');
      button('Close preview').click(); await wait(50);
      profileUi[kind] = { correctSlots: true, fitGuideVisible: true, nativePlanReviewed: true };
    }
    await openFamily(input.disposable);
    document.querySelector('.sprite-family-more').open = true; button('Archive family').click();
    await until(() => document.querySelector('.sprite-archived-banner'), 'Archived family state is not shown');
    assert([...document.querySelectorAll('button')].find(node => /^Generate /.test(node.textContent.trim()))?.disabled, 'Archived family remains editable');
    document.querySelector('.sprite-archived-banner button').click(); await until(() => !document.querySelector('.sprite-archived-banner'), 'Family restore did not return editing');
    document.querySelector('.sprite-family-more').open = true; button('Delete family…').click();
    await until(() => button('Delete family'), 'Delete family does not request confirmation'); assert(deleteCalls === 0, 'Family deletion occurred before confirmation');
    button('Cancel').click(); await until(() => !button('Delete family'), 'Cancelled delete confirmation remained open');
    assert(projects.has(input.disposable.id) && deleteCalls === 0, 'Cancelling deletion removed the family');
    button('Delete family…').click(); await until(() => button('Delete family'), 'Second delete confirmation is missing'); button('Delete family').click();
    await until(() => deleteCalls === 1 && !document.querySelector('.sprite-workspace'), 'Confirmed family deletion did not finish');
    button('Import master art').click(); await until(() => document.querySelector('#sprite-new-name'), 'Master import form did not open');
    setText('#sprite-new-name', 'Atlas QA cancelled UI master'); setText('#sprite-new-brief', 'Existing master artwork.'); await wait(50);
    const beforeMasterFamilies = projects.size; button('Choose PNG and create family').click();
    await until(() => masterCalls === 1 && !button('Choose PNG and create family')?.disabled, 'Cancelled master picker did not return the form');
    assert(projects.size === beforeMasterFamilies && document.querySelector('#sprite-new-name').value === 'Atlas QA cancelled UI master', 'Cancelled master import created an empty family or discarded the form');
    button('Cancel').click(); await wait(50); await openFamily(input.master);
    const reference = document.querySelector('.sprite-reference-list img'); assert(reference, 'Imported master reference is absent from inspector'); await reference.decode();
    await openFamily(input.importSequence);
    assert(document.querySelectorAll('.sprite-direction-grid .sprite-art').length === 4, 'Legacy singleton imports no longer show all saved views');
    assert(document.querySelector('[data-sprite-slot="east"] .sprite-card-actions').textContent.includes('Approved'), 'Carried earlier approved artwork lost its approval indicator');
    const sourceSouth = project.candidates[1].id;
    document.querySelector('[data-sprite-slot="south"] .sprite-card-actions button:last-child').click();
    await until(() => project.approved.south === sourceSouth, 'Approving a carried legacy view used the wrong revision id');
    assert(lastApproval.candidate === sourceSouth && project.candidates.length === 3, 'Legacy approval changed revision history or approved the unrelated selected import');
    await openFamily(input.importedSlot);
    await selectDirections(['south', 'east', 'north']);
    assert(!Object.keys(project.approved).length && project.candidates[0].directions.east.frames.length === 0, 'Imported flight fixture is not an unapproved flat PNG');
    const design = document.querySelector('[data-sprite-design-primary]');
    assert(design?.textContent === 'Design flight frames' && !design.disabled, 'Imported flat bird has no usable design action');
    const designBox = design.getBoundingClientRect(); assert(designBox.top >= 0 && designBox.bottom <= window.innerHeight, 'Design flight frames is hidden below the fold');
    await tab('animation'); assert(document.querySelector('[data-sprite-flight-start]'), 'Zero-frame flight view does not explain how to design frames');
    document.querySelector('[data-sprite-design-primary]').click(); await until(() => document.querySelector('[data-sprite-stop-design]'), 'Design task lacks a visible stop action');
    assert(lastGeneration.projectId === input.importedSlot.id && lastGeneration.directions.join(',') === 'south,east,north', 'Design flight frames did not request all three views from the existing family');
    document.querySelector('[data-sprite-stop-design]').click(); await until(() => document.querySelector('[role="alert"]')?.textContent.includes('stopped'), 'Stopping imported design did not report cancellation');
    assert(project.candidates.length === 1 && project.candidates[0].source === 'imported' && !Object.keys(project.approved).length, 'Cancelled design changed imported or approved artwork');
    document.querySelector('[aria-label="Dismiss Sprite Studio error"]').click();
    await openFamily(input.partialProject);
    const beforeSelection = JSON.stringify(project.approved), beforeHistory = project.candidates.length;
    const requestSizes = [];
    for (const selection of [['south'], ['south', 'east'], ['south', 'east', 'north']]) {
      await selectDirections(selection);
      document.querySelector('[data-sprite-design-primary]').click(); await until(() => document.querySelector('[data-sprite-stop-design]'), 'Selected-view design did not start');
      assert(lastGeneration.directions.join(',') === selection.join(','), 'Design action ignored the requested direction subset');
      requestSizes.push(lastGeneration.directions.length);
      progressStage('designing', 0, 1); await wait(50);
      assert(document.querySelector('[data-sprite-progress] [role="progressbar"]')?.getAttribute('aria-valuenow') === null, 'Waiting for a model displays an invented percentage');
      progressStage('rendering', 3, selection.length * 9, selection[0], 2); await wait(50);
      assert(Number(document.querySelector('[data-sprite-progress] [role="progressbar"]')?.getAttribute('aria-valuenow')) === Math.round(3 / (selection.length * 9) * 100), 'Rendering progress does not use the actual PNG count');
      assert(document.querySelector('[data-sprite-progress]').textContent.includes('3') && document.querySelector('[data-sprite-progress]').textContent.includes(String(selection.length * 9)), 'Rendering progress omits completed/total PNG counts');
      progressStage('saving', selection.length * 9, selection.length * 9); await wait(50);
      assert(document.querySelector('[data-sprite-progress] [role="progressbar"]')?.getAttribute('aria-valuenow') === null, 'Saving presents rendering completion as final job completion');
      document.querySelector('[data-sprite-stop-design]').click(); await until(() => document.querySelector('[role="alert"]')?.textContent.includes('stopped'), 'Selective design cancellation is not reported');
      document.querySelector('[aria-label="Dismiss Sprite Studio error"]').click(); await wait(25);
    }
    assert(JSON.stringify(project.approved) === beforeSelection && project.candidates.length === beforeHistory, 'Cancelled selected-view requests changed previous art or approval history');
    await selectDirections([]); assert(document.querySelector('[data-sprite-design-primary]').disabled, 'Empty selection can start a generation'); await selectDirections(['south', 'east', 'north']);
    await tab('gallery');
    setSelect('[aria-label="Gallery revisions"]', 'all'); setSelect('[aria-label="Gallery artwork"]', 'generated'); await wait(100);
    const allGallery = await galleryCount(); assert(allGallery.length === 81, 'All generated revisions, including identical regenerations, are not shown');
    assert(new Set(allGallery.map(row => row.src)).size === 81, 'Gallery duplicates copied previews or omits distinct files');
    assert(new Set(allGallery.map(row => row.revision)).size === 4, 'Gallery has lost a generated revision');
    setSelect('[aria-label="Gallery images"]', 'frames'); await wait(100); const frames = await galleryCount();
    assert(frames.length === 72 && frames.every(row => row.kind === 'frame' && Number(row.frame) >= 1 && Number(row.frame) <= 8), 'Flight gallery does not expose every individual frame');
    setSelect('[aria-label="Gallery images"]', 'previews'); await wait(100); assert((await galleryCount()).length === 9, 'Standing-only gallery filter is inaccurate');
    setSelect('[aria-label="Gallery images"]', 'all'); setSelect('[aria-label="Gallery direction"]', 'east'); await wait(100); assert((await galleryCount()).length === 27, 'Gallery direction filter is inaccurate');
    setSelect('[aria-label="Gallery direction"]', 'all'); setSelect('[aria-label="Gallery artwork"]', 'imported'); await wait(100); assert(!document.querySelector('[data-sprite-gallery-card]'), 'Imported-only filter includes generated files');
    setSelect('[aria-label="Gallery artwork"]', 'generated'); await wait(100);
    const galleryImage = document.querySelector('[data-sprite-gallery-card] img'); galleryImage.loading = 'eager'; await galleryImage.decode(); assert(galleryImage.naturalWidth === 128, 'Gallery preview cannot load from the native image protocol');
    document.querySelector('[data-sprite-gallery-card]').click(); await until(() => document.querySelector('[data-sprite-gallery-preview]')?.open, 'Gallery image cannot expand');
    const expanded = document.querySelector('[data-sprite-gallery-preview] img'); expanded.loading = 'eager'; await expanded.decode(); assert(expanded.naturalWidth === 128, 'Expanded gallery sprite did not load');
    document.querySelector('[aria-label="Close sprite preview"]').click(); await until(() => !document.querySelector('[data-sprite-gallery-preview]')?.open, 'Gallery preview did not close');
    await openFamily(input.project);
    const gif = new Image(); gif.src = input.gifPreview; await gif.decode();
    assert(gif.naturalWidth === 1 && gif.naturalHeight === 1 && gif.src.startsWith('data:image/gif;'), 'Native animated GIF data could not display under production CSP');
    return { directionsLoaded: true, mirroredWest: true, individualFlightFrames: true, nativeFlightTiming: true, animationPlays: true, comparisonLoaded: true, identityLocked: true, historyRetained: true, restoredEarlierRevision: true, cancellationPreservesApproval: true, reviewedExportOnly: true, profileUi, archiveRestoreUi: true, confirmedDeleteUi: true, cancelledMasterFormPreserved: true, masterReferenceDisplayed: true, legacyImportedViewsVisible: true, legacyApprovalUsesSourceRevision: true, importedBirdDesignActionVisible: true, importedBirdDesignUsesAllViews: true, importedBirdCancelPreservesArtwork: true, selectiveRequests: requestSizes, realStageProgressDisplayed: true, galleryAllGeneratedFiles: allGallery.length, galleryFlightFrames: frames.length, galleryFiltersAndPreview: true, animatedWorkshopPreviewDisplays: true, providerCalls: generateCalls, paidProviderRequests: 0 };
  },
  async state(name) {
    if (!name.startsWith('progress-')) emit([]);
    if (name === 'gallery') {
      if (project.id !== input.partialProject.id) await openFamily(input.partialProject);
      await tab('gallery'); setSelect('[aria-label="Gallery revisions"]', 'all'); setSelect('[aria-label="Gallery direction"]', 'all'); setSelect('[aria-label="Gallery artwork"]', 'generated'); setSelect('[aria-label="Gallery images"]', 'all'); await wait(100);
      for (const image of document.querySelectorAll('[data-sprite-gallery-card] img')) image.loading = 'eager';
    }
    else if (name.startsWith('progress-')) {
      if (project.id !== input.partialProject.id) await openFamily(input.partialProject);
      await tab('directions');
      const stage = name.slice('progress-'.length); progressStage(stage, stage === 'rendering' ? 7 : stage === 'saving' ? 27 : 0, stage === 'designing' ? 1 : 27, stage === 'rendering' ? 'south' : undefined, stage === 'rendering' ? 6 : undefined); await wait(100);
    }
    else if (input.profiles?.[name]) { await openFamily(input.profiles[name]); fitGuide(); await wait(50); }
    else if (name === 'master') await openFamily(input.master);
    else if (name === 'imports') await openFamily(input.importSequence);
    else {
      if (project.id !== input.project.id) await openFamily(input.project);
      if (name === 'export') { await tab('directions'); if (!document.querySelector('.sprite-export-preview')) { button('Preview export').click(); await until(() => document.querySelector('.sprite-export-preview'), 'Export screenshot preview is missing'); } }
      else { button('Close preview')?.click(); await tab(name); }
    }
    await images(); document.querySelector('.sprite-workspace-scroll').scrollTop = name === 'export' ? 100000 : 0; document.querySelector('.atlas-sprite-studio').scrollTop = 0; await wait(100);
  },
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
    const list = document.querySelector('.sprite-family-list'), note = document.querySelector('.sprite-storage-note');
    if (getComputedStyle(note).display !== 'none') {
      const listBox = list.getBoundingClientRect(), noteBox = note.getBoundingClientRect();
      assert(listBox.bottom <= noteBox.top + 1, 'Saved family list overlaps the portable storage note');
      assert(['auto', 'scroll'].includes(getComputedStyle(list).overflowY), 'Long family list is not clipped to a scrollable region');
      const last = list.lastElementChild?.getBoundingClientRect();
      assert(!last || Math.min(last.bottom, listBox.bottom) <= noteBox.top + 1, 'Visible family content overlaps the storage note');
    }
    return { width: window.innerWidth, noHorizontalOverflow: true, noPaneOverlap: true, familyListNoteSeparated: true, panes };
  },
  close() { root.unmount(); },
};
