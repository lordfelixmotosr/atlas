'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Library}=require('./library.cjs');
const {Tasks}=require('./tasks.cjs');
const {ApplicationUpdate}=require('./application-update.cjs');
const {openReference}=require('./reference-view.cjs');
function init({root,resources,host,getWindow,electron,rebuildIndex,invalidatePaths,isBusy,cancelIndex,requireConsent,hasDrafts}) {
  const {ipcMain,shell,dialog}=electron;
  const busy=isBusy??(()=>host.felixAccountOperation||host.pendingOAuth||host.felixOpenAIStarting>0||[...host.sessions.values()].some(({session})=>session.felixManualCompacting||!session.isIdle||session.agent?.abortController||session.agent?.state?.isStreaming||session.isCompacting||session.isRetrying));
  const library=new Library(root,resources,{busy});
  const tasks=new Tasks(state=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('atlas:tasks:state',state);});
  const application=new ApplicationUpdate(library,electron,busy,{restartBlockReason:()=>hasDrafts?.()?'Save or discard your file edits before restarting Atlas.':tasks.items.get('index:rimworld')?.status==='running'?'Finish or stop reference indexing before restarting Atlas.':null,onState:state=>{tasks.observeDownload(state);const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('atlas:app:state',state);}});
  let timer=null,disposed=false;
  const referenceWindows=new Set();
  const broadcast=()=>{const win=getWindow();if(win&&!win.isDestroyed()){win.webContents.send('atlas:library:state',library.status());win.webContents.send('atlas:app:state',application.status());}};
  const act=async fn=>{try{return await fn();}finally{invalidatePaths?.();broadcast();}};
  const handle=(name,fn)=>ipcMain.handle('atlas:library:'+name,(_event,...args)=>fn(...args));
  handle('status',()=>library.status());
  handle('configure',patch=>act(()=>library.configure(patch)));
  handle('check',()=>act(()=>library.check()));
  handle('update',()=>act(()=>library.update()));
  handle('revert',id=>act(()=>library.revert(id)));
  handle('search',query=>library.search(query));
  handle('open-reference',(id,relative)=>openReference(library.file(id,relative),electron,getWindow(),referenceWindows));
  handle('reveal',async id=>{const target=id?library.packDir(id,library.state.active[id]):path.join(root,'library');if(!fs.existsSync(target))throw new Error('Library folder does not exist.');const error=await shell.openPath(target);if(error)throw new Error(error);});
  handle('custom',async()=>{const error=await shell.openPath(path.join(root,'custom'));if(error)throw new Error(error);});
  handle('choose-source',async()=>{const result=await dialog.showOpenDialog(getWindow(),{title:'Choose Atlas update folder',properties:['openDirectory']});return result.canceled?null:act(()=>library.configure({source:result.filePaths[0]}));});
  handle('rebuild',async()=>{if(busy())throw new Error('Finish active work before rebuilding the game index.');return rebuildIndex();});
  ipcMain.handle('atlas:app:status',()=>application.status());
  ipcMain.handle('atlas:app:check',()=>act(()=>application.check()));
  ipcMain.handle('atlas:app:download',(_e,options)=>act(()=>application.download(options)));
  ipcMain.handle('atlas:app:pause',()=>application.pause());
  ipcMain.handle('atlas:app:cancel',()=>application.cancel());
  ipcMain.handle('atlas:tasks:status',()=>tasks.status());
  ipcMain.handle('atlas:tasks:clear',()=>tasks.clear());
  ipcMain.handle('atlas:tasks:action',async(_e,id,action)=>{
    const task=tasks.items.get(id);if(!task)throw new Error('Task is no longer available.');
    if(task.kind==='sprite'&&task.status==='running')return host.atlasSpriteTaskAction?.(task.projectId,action);
    if(task.kind==='download'){if(action==='pause')return application.pause();if(action==='cancel')return application.cancel();if(action==='retry')return application.download();if(action==='install')return application.install();}
    if(task.kind==='index'){if(action==='cancel'&&task.status==='running'){tasks.update(id,{cancelRequested:true,phase:'Stopping index'});return cancelIndex?.();}if(action==='retry'&&task.status!=='running'){if(busy())throw new Error('Finish active work before rebuilding the index.');return rebuildIndex();}}
    if(['chat','build'].includes(task.kind)){if(action==='cancel'&&task.status==='running')return host.interrupt(task.conversationId);if(action==='retry'&&task.kind==='chat'&&['failed','cancelled'].includes(task.status)){requireConsent?.();return host.retry(task.conversationId);}}
    throw new Error('This action is unavailable for this task.');
  });
  ipcMain.handle('atlas:app:install',()=>application.install());
  const tick=async()=>{
    if(disposed)return;
    try{
      if(library.activatePending()){invalidatePaths?.();broadcast();}
      if(library.config.autoUpdate&&!library.working&&Date.now()-(library.config.lastCheckedAt??0)>=86400000){try{await library.update();}catch(error){console.warn('[atlas:library]',error.message);}await application.check();if(application.available&&!application.ready)await application.download({automatic:true});invalidatePaths?.();broadcast();}
    }catch(error){console.warn('[atlas:library]',error.message);broadcast();}
  };
  const ready=(async()=>{await library.seed();invalidatePaths?.();broadcast();timer=setInterval(tick,60000);timer.unref();void tick();})().catch(error=>{console.error('[atlas:library] Initialization failed:',error.message);});
  electron.app.on('before-quit',()=>{disposed=true;tasks.dispose();if(timer)clearInterval(timer);});
  const result={library,application,tasks,ready};globalThis.__atlasRuntime=result;return result;
}
module.exports={init};
