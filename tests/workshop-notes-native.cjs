// Standalone renderer fixture using the actual Changes and publish components.
// No user profile, AI request, Steam upload or game launch.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();
const root=path.dirname(process.execPath),results=[];
fs.mkdirSync(path.join(root,'data'),{recursive:true});app.setName('AtlasNotesFixture');app.setPath('userData',path.join(root,'data'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:900,height:650,webPreferences:{sandbox:true,offscreen:true}});
 let painted;win.webContents.on('paint',(_event,_dirty,image)=>{painted=image;});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(e){throw Error(code+'\n'+e.message);}};
 const wait=async code=>{for(let n=0;n<200;n++){if(await evaluate(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+code);};
 const click=async text=>{await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Control unavailable: '+${JSON.stringify(text)});e.click();})()`);};
 const input=async value=>{await evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
 try {
  for(const [width,height] of [[900,650],[620,460],[420,540]]){
   win.setContentSize(width,height);await win.loadFile(path.join(root,'../workshop-notes-ui.html'),{query:{publish:'1'}});await wait('!!document.querySelector("textarea")');
   const draft='## New features\n- **Ammo recycling:** Recycle unused ammunition.\n- **Guards:** Recruit guards.\n\n## Combat changes\n- **Melee Charge** closes distance.\n\n<img src=x onerror=alert(1)>';
   painted=undefined;await input(draft);await wait('!!document.querySelector("[data-steam-notes-preview] strong")');
   assert.equal(await evaluate('document.querySelectorAll("[data-steam-notes-preview] li").length'),3);
   assert.equal(await evaluate('document.querySelectorAll("[data-steam-notes-preview] img, [data-steam-notes-preview] script").length'),0);
   await new Promise(r=>setTimeout(r,150));for(let n=0;n<100&&!painted;n++)await new Promise(r=>setTimeout(r,25));if(painted)fs.writeFileSync(path.join(root,`preview-${width}.png`),painted.toPNG());
   await click('Publish update');assert.equal((await evaluate('window.submitted')).changeNote,draft);
   await input('## Long notes\n'+Array.from({length:200},(_,i)=>'- **Change '+i+':** '+'LongText'.repeat(30)).join('\n'));
   await wait('document.querySelectorAll("[data-steam-notes-preview] li").length===200');
   const geometry=await evaluate(`(()=>{const d=document.querySelector('[role=dialog]'),a=document.querySelector('[data-publish-actions]'),b=document.querySelector('[data-publish-body]'),r=d.getBoundingClientRect(),ar=a.getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right,actionBottom:ar.bottom,height:innerHeight,width:innerWidth,overflow:b.scrollWidth-b.clientWidth,scroll:b.scrollHeight>b.clientHeight};})()`);
   assert(geometry.top>=0&&geometry.bottom<=height+1&&geometry.right<=width+1&&geometry.actionBottom<=height+1&&geometry.overflow<=1,JSON.stringify(geometry));
   await click('Cancel');assert.equal(await evaluate('window.cancelled'),true);results.push({width,height,geometry});
  }
  win.setContentSize(900,780);
  await win.loadFile(path.join(root,'../workshop-notes-ui.html'));await wait('!!document.querySelector("button")');await click('Changes');
  await wait('!!document.querySelector("aside[aria-label]")');
  assert.equal(await evaluate('window.fixtureCalls.generate.length'),0);
  assert.equal(await evaluate('document.querySelector("details[aria-label]").open'),false);
  await click('Copy update notes');await wait('!!window.copiedNotes');assert.equal(await evaluate('window.copiedNotes'),'## Features\n- **Guards:** Recruit guards.');
  assert(!(await evaluate('document.querySelector("[data-steam-notes-preview]").textContent')).includes('PRIVATE'));
  await evaluate('(()=>{const e=document.querySelector(".atlas-changes-tools select");e.value="published";e.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await wait('window.fixtureCalls.comparisons.includes("published")');
  assert.equal(await evaluate('window.fixtureCalls.generate.length'),0);
  await click('Write update notes with AI');await wait('!!window.finishNotesGeneration');
  assert.equal(await evaluate('document.querySelector("[role=status][aria-label]").getAttribute("aria-label")'),'Writing update notes');
  assert.equal(await evaluate('document.querySelector(".atlas-changes-tools select").disabled'),true);
  assert.deepEqual(await evaluate('window.fixtureCalls.generate'),[{folder:'fixture',comparison:'published',key:'fixture-published'}]);
  await evaluate('window.finishNotesGeneration()');
  await wait('document.querySelector("textarea").value.includes("friendly pawns")');
  assert.equal(await evaluate('document.querySelectorAll("[data-steam-notes-preview] li").length'),3);
  const publicNotes=await evaluate('document.querySelector("textarea").value');
  assert(publicNotes.includes('## New features')&&publicNotes.includes('## Improvements')&&publicNotes.includes('## Fixes'));
  assert(!/PRIVATE|Source\/|ArmorRating/.test(publicNotes));
  await click('Copy update notes');assert.equal(await evaluate('window.copiedNotes'),publicNotes);
  assert(!(await evaluate('document.querySelector("[data-steam-notes-preview]").textContent')).includes('PRIVATE'));
  assert((await evaluate('document.querySelector("aside[aria-label]").textContent')).includes('PRIVATE'));
  for(const width of [900,420]){
   win.setContentSize(width,780);painted=undefined;await new Promise(r=>setTimeout(r,150));
   for(let n=0;n<100&&!painted;n++)await new Promise(r=>setTimeout(r,25));
   if(painted)fs.writeFileSync(path.join(root,`player-notes-${width}.png`),painted.toPNG());
   const geometry=await evaluate('(()=>{const d=document.querySelector("dialog"),b=d.querySelector(".atlas-import-body"),r=d.getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right,overflow:b.scrollWidth-b.clientWidth};})()');
   assert(geometry.top>=0&&geometry.bottom<=781&&geometry.right<=width+1&&geometry.overflow<=1,JSON.stringify(geometry));
  }
  await click('Use as update note');assert(!(await evaluate('document.querySelector(".atlas-mark-update textarea").value')).includes('PRIVATE'));
  await click('Mark updated');await wait('!!window.savedUpdateNote');assert.equal(await evaluate('window.savedUpdateNote'),await evaluate('window.copiedNotes'));
  await input('My edited update notes.');await evaluate('window.confirmResult=false');await click('Write update notes with AI');
  assert.equal(await evaluate('window.fixtureCalls.generate.length'),1);
  assert.equal(await evaluate('document.querySelector("textarea").value'),'My edited update notes.');
  assert((await evaluate('window.fixtureCalls.confirm')).some(message=>message.includes('unsaved update notes')));
  await click('Save update notes');await wait('window.fixtureCalls.save.length===1');assert.equal(await evaluate('window.fixtureCalls.save[0]'),'My edited update notes.');
  await input('Keep this unsaved description of the contract changes.');
  await evaluate('window.confirmResult=true;window.notesGenerationFailure="No update notes were generated. Earlier source is unavailable. Your existing notes were kept. Open Detected changes to review what was recorded.";window.finishNotesGeneration=null');
  await click('Write update notes with AI');await wait('window.fixtureCalls.generate.length===2&&!!window.finishNotesGeneration');
  await evaluate('window.finishNotesGeneration()');
  await wait(`!!document.querySelector('[aria-label="Update note generation result"]')`);
  assert.equal(await evaluate('document.querySelector("textarea").value'),'Keep this unsaved description of the contract changes.');
  assert((await evaluate(`document.querySelector('[aria-label="Update note generation result"]').textContent`)).includes('No update notes were generated.'));
  assert.equal(await evaluate(`document.querySelector('details[aria-label="Detected change details"]').open`),true);
  assert.equal(await evaluate('window.fixtureCalls.save.length'),1);
  assert.equal(await evaluate('window.fixtureCalls.generate.length'),2);
  assert(!(await evaluate('document.querySelector("[data-steam-notes-preview]").textContent')).includes('No update notes were generated'));
  await click('Copy update notes');assert.equal(await evaluate('window.copiedNotes'),'Keep this unsaved description of the contract changes.');
  await win.loadFile(path.join(root,'../workshop-notes-ui.html'),{query:{empty:'1'}});await wait('!!document.querySelector("button")');await click('Changes');
  await wait('!!document.querySelector(".atlas-feature-description")');
  assert.equal(await evaluate('[...document.querySelectorAll("button")].find(e=>e.textContent==="Copy update notes").disabled'),true);
  assert.equal(await evaluate('window.fixtureCalls.generate.length'),0);
  assert.equal(await evaluate('document.querySelector("textarea").value'),'');
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:true,results,privateWarningsExcluded:true,generatedPlayerNotes:true,explicitGenerationOnly:true,detectedDetailsCollapsed:true,rawSummaryNotCopied:true,manualDraftPreserved:true,noDraftPreservesExistingNotes:true,noDraftOpensDetectedChanges:true,noAutomaticGenerationRetry:true},null,2));app.exit(0);
 }catch(error){fs.writeFileSync(path.join(root,'error.txt'),error.stack);app.exit(1);}
});
