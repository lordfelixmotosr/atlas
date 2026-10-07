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
async function run(win, root, result) {
  assert(process.env.ATLAS_VERIFY_SPRITE_BUNDLE, 'Sprite UI verification bundle is missing');
  const { SpriteStudio, pngInfo } = require('./sprite-studio.cjs');
  const resvgRoot = path.join(process.resourcesPath, 'resvg-wasm'), resvg = require(resvgRoot);
  await resvg.initWasm(fs.readFileSync(path.join(resvgRoot, 'index_bg.wasm')));
  const rasterize = async svg => { const rendered = new resvg.Resvg(svg).render(); return { png: rendered.asPng(), width: rendered.width, height: rendered.height }; };
  const studioRoot = path.join(root, 'data/profile/sprite-studio'), store = new SpriteStudio({ root: studioRoot, rasterize });
  const recipe = { name: 'Atlas QA moon crow', kind: 'bird', brief: 'Cream crow with sage wings and dark tail. Keep a readable shared silhouette.', palette: ['#f1e9d0', '#8c9d78', '#414c39', '#262923'], canvasSize: 128, frameCount: 8, ticksPerFrame: 2, groundedDrawSize: 0.7, drawSize: 1.5, textureName: 'AtlasSpriteFixture' };
  const call = (name, args = []) => win.webContents.executeJavaScript(`window.modmixer.${name}(...${JSON.stringify(args)})`);
  let project = await call('spriteCreate', [recipe]);
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

  const rendererRoot = path.join(__dirname, '../../renderer/main_window'), html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?\s*>/i);
  assert(csp, 'Production content security policy is missing');
  const cssRoot = path.join(rendererRoot, 'assets'), css = fs.readdirSync(cssRoot).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join(cssRoot, name), 'utf8')).join('\n');
  const fixture = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  try {
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head>' + csp[0] + '<style>html,body,#root{margin:0;width:100%;height:100%;}#root{display:flex;flex-direction:column;}</style></head><body><div id="root"></div></body></html>'));
    await fixture.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark');document.head.appendChild(Object.assign(document.createElement('style'),{textContent:${JSON.stringify(css)}}));window.__atlasSpriteSnapshot=${JSON.stringify({ project, plan })};void 0;`);
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
    for (const name of ['animation', 'compare', 'export']) {
      await fixture.webContents.executeJavaScript(`window.__atlasSpriteTest.state(${JSON.stringify(name)})`);
      fixture.webContents.invalidate(); await pause(500);
      fs.writeFileSync(path.join(root, 'data/Atlas-sprites-' + name + '.png'), (await fixture.webContents.capturePage()).toPNG());
    }
    const denied = await fixture.webContents.executeJavaScript(`(async()=>{const base='modmixer-asset://studio/'+${JSON.stringify(project.id)}+'/';const paths=['project.json','..%2Fproject.json','candidates%2Fmissing.png'];const failures=[];for(const file of paths)failures.push(await new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(false);image.onerror=()=>resolve(true);image.src=base+file;}));return failures.every(Boolean)})()`);
    assert(denied, 'Native sprite protocol exposed metadata or an escaped/missing file');
    result.nativeSprites = { ...ui, ...actualApp, realWasmRasterized: true, nativePersistence: true, canvasAlphaAndPadding: canvases && transparent && unclipped, eightDistinctFrames: distinctFrames, expectedFlightFiles: true, approvedNativeExport: true, exportTokenSingleUse: true, metadataProtocolDenied: true, exportedFiles: exported.files, layouts, screenshots: ['actual-app', 'directions-1440', 'directions-1024', 'directions-768', 'directions-480', 'animation', 'compare', 'export'] };
    await fixture.webContents.executeJavaScript('window.__atlasSpriteTest.close()');
  } finally { fixture.destroy(); }
}
module.exports = { run };
