'use strict';
// Injected only into a disposable owned native fixture, never a release archive.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { app, BrowserWindow } = require('electron');
const assert = (value, message) => { if (!value) throw new Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function scene(direction, revision = false) {
  const body = direction === 'east'
    ? '<ellipse cx="60" cy="69" rx="18" ry="14" fill="#f1e9d0"/><circle cx="79" cy="55" r="11" fill="#f1e9d0"/><path d="M89 54 L99 58 L88 59Z" fill="#414c39"/><circle cx="82" cy="53" r="2" fill="#262923"/><path d="M44 66 L26 79 L47 77Z" fill="#414c39"/>'
    : '<ellipse cx="64" cy="70" rx="14" ry="20" fill="#f1e9d0"/><circle cx="64" cy="48" r="12" fill="#f1e9d0"/><path d="M60 61 L64 69 L68 61Z" fill="#414c39"/><path d="M56 84 L64 99 L72 84Z" fill="#414c39"/>' + (direction === 'south' ? '<circle cx="59" cy="46" r="2" fill="#262923"/><circle cx="69" cy="46" r="2" fill="#262923"/>' : '<path d="M56 42 Q64 38 72 42 L71 46 Q64 42 57 46Z" fill="#414c39"/>');
  return {
    body: { svg: body + (revision ? '<circle cx="64" cy="74" r="4" fill="#8c9d78"/>' : '') },
    wingNear: { svg: '<path d="M64 65 C76 58 91 60 99 76 C88 76 74 73 64 68Z" fill="#8c9d78"/>', pivot: { x: 64, y: 65 } },
    wingFar: { svg: '<path d="M64 65 C52 58 37 60 29 76 C40 76 54 73 64 68Z" fill="#414c39"/>', pivot: { x: 64, y: 65 } },
  };
}
function assetScene(kind, slot) {
  let svg;
  if (kind === 'apparel') {
    const scale = ({ Male: 1, Female: .88, Thin: .76, Fat: 1.26, Hulk: 1.3 })[slot.split('_')[0]] ?? 1;
    svg = `<g transform="translate(64 70) scale(${scale} 1) translate(-64 -70)"><path d="M49 38 L56 35 L72 35 L79 38 L88 62 L79 66 L77 84 L51 84 L49 66 L40 62Z" fill="#8c9d78"/><path d="M58 35 L64 46 L70 35 L69 40 L64 51 L59 40Z" fill="#414c39"/><path d="M53 76 L75 76" stroke="#f1e9d0" stroke-width="2"/></g>`;
  } else if (kind === 'hat') svg = '<path d="M42 61 C40 35 88 35 86 61 L98 66 Q64 81 30 66Z" fill="#8c9d78"/><path d="M43 59 Q64 66 85 59 L86 64 Q64 71 42 64Z" fill="#414c39"/>';
  else svg = '<path d="M27 54 L66 32 L101 53 L64 76Z" fill="#f1e9d0"/><path d="M27 54 L64 76 L64 96 L27 74Z" fill="#414c39"/><path d="M64 76 L101 53 L101 74 L64 96Z" fill="#8c9d78"/><path d="M49 41 L85 63" stroke="#262923" stroke-width="2"/>';
  return { body: { svg } };
}
async function run(win, root, result) {
  assert(process.env.ATLAS_VERIFY_SPRITE_BUNDLE, 'Sprite UI verification bundle is missing');
  const { SpriteStudio, pngInfo, getSlots } = require('./sprite-studio.cjs');
  const studioRoot = path.join(root, 'data/profile/sprite-studio');
  const recipe = { name: 'Atlas QA moon crow', kind: 'bird', brief: 'Cream crow with sage wings and dark tail. Keep a readable shared silhouette.', palette: ['#f1e9d0', '#8c9d78', '#414c39', '#262923'], canvasSize: 128, frameCount: 8, ticksPerFrame: 2, groundedDrawSize: 0.7, drawSize: 1.5, textureName: 'AtlasSpriteFixture' };
  const call = (name, args = []) => win.webContents.executeJavaScript(`window.modmixer.${name}(...${JSON.stringify(args)})`);
  // Capture the real native store while invoking its unchanged create method.
  // All rasterization then uses its production WASM loader and validation.
  let store, project;
  const originalCreate = SpriteStudio.prototype.create;
  SpriteStudio.prototype.create = function (...args) { store = this; return originalCreate.apply(this, args); };
  try { project = await call('spriteCreate', [recipe]); } finally { SpriteStudio.prototype.create = originalCreate; }
  assert(store && store.root === studioRoot && typeof store.rasterize === 'function', 'Native Sprite Studio store was not captured');
  const directions = ['south', 'east', 'north'], response = revision => JSON.stringify({ directions: Object.fromEntries(directions.map(direction => [direction, scene(direction, revision)])) });
  project = await store.saveGeneration(project.id, response(false), 'Native fixture SVG', directions, project.version, new AbortController().signal);
  project = await call('spriteApprove', [project.id, project.candidates[0].id, directions, project.version]);
  project = await store.saveGeneration(project.id, response(true), 'Native fixture revision', directions, project.version, new AbortController().signal);
  const nativeRead = await call('spriteRead', [project.id]), nativeList = await call('spriteList');
  assert(nativeRead.candidates.length === 2 && nativeList.some(item => item.id === project.id && item.approvedCount === 3), 'Native preload/store sprite persistence failed');
  const actualApp = await win.webContents.executeJavaScript(`(async()=>{const deadline=Date.now()+10000;let button;while(!(button=[...document.querySelectorAll('nav button')].find(node=>node.textContent.trim()==='Sprite Studio'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));if(!button)throw new Error('Sprite Studio is missing from the real app navigation');const labels=[...document.querySelectorAll('nav button')].map(node=>node.textContent.trim());if(labels.indexOf('Sprite Studio')!==labels.indexOf('Library')+1)throw new Error('Sprite Studio is not beside Library');button.click();let family;while(!(family=[...document.querySelectorAll('.sprite-family')].find(node=>node.textContent.includes(${JSON.stringify(recipe.name)})))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));if(!family)throw new Error('Native saved sprite family is missing from the real app');family.click();while(!document.querySelector('.sprite-workspace')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));const images=[...document.querySelectorAll('.sprite-direction-grid .sprite-art')];if(images.length!==4)throw new Error('Real app did not show three native directions and mirrored west');for(const image of images){await image.decode();if(image.naturalWidth!==128)throw new Error('A native sprite preview did not load in the real app');}return {navBesideLibrary:true,savedFamilyOpened:true,actualAppPngsLoaded:true}})()`);
  win.webContents.invalidate(); await pause(500);
  const actualPicture = await win.webContents.capturePage();
  if (!actualPicture.isEmpty()) fs.writeFileSync(path.join(root, 'data/Atlas-sprites-actual-app.png'), actualPicture.toPNG());
  let transparent = true, unclipped = true, canvases = true, distinctFrames = true;
  for (const candidate of project.candidates) for (const art of Object.values(candidate.directions)) {
    assert(art.frames.length === 8 && art.hasWingRig, 'Native bird rig did not generate all frames');
    const hashes = new Set();
    for (const file of [art.preview, ...art.frames]) {
      const bytes = fs.readFileSync(path.join(studioRoot, project.id, file)), info = pngInfo(bytes);
      canvases &&= info.width === 128 && info.height === 128;
      transparent &&= !info.warnings.some(warning => warning.includes('fully opaque'));
      unclipped &&= !info.warnings.some(warning => warning.includes('canvas edge'));
      if (file !== art.preview) hashes.add(crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    distinctFrames &&= hashes.size === 8;
  }
  assert(canvases && transparent && unclipped && distinctFrames, 'Native SVG-to-PNG composition failed alpha/canvas/clipping/frame checks');
  const mod = path.join(app.getPath('userData'), 'workspace/Mods/atlas-sprite-fixture');
  fs.mkdirSync(path.join(mod, 'About'), { recursive: true });
  fs.writeFileSync(path.join(mod, 'About/About.xml'), '<ModMetaData><name>Atlas verification mod</name><packageId>felix.atlasspritefixture</packageId><supportedVersions><li>1.6</li></supportedVersions></ModMetaData>');
  const plan = await call('spriteExportPlan', [project.id, 'atlas-sprite-fixture', project.version]);
  assert(plan.rows.length === 27 && !fs.existsSync(path.join(mod, 'Textures')), 'Export preview wrote files before confirmation');
  assert(plan.rows.filter(row => /_Flying_[1-8]_(south|east|north)\.png$/.test(row.path)).length === 24, 'Native flight filenames differ from the RimWorld profile');
  assert(!plan.rows.some(row => /west|sheet/i.test(row.path)), 'Flight incorrectly exported separate west frames or a sheet');
  const exported = await call('spriteExportApply', [plan.token]);
  assert(exported.files === 27 && plan.rows.every(row => fs.existsSync(path.join(mod, row.path))), 'Native reviewed export failed');
  let singleUse = false; try { await call('spriteExportApply', [plan.token]); } catch (error) { singleUse = error.message.includes('Preview this export again'); }
  assert(singleUse, 'Native export token was reusable');

  const profiles = {}, profilePlans = {}, profileResults = {};
  for (const [kind, extra] of [
    ['apparel', { apparelLayer: 'Shell', apparelCoverage: 'upper' }],
    ['hat', { hatCoverage: 'upper' }],
    ['building', { graphicMode: 'multi', footprintX: 2, footprintZ: 3, drawWidth: 3.2, drawHeight: 4.1, rotatable: true }],
    ['furniture', { graphicMode: 'single', footprintX: 1, footprintZ: 2, drawWidth: 1.2, drawHeight: 2.4, rotatable: true }],
  ]) {
    const assetRecipe = { ...recipe, ...extra, name: 'Atlas QA ' + kind, kind, frameCount: 1, drawSize: 1, groundedDrawSize: 1, textureName: 'AtlasQA' + kind };
    let asset = await call('spriteCreate', [assetRecipe]);
    const slots = getSlots(asset.recipe);
    asset = await store.saveGeneration(asset.id, { directions: Object.fromEntries(slots.map(slot => [slot, assetScene(kind, slot)])) }, 'Native asset profile SVG', slots, asset.version, new AbortController().signal);
    asset = await call('spriteApprove', [asset.id, asset.candidates[0].id, slots, asset.version]);
    const assetPlan = await call('spriteExportPlan', [asset.id, 'atlas-sprite-fixture', asset.version]);
    const expected = ({ apparel: 16, hat: 4, building: 4, furniture: 1 })[kind];
    assert(assetPlan.rows.length === expected, 'Asset profile export omitted native filenames: ' + kind);
    assert(assetPlan.rows.every(row => !fs.existsSync(path.join(mod, row.path))), 'Asset preview exported files without confirmation');
    if (kind === 'apparel') {
      assert(assetPlan.rows.filter(row => /_(Male|Female|Thin|Fat|Hulk)_(south|east|north)\.png$/.test(row.path)).length === 15, 'Apparel does not cover all five adult body types');
      assert(assetPlan.xml.includes('<wornGraphicPath>') && assetPlan.xml.includes('<developmentalStageFilter>Adult</developmentalStageFilter>'), 'Apparel XML does not bind its native worn paths/adult filter');
    }
    if (kind === 'hat') assert(assetPlan.rows.filter(row => /_Worn_(south|east|north)\.png$/.test(row.path)).length === 3, 'Headwear worn filenames are incorrect');
    if (kind === 'building') assert(assetPlan.rows.some(row => /_west\.png$/.test(row.path)) && assetPlan.xml.includes('<size>(2,3)</size>') && assetPlan.xml.includes('<drawSize>(3.2,4.1)</drawSize>'), 'Building west rotation or independent footprint/draw size is incorrect');
    if (kind === 'furniture') assert(assetPlan.xml.includes('<graphicClass>Graphic_Single</graphicClass>'), 'Single furniture texture has wrong graphic class');
    const applied = await call('spriteExportApply', [assetPlan.token]);
    assert(applied.files === expected, 'Native asset export failed: ' + kind);
    for (const row of assetPlan.rows) {
      const info = pngInfo(fs.readFileSync(path.join(mod, row.path)));
      assert(info.width === 128 && info.height === 128 && !info.warnings.length, 'Asset profile PNG failed alpha/canvas/padding: ' + kind);
    }
    profiles[kind] = asset; profilePlans[kind] = assetPlan;
    profileResults[kind] = { requiredSlots: slots.length, exportedFiles: applied.files, nativeFilesAndXml: true };
  }
  const masterFile = path.join(root, 'data/native-master.png'), masterBytes = fs.readFileSync(path.join(studioRoot, project.id, project.candidates[0].directions.south.preview));
  fs.writeFileSync(masterFile, masterBytes);
  const gifBytes = Buffer.from('47494638396101000100800000000000ffffff21f90408020000002c000000000100010000020244010021f90408020000002c00000000010001000002024c01003b', 'hex');
  const gifFile = path.join(root, 'data/native-workshop-preview.gif'); fs.writeFileSync(gifFile, gifBytes);
  await call('setPreviewImage', ['atlas-sprite-fixture', gifFile]);
  const gifPreview = await call('readPreviewImage', ['atlas-sprite-fixture']);
  assert(gifPreview === 'data:image/gif;base64,' + gifBytes.toString('base64') && fs.readFileSync(path.join(mod, 'About/WorkshopPreview.gif')).equals(gifBytes), 'Animated Workshop preview was flattened or changed');
  const firstFrame = fs.readFileSync(path.join(mod, 'About/Preview.png'));
  assert(firstFrame.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'RimWorld did not receive a static first-frame PNG');
  const firstImage = require('electron').nativeImage.createFromBuffer(firstFrame), pixel = firstImage.toBitmap();
  assert(!firstImage.isEmpty() && pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255, 'Static game preview does not show the first GIF frame');
  await call('setPreviewImage', ['atlas-sprite-fixture', masterFile]);
  assert(!fs.existsSync(path.join(mod, 'About/WorkshopPreview.gif')) && (await call('readPreviewImage', ['atlas-sprite-fixture'])).startsWith('data:image/png;base64,'), 'Replacing a GIF with a PNG did not update the selected preview');
  const dialog = require('electron').dialog, originalPicker = dialog.showOpenDialog;
  let master, importedSlot, cancelledMaster;
  try {
    const beforeCount = (await call('spriteList')).length;
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    cancelledMaster = await call('spriteCreateFromMaster', [{ ...recipe, name: 'Atlas QA cancelled master' }, 'reference']);
    assert(cancelledMaster === null && (await call('spriteList')).length === beforeCount, 'Cancelled master picker left an empty family');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [masterFile] });
    master = await call('spriteCreateFromMaster', [{ ...recipe, name: 'Atlas QA master reference' }, 'reference']);
    const copied = fs.readFileSync(path.join(studioRoot, master.id, master.references[0].path));
    assert(copied.equals(masterBytes) && fs.readFileSync(masterFile).equals(masterBytes), 'Master reference or original PNG pixels changed');
    importedSlot = await call('spriteCreateFromMaster', [{ ...recipe, name: 'Atlas QA master slot' }, 'slot', 'east']);
    assert(importedSlot.candidates.length === 1 && importedSlot.candidates[0].source === 'imported' && !Object.keys(importedSlot.approved).length, 'Master slot bypassed candidate review');
    const importedIdentity = store.prepareGeneration(importedSlot.id, ['south', 'east', 'north'], '', importedSlot.version);
    assert(importedIdentity.approvedPaths.some(file => path.basename(file) === 'east-preview.png') && importedIdentity.project.candidates[0].directions.east.frames.length === 0, 'Unapproved imported artwork did not guide all missing bird views');
  } finally { dialog.showOpenDialog = originalPicker; }
  const disposable = await call('spriteCreate', [{ ...recipe, name: 'Atlas QA disposable family' }]);
  let importSequence = await call('spriteCreate', [{ ...recipe, name: 'Atlas QA imported sequence' }]);
  const sequencePicker = dialog.showOpenDialog;
  let firstImport, firstApproval;
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [masterFile] });
    importSequence = await call('spriteImport', [importSequence.id, 'east', importSequence.version]);
    firstImport = importSequence.candidates[0].id;
    importSequence = await call('spriteApprove', [importSequence.id, firstImport, ['east'], importSequence.version]);
    firstApproval = importSequence.approved.east;
    for (const slot of ['south', 'north']) importSequence = await call('spriteImport', [importSequence.id, slot, importSequence.version]);
  } finally { dialog.showOpenDialog = sequencePicker; }
  assert(importSequence.candidates.length === 3 && importSequence.approved.east === firstApproval, 'Sequential imports changed revision history or the earlier approval');
  assert(['south', 'east', 'north'].every(slot => importSequence.candidates.at(-1).directions[slot]), 'A new PNG import cleared an earlier view');
  assert(importSequence.candidates.every(candidate => Object.values(candidate.directions).every(art => fs.existsSync(path.join(studioRoot, importSequence.id, art.preview)))), 'Sequential imports deleted earlier artwork files');
  const sequenceIdentity = store.prepareGeneration(importSequence.id, ['south', 'east', 'north'], '', importSequence.version);
  assert(sequenceIdentity.approvedPaths.length === 3, 'Sequential imported views were not retained as model identity references');
  const archived = await call('spriteArchive', [master.id, true, master.version]);
  assert(archived.archivedAt && (await call('spriteList')).some(item => item.id === master.id && item.archivedAt), 'Native family archive is missing');
  master = await call('spriteArchive', [master.id, false, archived.version]);
  assert(!master.archivedAt, 'Native family restore failed');

  const rendererRoot = path.join(__dirname, '../../renderer/main_window'), html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?\s*>/i);
  assert(csp, 'Production content security policy is missing');
  const cssRoot = path.join(rendererRoot, 'assets'), css = fs.readdirSync(cssRoot).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join(cssRoot, name), 'utf8')).join('\n');
  const fixture = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  try {
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head>' + csp[0] + '<style>html,body,#root{margin:0;width:100%;height:100%;}#root{display:flex;flex-direction:column;}</style></head><body><div id="root"></div></body></html>'));
    await fixture.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark');document.head.appendChild(Object.assign(document.createElement('style'),{textContent:${JSON.stringify(css)}}));window.__atlasSpriteSnapshot=${JSON.stringify({ project, plan, profiles, profilePlans, master, importedSlot, importSequence, disposable, gifPreview })};void 0;`);
    await fixture.webContents.executeJavaScript(fs.readFileSync(process.env.ATLAS_VERIFY_SPRITE_BUNDLE, 'utf8'));
    const ui = await fixture.webContents.executeJavaScript('window.__atlasSpriteTest.run()');
    const layouts = [];
    for (const width of [1440, 1024, 768, 480]) {
      fixture.setContentSize(width, 900);
      await fixture.webContents.executeJavaScript('window.__atlasSpriteTest.state("directions")');
      layouts.push(await fixture.webContents.executeJavaScript('window.__atlasSpriteTest.layout()'));
      fixture.webContents.invalidate(); await pause(500);
      fs.writeFileSync(path.join(root, 'data/Atlas-sprites-directions-' + width + '.png'), (await fixture.webContents.capturePage()).toPNG());
    }
    fixture.setContentSize(1440, 900);
    for (const name of ['animation', 'compare', 'export', 'apparel', 'hat', 'building', 'furniture', 'master', 'imports']) {
      await fixture.webContents.executeJavaScript(`window.__atlasSpriteTest.state(${JSON.stringify(name)})`);
      fixture.webContents.invalidate(); await pause(500);
      fs.writeFileSync(path.join(root, 'data/Atlas-sprites-' + name + '.png'), (await fixture.webContents.capturePage()).toPNG());
    }
    const denied = await fixture.webContents.executeJavaScript(`(async()=>{const base='modmixer-asset://studio/'+${JSON.stringify(project.id)}+'/';const paths=['project.json','..%2Fproject.json','candidates%2Fmissing.png'];const failures=[];for(const file of paths)failures.push(await new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(false);image.onerror=()=>resolve(true);image.src=base+file;}));return failures.every(Boolean)})()`);
    assert(denied, 'Native sprite protocol exposed metadata or an escaped/missing file');
    await call('spriteDelete', [disposable.id, disposable.version]);
    assert(!fs.existsSync(path.join(studioRoot, disposable.id)) && plan.rows.every(row => fs.existsSync(path.join(mod, row.path))), 'Family deletion damaged exported mod PNGs');
    result.nativeSprites = { ...ui, ...actualApp, realWasmRasterized: true, nativePersistence: true, canvasAlphaAndPadding: canvases && transparent && unclipped, eightDistinctFrames: distinctFrames, expectedFlightFiles: true, approvedNativeExport: true, exportTokenSingleUse: true, metadataProtocolDenied: true, masterReferencePixelsPreserved: true, masterPickerCancellationClean: true, masterSlotNeedsReview: true, sequentialNativeImportsRetainViews: true, sequentialNativeImportsRetainHistory: true, nativeArchiveRestore: true, nativeDeletePreservesModAssets: true, animatedWorkshopPreviewBytesPreserved: true, workshopFirstFramePngCreated: true, workshopPngReplacementClearsGif: true, steamUploadPerformed: false, assetProfiles: profileResults, exportedFiles: exported.files, layouts, screenshots: ['actual-app', 'directions-1440', 'directions-1024', 'directions-768', 'directions-480', 'animation', 'compare', 'export', 'apparel', 'hat', 'building', 'furniture', 'master', 'imports'] };
    await fixture.webContents.executeJavaScript('window.__atlasSpriteTest.close()');
  } finally { fixture.destroy(); }
}
module.exports = { run };
