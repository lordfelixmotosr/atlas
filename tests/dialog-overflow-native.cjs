// Pack beside the compiled manual-install-fixture.tsx and production CSS in an
// isolated Electron fixture. No provider calls, game launch or user profile.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.dirname(process.execPath),results=[];
fs.mkdirSync(path.join(root,'data'),{recursive:true});
app.setName('AtlasDialogFixture');app.setPath('userData',path.join(root,'data'));
const log=value=>fs.appendFileSync(path.join(root,'dialog-test.log'),String(value)+'\n');
process.on('uncaughtException',error=>{log(error.stack);app.exit(1);});
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:960,height:700,title:'Atlas long warning dialog verification',webPreferences:{sandbox:true}});
  win.webContents.on('render-process-gone',(_event,details)=>{log(JSON.stringify(details));app.exit(1);});
  win.webContents.on('console-message',(_event,_level,message)=>log(message));
  const evaluate=code=>win.webContents.executeJavaScript(code);
  const wait=async code=>{const end=Date.now()+10000;while(Date.now()<end){if(await evaluate(code))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out: '+code);};
  const click=async(selector,text)=>{await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${JSON.stringify(text)}===null||e.textContent.includes(${JSON.stringify(text)}));if(!e||e.disabled)throw Error('Unavailable control');e.click();})()`);await new Promise(resolve=>setTimeout(resolve,100));};
  const check=async(selector,bodySelector,actionsSelector,scroll)=>{
    const result=await evaluate(`(()=>{
      const panel=document.querySelector(${JSON.stringify(selector)}),body=panel?.querySelector(${JSON.stringify(bodySelector)}),actions=panel?.querySelector(${JSON.stringify(actionsSelector)});
      if(!panel||!body||!actions)throw Error('Missing dialog pieces');
      const p=panel.getBoundingClientRect(),a=actions.getBoundingClientRect(),buttons=[...actions.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};});
      return {viewport:[innerWidth,innerHeight],top:p.top,bottom:p.bottom,left:p.left,right:p.right,actions:[a.top,a.bottom],buttons,horizontalOverflow:body.scrollWidth-body.clientWidth,scrollable:body.scrollHeight>body.clientHeight+1};
    })()`);
    assert(result.top>=0&&result.bottom<=result.viewport[1]+1,JSON.stringify(result));
    assert(result.left>=0&&result.right<=result.viewport[0]+1,JSON.stringify(result));
    assert(result.horizontalOverflow<=1,JSON.stringify(result));
    for(const b of result.buttons)assert(b.top>=0&&b.bottom<=result.viewport[1]&&b.left>=0&&b.right<=result.viewport[0],JSON.stringify(result));
    if(scroll){assert(result.scrollable,JSON.stringify(result));await evaluate(`document.querySelector(${JSON.stringify(bodySelector)}).scrollTop=1000000`);const after=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(actionsSelector)}).getBoundingClientRect();return [r.top,r.bottom]})()`);assert.deepEqual(after,result.actions);}
    return result;
  };
  try{
    if(process.env.ATLAS_DIALOG_AUTOTEST==='1'){
      for(const [width,height] of [[900,600],[620,460],[420,540],[1000,760]]){
        win.setContentSize(width,height);
        await win.loadFile(path.join(root,'../manual-install-ui.html'),{query:{warnings:'500'}});
        await wait('!!document.querySelector("[data-atlas-manual-install]")');
        await click('[data-atlas-manual-install]',null);
        await wait('!!document.querySelector("[data-atlas-install-preview][open]")');
        assert.equal(await evaluate('document.querySelector("[data-atlas-install-preview] details:last-of-type").open'),false);
        await click('[data-atlas-install-preview] summary','Review warnings');
        await check('[data-atlas-install-preview]','[data-atlas-install-body]','[data-atlas-install-actions]',true);
        await click('[data-atlas-install-actions] button','Cancel');
        assert.equal(await evaluate('!!document.querySelector("[data-atlas-app-dialog]")'),false);
        await click('[data-atlas-manual-install]',null);
        await wait('!!document.querySelector("[data-atlas-install-preview][open]")');
        await click('[data-atlas-install-actions] button','Close and install');
        await wait('!!document.querySelector("[data-atlas-app-dialog]")');
        assert.match(await evaluate('document.querySelector("#atlas-app-dialog-message").textContent'),/501 warnings/);
        assert.equal(await evaluate('!!document.querySelector("[data-atlas-manual-install]")'),false,'Completed installer must not remain busy');
        assert.equal(await evaluate('document.querySelector("[data-atlas-app-dialog] details").open'),false);
        await check('[data-atlas-app-dialog]','[data-atlas-dialog-body]','[data-atlas-dialog-actions]',false);
        await click('[data-atlas-app-dialog] summary','View details');
        assert.equal(await evaluate('document.querySelectorAll("[data-atlas-app-dialog] li").length'),501,'All unique warnings must remain available');
        const geometry=await check('[data-atlas-app-dialog]','[data-atlas-dialog-body]','[data-atlas-dialog-actions]',true);
        await click('[data-atlas-dialog-actions] button','OK');
        await click('main button','Long diagnostic');
        await wait('!!document.querySelector("[data-atlas-app-dialog]")');
        await check('[data-atlas-app-dialog]','[data-atlas-dialog-body]','[data-atlas-dialog-actions]',true);
        await click('[data-atlas-dialog-actions] button','OK');
        await click('main button','Long confirmation');
        await wait('!!document.querySelector("[data-atlas-app-dialog]")');
        await check('[data-atlas-app-dialog]','[data-atlas-dialog-body]','[data-atlas-dialog-actions]',true);
        await click('[data-atlas-dialog-actions] button','Cancel');
        assert.equal(await evaluate('document.querySelector("[data-fixture-answer]").textContent'),'false');
        await click('[aria-label="More mod actions"]',null);
        await click('button','Restore previous version');
        await wait('!!document.querySelector("[data-atlas-install-preview][open]")');
        await check('[data-atlas-install-preview]','[data-atlas-install-body]','[data-atlas-install-actions]',false);
        await click('[data-atlas-install-actions] button','Restore version');
        await wait('!!document.querySelector("[data-atlas-app-dialog]")');
        assert.match(await evaluate('document.querySelector("#atlas-app-dialog-title").textContent'),/Restored with warnings/);
        await click('[data-atlas-app-dialog] summary','View details');
        await check('[data-atlas-app-dialog]','[data-atlas-dialog-body]','[data-atlas-dialog-actions]',true);
        await click('[data-atlas-dialog-actions] button','OK');
        results.push({width,height,warningCount:501,geometry,previewCancel:true,installationCompleted:true,warningsDeduplicated:true,allWarningsAvailable:true,rawAlertScrollable:true,confirmationCancel:true,restoreCompleted:true});
      }
      fs.writeFileSync(path.join(root,'dialog-result.json'),JSON.stringify({passed:true,results},null,2));app.quit();
    }else{await win.loadFile(path.join(root,'../manual-install-ui.html'),{query:{warnings:'500'}});win.show();win.focus();}
  }catch(error){log(error.stack);fs.writeFileSync(path.join(root,'dialog-result.json'),JSON.stringify({passed:false,error:error.stack,results},null,2));app.exit(1);}
}).catch(error=>{log(error.stack);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
