const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.dirname(process.execPath);app.disableHardwareAcceleration();app.setPath('userData',path.join(root,'profile'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1000,height:760,webPreferences:{sandbox:true,offscreen:true}});
  let painted;win.webContents.on('paint',(_event,_dirty,image)=>{painted=image.toPNG();});
  const js=code=>win.webContents.executeJavaScript(code);
  const wait=async code=>{for(let i=0;i<150;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,40));}throw Error('Timed out: '+code);};
  const click=async text=>{await js(`(()=>{const el=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width);if(!el||el.disabled)throw Error('Button unavailable');el.click();})()`);await new Promise(r=>setTimeout(r,100));};
  const menu=()=>js('document.querySelector("[aria-label=\\"More mod actions\\"]").click()');
  const count=()=>js('window.fixtureCalls.filter(c=>c.method==="unsyncModFromGame").length');
  try{
    await win.loadFile(path.join(root,'../redesign-ui.html'));
    await wait('!!document.querySelector(".atlas-projects-page .grid > div > button")');
    await js('document.querySelector(".atlas-projects-page .grid > div > button").click()');
    await wait('!!document.querySelector(".atlas-mod-header")');
    await new Promise(r=>setTimeout(r,250));await menu();await click('Uninstall from RimWorld…');
    await wait('!!document.querySelector("[role=dialog]")');
    assert(await js('document.querySelector("[role=dialog]").textContent.includes("source files and chats stay saved")'));
    win.setContentSize(620,650);await new Promise(r=>setTimeout(r,300));
    assert(await js('(()=>{const d=document.querySelector("[role=dialog]").getBoundingClientRect();return d.top>=0&&d.bottom<=innerHeight+1&&d.left>=0&&d.right<=innerWidth+1;})()'));
    painted=undefined;win.webContents.invalidate();for(let i=0;i<30&&!painted;i++)await new Promise(r=>setTimeout(r,40));if(painted)fs.writeFileSync(path.join(root,'uninstall-confirmation.png'),painted);
    await click('Cancel');assert.equal(await count(),0);
    await js('window.fixtureUninstallError="Save and close RimWorld, then choose Uninstall from RimWorld again."');
    await menu();await click('Uninstall from RimWorld…');await click('Uninstall game copy');
    await wait('document.querySelector("[role=dialog]")?.textContent.includes("Mod not uninstalled")');assert.equal(await count(),1);await click('OK');
    await js('window.fixtureUninstallError=""');
    await menu();await click('Uninstall from RimWorld…');await click('Uninstall game copy');
    await wait('document.querySelector(".atlas-mod-header").textContent.includes("local project kept")');assert.equal(await count(),2);
    await menu();assert.equal(await js('[...document.querySelectorAll("button")].some(e=>e.textContent.trim()==="Uninstall from RimWorld…")'),false);
    assert(await js('document.querySelector(".atlas-mod-header h1").textContent.includes("Silvaran Order")'));
    assert.equal(await js('window.fixtureCalls.some(c=>["deleteWorkspaceMod","deleteConversation","disableModInGame"].includes(c.method))'),false);
    assert.deepEqual(await js('window.fixtureErrors'),[]);
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({menu:true,cancelWithoutRemoval:true,runningGuardError:true,localProjectKept:true,optionHiddenAfterRemoval:true,narrowConfirmationFits:true},null,2));
    app.quit();
  }catch(error){fs.writeFileSync(path.join(root,'error.txt'),String(error.stack));app.exit(1);}
});
