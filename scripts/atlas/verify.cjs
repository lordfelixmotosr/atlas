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
  win.webContents.once('did-finish-load',()=>{if(win.webContents.getURL().startsWith('data:'))return;setTimeout(async()=>{
   try{
    const result=await win.webContents.executeJavaScript(`(async()=>({version:await window.modmixer.getAppVersion(),library:await window.modmixer.atlasLibraryStatus(),app:await window.modmixer.atlasAppStatus(),modelIds:(await window.modmixer.listModels()).map(model=>({id:model.id,contextWindow:model.contextWindow})),body:document.body.innerText,title:document.title,hasLibraryApi:typeof window.modmixer.atlasLibrarySearch==='function'}))()`);
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
    const projectFiles=await win.webContents.executeJavaScript(`window.modmixer.projectFiles(${folder})`);
    result.nativeFileBrowser={files:projectFiles.files.length,listsDef:projectFiles.files.some(file=>file.path==='Defs/test.xml'),excludesMetadata:projectFiles.files.every(file=>!file.path.startsWith('.')),truncated:projectFiles.truncated};
    if(!result.nativeFileBrowser.listsDef||!result.nativeFileBrowser.excludesMetadata)throw new Error('Native file browser verification failed.');
    const libraryMods=await win.webContents.executeJavaScript('window.modmixer.listWorkspaceMods()');
    result.nativeChanges={started:tracked.status,marked:clean.status,status:changes.status,count:changes.count,describesDef:changes.files.some(file=>file.description.includes('Added ThingDef NativeArmor')),librarySummary:libraryMods.find(mod=>mod.folder===JSON.parse(folder))?.changes?.count===2,baselineOutsideMod:fs.existsSync(path.join(path.dirname(copied),'.atlas/mod-changes',imported.imported[0].folder,'state.json'))};
    if(tracked.status!=='tracking'||clean.status!=='clean'||changes.status!=='modified'||changes.count!==2||Object.values(result.nativeChanges).includes(false))throw new Error('Native change report verification failed.');
    result.profile=app.getPath('userData');result.cache=app.getPath('sessionData');
    write(result);try{const picture=await win.webContents.capturePage();fs.writeFileSync(path.join(root,'data','Atlas-first-run.png'),picture.toPNG());}catch(error){result.screenshotError=error.message;}
    write(result);app.exit(0);
   }catch(error){write({error:error.stack});app.exit(1);}
  },2500);});
 });
 setTimeout(()=>{write({error:'Atlas did not finish loading within 50 seconds.'});app.exit(1);},50000).unref();
}
module.exports={init};
