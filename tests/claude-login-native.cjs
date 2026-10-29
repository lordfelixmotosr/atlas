// Actual Settings React component, mocked IPC, no user profile or live auth.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();
const root=path.dirname(process.execPath);
fs.mkdirSync(path.join(root,'data'),{recursive:true});app.setPath('userData',path.join(root,'data'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,offscreen:true}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
 let painted;win.webContents.on('paint',(_event,_dirty,image)=>{const bytes=image.toPNG();if(bytes.length)painted=bytes;});
 const js=code=>win.webContents.executeJavaScript(code);
 const wait=async code=>{for(let i=0;i<200;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,40));}throw Error('Timed out: '+code);};
 const click=async(text,selector='button')=>{await js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable button');b.click();})()`);};
 const count=()=>js('window.fixtureCalls.filter(c=>c.method==="loginOAuth").length');
 try{
  await win.loadFile(path.join(root,'../redesign-ui.html'));await wait('!!document.querySelector(".atlas-main-navigation")');
  await js('window.fixtureOAuthLinks=[{id:"anthropic",name:"Claude Pro / Max",label:"Claude",linked:false,retryAt:Date.now()+60000,retrySource:"local"}]');
  await click('Settings','.atlas-main-navigation button');await wait('!!document.querySelector(".atlas-settings-layout")');
  await click('Accounts & models','.atlas-settings-navigation button');
  await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Try again in"))');
  assert(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Try again in")).disabled'));
  assert(await js('document.body.textContent.includes("Atlas is pausing attempts locally")'));
  assert.equal(await count(),0);
  await js('window.fixtureOAuthLinks[0].retrySource="provider";window.emitFixture("onOAuthEvent",{type:"links-changed"})');
  await wait('document.body.textContent.includes("Claude requested this wait")');
  win.setContentSize(620,800);await new Promise(r=>setTimeout(r,200));
  assert(await js('document.documentElement.scrollWidth<=innerWidth+1'),'Settings overflows narrow window');
  await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Try again in")).scrollIntoView({block:"center"})');
  painted=undefined;win.webContents.invalidate();for(let i=0;i<30&&!painted;i++)await new Promise(r=>setTimeout(r,40));
  if(painted)fs.writeFileSync(path.join(root,'claude-cooldown.png'),painted);
  await js('window.fixtureOAuthLinks[0].retryAt=Date.now()+1800;window.emitFixture("onOAuthEvent",{type:"links-changed"})');
  await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Sign in"&&!b.disabled)');
  assert.equal(await count(),0,'Cooldown expiry triggered login');
  await click('Sign in');await wait('window.fixtureCalls.some(c=>c.method==="loginOAuth")');assert.equal(await count(),1);
  await js('window.emitFixture("onOAuthEvent",{type:"login-start",providerId:"anthropic"});window.emitFixture("onOAuthEvent",{type:"login-progress",providerId:"anthropic",message:"Opening your browser to sign in…"})');
  await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Cancel")');await click('Cancel');
  await js('window.emitFixture("onOAuthEvent",{type:"login-cancelled",providerId:"anthropic"})');
  await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Sign in")');
  assert.deepEqual(await js('window.fixtureErrors'),[]);
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({disabledDuringCooldown:true,localAndProviderWaitExplained:true,narrowLayoutFits:true,noAutomaticRetry:true,manualAttemptOnly:true,cancellationRecovers:true},null,2));app.quit();
 }catch(error){fs.writeFileSync(path.join(root,'error.txt'),String(error.stack));app.exit(1);}
});
