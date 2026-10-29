// Isolated Electron UI verification. Desktop/provider operations are mocked.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
app.disableHardwareAcceleration();
const root = path.dirname(process.execPath), results = [];
fs.mkdirSync(path.join(root, 'data'), {recursive: true});
app.setPath('userData', path.join(root, 'data'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({show: false, width: 1280, height: 980, webPreferences: {sandbox: true, offscreen: true}});
  let painted;
  win.webContents.on('paint', (_event, _dirty, image) => {const bytes = image.toPNG(); if (bytes.length) painted = bytes;});
  const evaluate = code => win.webContents.executeJavaScript(code);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async code => {for (let i = 0; i < 160; i++) {if (await evaluate(code)) return; await delay(30);} throw Error('Timed out: ' + code + '\n' + await evaluate('JSON.stringify(window.fixtureErrors)'));};
  const click = async selector => {await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable: '+${JSON.stringify(selector)});e.click();})()`); await delay(90);};
  const clickText = async (text, selector = 'button') => {await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0);if(!e||e.disabled)throw Error('Unavailable: '+${JSON.stringify(text)});e.click();})()`); await delay(90);};
  const choose = async (selector, value) => {await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable selection');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await delay(100);};
  const shot = async name => {await delay(150); painted = undefined; win.webContents.invalidate(); for (let i = 0; i < 40 && !painted; i++) await delay(30); assert(painted, 'Screenshot missing'); fs.writeFileSync(path.join(root, name + '.png'), painted);};
  const calls = async method => evaluate(`window.fixtureCalls.filter(call=>call.method===${JSON.stringify(method)})`);
  const checkLayout = async label => {
    const geometry = await evaluate(`(()=>{
      const root=document.querySelector('.atlas-helpers')||document.querySelector('.atlas-helper-settings');
      const boxes=[root,...root.querySelectorAll('select,button,textarea')].filter(e=>e.getBoundingClientRect().width>0).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,label:e.getAttribute('aria-label')||e.textContent.slice(0,40)}});
      const composer=document.querySelector('textarea[data-demo="chat-input"]'),composerRect=composer?.getBoundingClientRect();
      return {viewport:innerWidth,document:document.documentElement.scrollWidth,overflow:root.scrollWidth-root.clientWidth,boxes,composerVisible:!composerRect||composerRect.width===0||composerRect.bottom<=innerHeight};
    })()`);
    assert(geometry.document <= geometry.viewport + 1, label + ' page overflows');
    assert(geometry.overflow <= 1, label + ' helpers overflow');
    assert(geometry.composerVisible, label + ' composer input is below the viewport');
    for (const box of geometry.boxes) assert(box.left >= -1 && box.right <= geometry.viewport + 1, label + ' escaped control: ' + JSON.stringify(box));
    results.push({label, width: geometry.viewport, overflow: false});
  };
  try {
    await win.webContents.session.clearStorageData();
    await win.loadFile(path.join(root, '../redesign-ui.html'));
    await wait('document.querySelectorAll(".atlas-projects-page .grid > div").length===4');
    await click('.atlas-projects-page .grid > div > button');
    await wait('!!document.querySelector(".atlas-helpers-toggle")');
    assert.equal(await evaluate('document.querySelector(".atlas-helpers-toggle").getAttribute("aria-expanded")'), 'false');
    assert.match(await evaluate('document.querySelector(".atlas-helpers-toggle").textContent'), /Efficient.*Up to 4/);
    await evaluate(`(()=>{
      const now=Date.now(),base={task:'Local fixture task',complexity:'routine',createdAt:now-60000,lastActivityAt:now-2000,model:{key:'fixture/light',label:'Light model',thinkingLevel:'medium',routingReason:'Routine task: selected an available lighter model.'}};
      window.fixtureSetHelpers([
        {...base,id:'research',title:'Inspect the existing definitions',kind:'research',status:'running',phase:'Reading project files',startedAt:now-60000,deadlineAt:now+19*60000,maxDeadlineAt:now+119*60000},
        {...base,id:'queued',title:'Prepare the texture assignments',kind:'implement',status:'queued',phase:'Waiting for a helper slot'},
        {...base,id:'review',title:'Review compatibility',kind:'review',status:'completed',phase:'Finished',usage:{input:1234,output:246},summary:'Compatibility review complete. The parent definitions are valid; one texture name needs attention.'},
        {...base,id:'failed',title:'Check load order',kind:'research',status:'failed',phase:'Request failed',error:'Fixture connection interrupted. Retry when ready.'},
        {...base,id:'patch',title:'Prepare definition changes',kind:'implement',status:'completed',phase:'Awaiting integration',changes:[{path:'Defs/Fixture.xml',kind:'modified',bytes:128}],summary:'One definition updated in the private workspace. Ready for lead review.'},
        {...base,id:'partial',title:'Recover an interrupted implementation',kind:'implement',status:'failed',phase:'Time limit reached',partialPatch:true,stagingPath:'C:/fixture/helper-work/partial',changes:[{path:'Source/Fixture.cs',kind:'modified',bytes:128}],error:'The helper stopped before its final report.'}
      ]);
    })()`);
    await wait('document.querySelector(".atlas-helpers-counts").textContent.includes("1 active · 1 queued · 2 completed")');
    for (const method of ['setSubagentSettings', 'cancelSubagent', 'retrySubagent', 'steerSubagent', 'extendSubagent', 'reviewSubagentPatch', 'applySubagentPatch']) assert.equal((await calls(method)).length, 0, 'Automatic ' + method);
    await click('.atlas-helpers-toggle');
    assert.equal(await evaluate('document.querySelectorAll(".atlas-helper-task").length'), 6);
    assert.match(await evaluate('document.querySelector(".atlas-helpers-body").textContent'), /main chat’s thinking stays unchanged/);
    assert.equal(await evaluate('document.querySelectorAll(".atlas-helpers [role=progressbar],.atlas-helpers [aria-valuenow]").length'), 0);
    assert.equal(await evaluate('document.querySelectorAll(".atlas-helper-usage").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll(".atlas-helper-task-actions[open]").length'), 0);
    await checkLayout('Helpers wide'); await shot('helpers-wide');

    assert.match(await evaluate('document.querySelector(".atlas-helper-time-budget").textContent'), /m \d{2}s left/);
    const originalDeadline=await evaluate('window.fixtureHelperTasks.find(task=>task.id==="research").deadlineAt');
    await clickText('Extend 15 min', '.atlas-helper-task[data-helper-status="running"] button');
    await wait('window.fixtureCalls.some(call=>call.method==="extendSubagent")');
    assert.equal((await calls('extendSubagent')).length,1);
    assert.equal(await evaluate('window.fixtureHelperTasks.find(task=>task.id==="research").deadlineAt'),originalDeadline+15*60000);
    assert.match(await evaluate('document.querySelector(".atlas-helper-task[data-helper-status=running]").textContent'), /thinking settings are unchanged/);

    await click('.atlas-helper-task[data-helper-status="running"] summary');
    await evaluate(`(()=>{const e=document.querySelector('.atlas-helper-task[data-helper-status="running"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'  Check inherited textures too.  ');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await clickText('Send instruction', '.atlas-helper-task[data-helper-status="running"] button');
    await wait('window.fixtureCalls.some(call=>call.method==="steerSubagent")');
    assert.equal((await calls('steerSubagent'))[0].args[1], 'research');
    assert.equal((await calls('steerSubagent'))[0].args[2], 'Check inherited textures too.');
    await wait('document.querySelector(".atlas-helper-task[data-helper-status=running] textarea").value===""');
    await clickText('Cancel helper', '.atlas-helper-task[data-helper-status="running"] button');
    await wait('document.querySelector(".atlas-helpers-counts").textContent.startsWith("0 active")');
    assert.equal((await calls('cancelSubagent')).length, 1);
    await click('.atlas-helper-task[data-helper-status="failed"] summary');
    await clickText('Retry helper', '.atlas-helper-task[data-helper-status="failed"] button');
    await wait('window.fixtureHelperTasks.some(task=>task.id==="failed-retry")');
    assert.equal((await calls('retrySubagent')).length, 1);
    await evaluate(`(()=>{const row=[...document.querySelectorAll('.atlas-helper-task')].find(e=>e.textContent.includes('Prepare definition changes'));row.querySelector('summary').click();})()`);
    await clickText('Discard patch', '.atlas-helper-task button');
    await wait('window.fixtureHelperTasks.find(task=>task.id==="patch").status==="cancelled"');
    assert.equal((await calls('cancelSubagent')).length, 2);
    assert.match(await evaluate('[...document.querySelectorAll(".atlas-helper-task")].find(e=>e.textContent.includes("Prepare definition changes")).textContent'), /Not integrated/);

    await evaluate(`(()=>{const row=[...document.querySelectorAll('.atlas-helper-task')].find(e=>e.textContent.includes('Recover an interrupted implementation'));row.querySelector('summary').click();})()`);
    assert.equal(await evaluate('[...document.querySelectorAll(".atlas-helper-task button")].some(e=>e.textContent.includes("Apply reviewed partial patch"))'),false);
    await clickText('Review saved work', '.atlas-helper-task button');
    await wait('!!document.querySelector(".atlas-helper-patch-review")');
    assert.equal((await calls('reviewSubagentPatch')).length,1);assert.equal((await calls('applySubagentPatch')).length,0);
    assert.match(await evaluate('document.querySelector(".atlas-helper-patch-review").textContent'), /unfinished helper patch/);
    assert.match(await evaluate('document.querySelector(".atlas-helper-patch-review pre").textContent'), /class Partial/);
    await evaluate('document.querySelector(".atlas-helper-patch-review").scrollIntoView({block:"nearest"})');
    await checkLayout('Saved work review');await shot('helpers-partial-review');
    await clickText('Apply reviewed partial patch', '.atlas-helper-task button');
    await wait('window.fixtureHelperTasks.find(task=>task.id==="partial").applied===true');
    assert.equal((await calls('applySubagentPatch')).length,1);
    assert.equal(await evaluate('!!document.querySelector(".atlas-helper-patch-review")'),false);
    assert.equal(await evaluate('[...document.querySelectorAll(".atlas-helper-task button")].some(e=>e.textContent==="Continue remaining work")'),true);

    win.setContentSize(620, 980);
    await delay(150);
    await clickText('Assistant', 'nav[aria-label="Workspace sections"] button span.block.text-sm');
    await wait('!!document.querySelector(".atlas-chat-pane .atlas-helpers-toggle")');
    if (await evaluate('document.querySelector(".atlas-helpers-toggle").getAttribute("aria-expanded")==="false"')) await click('.atlas-helpers-toggle');
    await checkLayout('Helpers narrow'); await shot('helpers-narrow');
    await clickText('Settings', '.atlas-main-navigation button');
    await clickText('Accounts & models', '.atlas-settings-navigation button');
    await wait('!!document.querySelector(".atlas-helper-settings select")');
    assert.equal(await evaluate('document.querySelector(".atlas-helper-settings select[aria-label=\\"Maximum helpers\\"]").value'), '4');
    await choose('.atlas-helper-settings select[aria-label="Maximum helpers"]', '8');
    assert.equal((await calls('setSubagentSettings')).at(-1).args[0].maxHelpers, 8);
    await choose('.atlas-helper-settings select[aria-label="Helper mode"]', 'match');
    assert.equal((await calls('setSubagentSettings')).at(-1).args[0].mode, 'match');
    await choose('.atlas-helper-settings select[aria-label="Helper mode"]', 'off');
    assert.equal(await evaluate('window.fixtureHelperTasks.some(task=>["running","queued"].includes(task.status))'), false);
    assert.equal(await evaluate('document.querySelector(".atlas-helper-settings select[aria-label=\\"Maximum helpers\\"]").disabled'), true);
    await choose('.atlas-helper-settings select[aria-label="Helper mode"]', 'efficient');
    await choose('.atlas-helper-settings select[aria-label="Maximum helpers"]', '4');
    await checkLayout('Settings narrow'); await shot('helpers-settings-narrow');
    win.setContentSize(1280, 980); await delay(150);
    await checkLayout('Settings wide'); await shot('helpers-settings-wide');
    await clickText('Workspace', '.atlas-main-navigation button');
    await wait('!!document.querySelector(".atlas-helpers-toggle")');
    assert.match(await evaluate('document.querySelector(".atlas-helpers-toggle").textContent'), /Efficient.*Up to 4/);
    assert.match(await evaluate('document.querySelector(".atlas-helpers-counts").textContent'), /0 active · 0 queued · 1 completed/);
    assert.equal(await evaluate('window.fixtureCalls.filter(call=>["send","setModel","setConversationModel","setThinkingLevel","setConversationThinkingLevel"].includes(call.method)).length'), 0);

    await evaluate(`(()=>{
      const picture=(color,label)=>{const c=document.createElement('canvas');c.width=320;c.height=180;const p=c.getContext('2d');p.fillStyle=color;p.fillRect(0,0,320,180);p.fillStyle='#fff';p.font='20px sans-serif';p.fillText(label,25,95);return c.toDataURL('image/png');};
      window.fixtureOriginalPreview=picture('#263641','Existing artwork');window.fixtureProposalImage=picture('#526954','Proposed artwork');
      window.fixtureCurrentPreview=window.fixtureOriginalPreview;
      window.fixturePreviewCandidate={id:'proposal-1',dataUrl:window.fixtureProposalImage,createdAt:Date.now(),warning:'Fixture proposal: the current preview is preserved.'};
    })()`);
    await clickText('Publish', 'nav[aria-label="Workspace sections"] button span.block.text-sm');
    await wait('!!document.querySelector("[data-atlas-preview-candidate]")');
    assert.equal(await evaluate('document.querySelector("[data-atlas-workshop-preview] img").src===window.fixtureOriginalPreview'),true);
    assert.equal((await calls('applyPreviewCandidate')).length,0);assert.equal((await calls('discardPreviewCandidate')).length,0);
    assert.match(await evaluate('document.querySelector("[data-atlas-preview-candidate]").textContent'),/current preview stays unchanged/);
    for(const width of [900,420]){
      win.setContentSize(width,980);await delay(150);await evaluate('document.querySelector("[data-atlas-preview-candidate]").scrollIntoView({block:"center"})');
      const geometry=await evaluate(`(()=>{const panel=document.querySelector('[data-atlas-preview-candidate]');return {width:innerWidth,document:document.documentElement.scrollWidth,boxes:[panel,...panel.querySelectorAll('img,button')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})};})()`);
      assert(geometry.document<=geometry.width+1,'Preview page overflows at '+width);for(const box of geometry.boxes)assert(box.left>=-1&&box.right<=geometry.width+1,'Preview control overflows at '+width);
      results.push({label:'Preview proposal',width,overflow:false});await shot('preview-proposal-'+width);
    }
    await clickText('Discard proposal','[data-atlas-preview-candidate] button');
    await wait('!document.querySelector("[data-atlas-preview-candidate]")');assert.equal((await calls('discardPreviewCandidate')).length,1);
    assert.equal(await evaluate('window.fixtureCurrentPreview===window.fixtureOriginalPreview'),true);assert.equal((await calls('applyPreviewCandidate')).length,0);
    await evaluate(`window.fixturePreviewCandidate={id:'proposal-2',dataUrl:window.fixtureProposalImage,createdAt:Date.now()};window.emitFixture('onModChanged',{folder:'fixture-0'});`);
    await wait('!!document.querySelector("[data-atlas-preview-candidate]")');
    assert.equal(await evaluate('document.querySelector("[data-atlas-workshop-preview] img").src===window.fixtureOriginalPreview'),true);
    await clickText('Use this preview','[data-atlas-preview-candidate] button');
    await wait('!document.querySelector("[data-atlas-preview-candidate]")');assert.equal((await calls('applyPreviewCandidate')).length,1);
    assert.equal((await calls('applyPreviewCandidate'))[0].args[1],'proposal-2');
    assert.equal(await evaluate('document.querySelector("[data-atlas-workshop-preview] img").src===window.fixtureProposalImage'),true);
    assert.equal((await calls('send')).length,0);
    assert.deepEqual(await evaluate('window.fixtureErrors'), []);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({passed: true, results, mainThinkingUnchanged: true, onlyManualActions: true, targetedSteering: true, cancellation: true, explicitRetry: true, discardPrivatePatch: true, sharedSettings: true, offStopsHelpers: true, manualTimeExtension:true, reviewedPartialRecovery:true, previewCandidateRequiresApply:true, previewDiscardPreservesOriginal:true}, null, 2));
    app.exit(0);
  } catch (error) {
    await shot('failure');
    fs.writeFileSync(path.join(root, 'error.txt'), error.stack + '\n' + await evaluate('JSON.stringify(window.fixtureErrors)'));
    app.exit(1);
  }
});
