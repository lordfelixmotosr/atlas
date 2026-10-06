'use strict';
// Included only in --verify-build artifacts, never in the delivered application.
const fs=require('node:fs'),path=require('node:path'),{app}=require('electron');
function init(){
 const root=path.dirname(process.execPath),report=path.join(root,'data','verify-report.json');
 fs.mkdirSync(path.join(root,'data'),{recursive:true});
 fs.writeFileSync(path.join(root,'data/atlas-library.json'),JSON.stringify({source:'updates',autoUpdate:false,feedRevision:1}));
 const write=value=>{fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,JSON.stringify(value,null,2));};
 process.on('uncaughtException',error=>{write({error:error.stack});app.exit(1);});
 process.on('unhandledRejection',error=>{write({error:String(error?.stack??error)});app.exit(1);});
 app.on('browser-window-created',(_event,win)=>{
  const diagnostic=message=>fs.appendFileSync(path.join(root,'data/native-renderer.log'),message+'\n');
  diagnostic('Window created');
  win.webContents.on('console-message',(_e,level,message)=>diagnostic('Console '+level+': '+message));
  win.webContents.on('did-fail-load',(_e,code,description,url)=>diagnostic('Load failure '+code+': '+description+' '+url));
  win.webContents.on('render-process-gone',(_e,details)=>diagnostic('Renderer stopped: '+JSON.stringify(details)));
  win.webContents.on('did-stop-loading',()=>diagnostic('Loading stopped: '+win.webContents.getURL()));
  win.webContents.once('did-finish-load',()=>{if(win.webContents.getURL().startsWith('data:'))return;setTimeout(async()=>{
   try{
    const result=await win.webContents.executeJavaScript(`(async()=>({version:await window.modmixer.getAppVersion(),library:await window.modmixer.atlasLibraryStatus(),app:await window.modmixer.atlasAppStatus(),modelIds:(await window.modmixer.listModels()).map(model=>({id:model.id,contextWindow:model.contextWindow})),body:document.body.innerText,title:document.title,hasLibraryApi:typeof window.modmixer.atlasLibrarySearch==='function'}))()`);
    if(process.env.ATLAS_VERIFY_BRANDING_ONLY){
     result.nativeBranding=await win.webContents.executeJavaScript(`(async()=>{const deadline=Date.now()+10000;let image;while(!(image=document.querySelector('.atlas-logo'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));if(!image)throw new Error('Atlas header logo is missing');await image.decode();const box=image.getBoundingClientRect();return {loaded:image.complete,width:image.naturalWidth,height:image.naturalHeight,displayWidth:box.width,displayHeight:box.height,source:image.currentSrc}})()`);
     if(!result.nativeBranding.loaded||result.nativeBranding.width<=0||result.nativeBranding.height<=0)throw new Error('The supplied Atlas globe logo did not load.');
     fs.writeFileSync(path.join(root,'data/Atlas-logo-ui.png'),(await win.webContents.capturePage()).toPNG());
     write(result);app.exit(0);return;
    }
    if(process.env.ATLAS_VERIFY_COMPOSER_ONLY){
     const {BrowserWindow}=require('electron'),{pathToFileURL}=require('node:url');
     const rendererRoot=path.join(__dirname,'../../renderer/main_window');
     const builtHtml=fs.readFileSync(path.join(rendererRoot,'index.html'),'utf8');
     const csp=builtHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?\s*>/i);
     if(!csp)throw new Error('Production image policy is missing.');
     const cssRoot=path.join(rendererRoot,'assets'),css=fs.readdirSync(cssRoot).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join(cssRoot,name),'utf8')).join('\n');
     const createFixture=async()=>{
      const fixtureWin=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
      await fixtureWin.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><head>'+csp[0]+'</head><body><div id="root" style="display:flex;flex-direction:column;width:1100px;height:650px"></div></body></html>'));
      await fixtureWin.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark');document.head.appendChild(Object.assign(document.createElement('style'),{textContent:${JSON.stringify(css)}}));window.modmixer=new Proxy({onEvent:()=>()=>{}},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});void 0;`);
      return fixtureWin;
     };
     if(!process.env.ATLAS_VERIFY_TOOLBAR_BUNDLE||!process.env.ATLAS_VERIFY_IMAGE_BUNDLE)throw new Error('Composer verification bundles are missing.');
     const toolbarWin=await createFixture();
     try{
      await toolbarWin.webContents.executeJavaScript(fs.readFileSync(process.env.ATLAS_VERIFY_TOOLBAR_BUNDLE,'utf8'));
      result.nativeComposer=await toolbarWin.webContents.executeJavaScript('window.__atlasToolbarTest.run()');
      for(const [name,width] of [['credits',1100],['zero',650],['unavailable',360]]){
       await toolbarWin.webContents.executeJavaScript(`window.__atlasToolbarTest.state(${JSON.stringify(name)},${width})`);
       toolbarWin.webContents.invalidate();
       await new Promise(resolve=>setTimeout(resolve,500));
       fs.writeFileSync(path.join(root,'data','Atlas-toolbar-'+name+'.png'),(await toolbarWin.webContents.capturePage()).toPNG());
      }
      await toolbarWin.webContents.executeJavaScript('window.__atlasToolbarTest.close()');
     }finally{toolbarWin.destroy();}
     const fixtureMod=path.join(app.getPath('userData'),'workspace/Mods/atlas-image-fixture'),previewDir=path.join(fixtureMod,'Tests/Previews');
     fs.mkdirSync(path.join(fixtureMod,'About'),{recursive:true});fs.mkdirSync(previewDir,{recursive:true});
     fs.writeFileSync(path.join(fixtureMod,'About/About.xml'),'<ModMetaData><name>Atlas image fixture</name><packageId>felix.imagefixture</packageId></ModMetaData>');
     const sample=path.join(previewDir,'sample.png'),outside=path.join(root,'data/image-outside.png'),imageBytes=fs.readFileSync(path.join(process.resourcesPath,'atlas/icon.png'));
     for(const destination of [sample,path.join(previewDir,'sample image.png'),outside])fs.writeFileSync(destination,imageBytes);
     const imageWin=await createFixture();
     try{
      await imageWin.webContents.executeJavaScript(`window.__atlasImagePaths=${JSON.stringify({absolute:sample,fileUrl:pathToFileURL(sample).href,outside})};void 0;`);
      await imageWin.webContents.executeJavaScript(fs.readFileSync(process.env.ATLAS_VERIFY_IMAGE_BUNDLE,'utf8'));
      result.nativeChatImages=await imageWin.webContents.executeJavaScript('window.__atlasImageTest.run()');
      await imageWin.webContents.executeJavaScript("document.getElementById('root').style.width='1100px';void 0;");
      imageWin.webContents.invalidate();
      await new Promise(resolve=>setTimeout(resolve,500));
      fs.writeFileSync(path.join(root,'data/Atlas-chat-images.png'),(await imageWin.webContents.capturePage()).toPNG());
     }finally{imageWin.destroy();}
     write(result);app.exit(0);return;
    }
    const verifyGameRoot=process.env.ATLAS_VERIFY_GAME_ROOT;
    if(verifyGameRoot){const picker=require('electron').dialog,originalPicker=picker.showOpenDialog;try{picker.showOpenDialog=async()=>({canceled:false,filePaths:[verifyGameRoot]});await win.webContents.executeJavaScript('window.modmixer.browseRimWorldInstall()');}finally{picker.showOpenDialog=originalPicker;}}
    result.nativeOdyssey=await win.webContents.executeJavaScript(`(async()=>{const env=await window.modmixer.refreshRegistry(),mod=env.snapshot.mods.find(entry=>entry.about.packageIdLc==='ludeon.rimworld.odyssey');return {installed:!!mod,official:mod?.source==='official',activeInNormalProfile:env.snapshot.activeOrder.includes('ludeon.rimworld.odyssey')}})()`);
    if(verifyGameRoot&&fs.existsSync(path.join(verifyGameRoot,'Data/Odyssey'))&&!result.nativeOdyssey.installed)throw new Error('Installed Odyssey was not detected through the native registry.');
    if(result.nativeOdyssey.installed&&!result.nativeOdyssey.official)throw new Error('Installed Odyssey must be recognized as official content.');
    result.nativeOpenAILogin=await win.webContents.executeJavaScript(`(async()=>{let message='';try{await window.modmixer.loginOpenAIAccount(undefined,'')}catch(error){message=error.message}const accounts=await window.modmixer.getOpenAIAccounts();return {validationReached:message.includes('Account names must be'),noMissingHelper:!message.includes('is not defined'),busyCleared:!accounts.busy,accounts:accounts.accounts.length,providerSignInPerformed:false}})()`);
    if(!result.nativeOpenAILogin.validationReached||!result.nativeOpenAILogin.noMissingHelper||!result.nativeOpenAILogin.busyCleared)throw new Error('Native account login preparation failed.');
    await win.webContents.executeJavaScript("window.modmixer.atlasLibraryOpenReference('rimworld-forge','references/source/__init__.py')");result.referenceWindowOpened=require('electron').BrowserWindow.getAllWindows().some(window=>window.getTitle().includes('__init__.py'));
    const detected=await win.webContents.executeJavaScript('window.modmixer.modMixerImportPlan()');
    result.modMixerDetection={found:!!detected.source,projects:detected.rows.length,ready:detected.rows.filter(row=>row.status==='ready').length};
    const fixtureFolder='native-fixture-'+Date.now(),fixture=path.join(root,'data/verify-import-source/workspace/Mods'),original=path.join(fixture,fixtureFolder);
    fs.mkdirSync(path.join(original,'About'),{recursive:true});fs.mkdirSync(path.join(original,'.modmixer'),{recursive:true});fs.mkdirSync(path.join(original,'Textures'),{recursive:true});
    fs.writeFileSync(path.join(original,'About/About.xml'),'<ModMetaData><name>Native import fixture</name><packageId>felix.nativefixture</packageId><supportedVersions><li>1.6</li></supportedVersions></ModMetaData>');
    const prefs=JSON.stringify({game:'rimworld',pinned:true,archived:false,license:'MIT'});fs.writeFileSync(path.join(original,'.modmixer/prefs.json'),prefs);fs.writeFileSync(path.join(original,'Textures/test.png'),Buffer.from([0,255,71,1,2,3]));
    await win.webContents.executeJavaScript('window.modmixer.acceptConsent({analyticsOptIn:false})');
    const nativeDialog=require('electron').dialog,openDialog=nativeDialog.showOpenDialog;let plan;
    try{nativeDialog.showOpenDialog=async()=>({canceled:false,filePaths:[fixture]});plan=await win.webContents.executeJavaScript('window.modmixer.modMixerImportPlan(true)');}finally{nativeDialog.showOpenDialog=openDialog;}
    const imported=await win.webContents.executeJavaScript(`window.modmixer.modMixerImportApply(${JSON.stringify(plan.token)},[${JSON.stringify(fixtureFolder)}])`);
    const copied=path.join(app.getPath('userData'),'workspace/Mods',imported.imported[0].folder);
    const repeated=await win.webContents.executeJavaScript('window.modmixer.modMixerImportPlan()');
    result.nativeModImport={imported:imported.imported.length,failed:imported.failed.length,sourceUntouched:fs.readFileSync(path.join(original,'.modmixer/prefs.json'),'utf8')===prefs,atlasMetadata:fs.readFileSync(path.join(copied,'.atlas/prefs.json'),'utf8')===prefs,noLegacyFolder:!fs.existsSync(path.join(copied,'.modmixer')),binaryIdentical:fs.readFileSync(path.join(original,'Textures/test.png')).equals(fs.readFileSync(path.join(copied,'Textures/test.png'))),repeatStatus:repeated.rows.find(row=>row.folder===fixtureFolder).status};
    if(imported.imported.length!==1||Object.values(result.nativeModImport).includes(false)||result.nativeModImport.repeatStatus!=='imported')throw new Error('Native mod import verification failed.');
    const folder=JSON.stringify(imported.imported[0].folder);
    const tracked=await win.webContents.executeJavaScript(`window.modmixer.modChanges(${folder})`);
    const clean=await win.webContents.executeJavaScript(`window.modmixer.markModUpdated(${folder},'Native verification baseline')`);
    fs.mkdirSync(path.join(copied,'Defs'),{recursive:true});fs.writeFileSync(path.join(copied,'Defs/test.xml'),'<Defs><ThingDef><defName>NativeArmor</defName><label>native armor</label></ThingDef></Defs>');
    fs.writeFileSync(path.join(copied,'Textures/test.png'),Buffer.from([0,255,71,4,5,6]));
    const changes=await win.webContents.executeJavaScript(`window.modmixer.modChanges(${folder})`);
    const descriptionText='Added native armor for colonists and changed its artwork.';
    const described=await win.webContents.executeJavaScript(`window.modmixer.saveModDescription(${folder},'latest',${JSON.stringify(changes.descriptionKey)},${JSON.stringify(descriptionText)})`);
    fs.writeFileSync(path.join(copied,'Textures/test.png'),Buffer.from([0,255,71,7,8,9]));
    const changedAgain=await win.webContents.executeJavaScript(`window.modmixer.modChanges(${folder})`);
    const staleRejected=await win.webContents.executeJavaScript(`(async()=>{try{await window.modmixer.saveModDescription(${folder},'latest',${JSON.stringify(changes.descriptionKey)},'stale description');return false}catch(error){return error.message.includes('changed')}})()`);
    await win.webContents.executeJavaScript(`window.modmixer.cancelModDescription(${folder})`);
    result.nativeFeatureDescriptions={namedFeature:changes.features.added.some(text=>text.includes('native armor')),descriptionSaved:described.featureDescription===descriptionText,baselineStillModified:described.status==='modified',invalidatedAfterEdit:!changedAgain.featureDescription,staleRejected,noModelCalls:true};
    if(Object.values(result.nativeFeatureDescriptions).includes(false))throw new Error('Native feature-description verification failed.');
    const projectFiles=await win.webContents.executeJavaScript(`window.modmixer.projectFiles(${folder})`);
    await win.webContents.executeJavaScript(`window.modmixer.projectDraftState(${folder},true)`);result.nativeDraftGuard=globalThis.__atlasRuntime.application.restartBlockReason();if(!result.nativeDraftGuard?.includes('file edits'))throw new Error('Native draft guard failed.');await win.webContents.executeJavaScript(`window.modmixer.projectDraftState(${folder},false)`);
    result.nativeTextSearch=await win.webContents.executeJavaScript(`window.modmixer.projectSearch(${folder},'NativeArmor',{token:'native-test'})`);if(result.nativeTextSearch.matches.length!==1||result.nativeTextSearch.matches[0].line!==1)throw new Error('Native content search failed.');
    result.nativeTasks=await win.webContents.executeJavaScript(`window.modmixer.atlasTasksStatus()`);if(!Array.isArray(result.nativeTasks))throw new Error('Native tasks API failed.');
    result.nativeFileBrowser={files:projectFiles.files.length,listsDef:projectFiles.files.some(file=>file.path==='Defs/test.xml'),excludesMetadata:projectFiles.files.every(file=>!file.path.startsWith('.')),truncated:projectFiles.truncated};
    if(!result.nativeFileBrowser.listsDef||!result.nativeFileBrowser.excludesMetadata)throw new Error('Native file browser verification failed.');
    const libraryMods=await win.webContents.executeJavaScript('window.modmixer.listWorkspaceMods()');
    result.nativeChanges={started:tracked.status,marked:clean.status,status:changes.status,count:changes.count,describesDef:changes.files.some(file=>file.description.includes('Added ThingDef NativeArmor')),librarySummary:libraryMods.find(mod=>mod.folder===JSON.parse(folder))?.changes?.count===2,baselineOutsideMod:fs.existsSync(path.join(path.dirname(copied),'.atlas/mod-changes',imported.imported[0].folder,'state.json'))};
    if(tracked.status!=='tracking'||clean.status!=='clean'||changes.status!=='modified'||changes.count!==2||Object.values(result.nativeChanges).includes(false))throw new Error('Native change report verification failed.');
    if(process.env.ATLAS_VERIFY_CHAT_BUNDLE){
     const layoutWin=new (require('electron').BrowserWindow)({show:false,width:1200,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});
     try{
      await layoutWin.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><head></head><body><div id="root" style="display:flex;flex-direction:column;width:1000px;height:650px"></div></body></html>'));
      const cssRoot=path.join(__dirname,'../../renderer/main_window/assets'),css=fs.readdirSync(cssRoot).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join(cssRoot,name),'utf8')).join('\n');
      await layoutWin.webContents.executeJavaScript(`document.documentElement.classList.add('dark');document.head.appendChild(Object.assign(document.createElement('style'),{textContent:${JSON.stringify(css)}}));window.modmixer=new Proxy({onEvent:()=>()=>{},getAgentStatus:async()=>({busy:false,compacting:false}),getContextUsage:async()=>null},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});void 0;`);
      await layoutWin.webContents.executeJavaScript(fs.readFileSync(process.env.ATLAS_VERIFY_CHAT_BUNDLE,'utf8'));
      result.nativeChatLayout=await layoutWin.webContents.executeJavaScript('window.__atlasChatLayoutTest.run()');
     }finally{layoutWin.destroy();}
    }
    result.profile=app.getPath('userData');result.cache=app.getPath('sessionData');
    write(result);try{const picture=await win.webContents.capturePage();fs.writeFileSync(path.join(root,'data','Atlas-first-run.png'),picture.toPNG());}catch(error){result.screenshotError=error.message;}
    write(result);app.exit(0);
   }catch(error){write({error:error.stack});app.exit(1);}
  },2500);});
 });
 setTimeout(()=>{write({error:'Atlas did not finish loading within 75 seconds.'});app.exit(1);},75000).unref();
}
module.exports={init};
