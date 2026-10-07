'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const transientFileErrors=new Set(['EPERM','EACCES','EBUSY']);
function rememberShell(root,shell){
  const settingsFile=path.join(root,'data/profile/pi-agent/settings.json');
  let temporary;
  try{
    fs.mkdirSync(path.dirname(settingsFile),{recursive:true});
    const settings=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{};
    if(!settings||typeof settings!=='object'||Array.isArray(settings))throw new Error('Invalid agent settings');
    // Opening Atlas again must not replace an unchanged settings file. This
    // also lets a second launch reach Electron's single-instance handoff.
    if(settings.shellPath===shell)return;
    settings.shellPath=shell;
    temporary=settingsFile+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(settings,null,2)+'\n',{flag:'wx'});
    for(let attempt=0;;attempt++){
      try{fs.renameSync(temporary,settingsFile);break;}
      catch(error){
        if(!transientFileErrors.has(error.code)||attempt>=3)throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40*(attempt+1));
      }
    }
  }catch(error){
    // The shell is selected in memory too. Preserve the existing settings
    // and continue startup when a scanner or another process locks the file.
    const message='[Atlas startup] Agent shell setting was not saved ('+(error.code||'invalid settings')+'); using the bundled shell for this launch.';
    console.warn(message);
    try{fs.appendFileSync(path.join(root,'data/logs/startup.log'),new Date().toISOString()+' '+message+'\n');}catch{}
  }finally{
    if(temporary)try{fs.unlinkSync(temporary);}catch{}
  }
}
function bootstrap(app,root=path.dirname(process.execPath)) {
  root=path.resolve(root);
  app.setName('Atlas');
  for(const dir of ['data/profile','data/cache/browser','data/logs','custom/skills','custom/game-adapters','custom/references','custom/art-profiles','library','backups','updates'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const probe=path.join(root,'data','.write-'+process.pid);fs.writeFileSync(probe,'Atlas');fs.unlinkSync(probe);
  app.setPath('userData',path.join(root,'data','profile'));
  app.setPath('sessionData',path.join(root,'data','cache','browser'));
  app.setAppLogsPath(path.join(root,'data','logs'));
  const models=path.join(root,'data','profile','pi-agent','models.json');
  const defaults=path.join(__dirname,'default-models.json');
  if(!fs.existsSync(models)&&fs.existsSync(defaults)){fs.mkdirSync(path.dirname(models),{recursive:true});fs.copyFileSync(defaults,models);}
  const shell=path.join(root,'tools','git','bin','bash.exe');
  if(fs.existsSync(shell)){
    process.env.ATLAS_SHELL_PATH=shell;
    rememberShell(root,shell);
    const pathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path')??'PATH';
    process.env[pathKey]=path.join(root,'tools','git','cmd')+path.delimiter+(process.env[pathKey]??'');
    fs.mkdirSync(path.join(root,'data','git'),{recursive:true});
    const gitConfig=path.join(root,'data','git','config');if(!fs.existsSync(gitConfig))fs.writeFileSync(gitConfig,'');
    process.env.GIT_CONFIG_GLOBAL=gitConfig;
    process.env.GIT_CONFIG_SYSTEM=path.join(root,'tools','git','etc','gitconfig');
  }else delete process.env.ATLAS_SHELL_PATH;
  process.env.ATLAS_ROOT=root;
  return root;
}
module.exports={bootstrap};
