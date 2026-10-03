'use strict';
const fs=require('node:fs'),path=require('node:path');
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
    const settingsFile=path.join(root,'data','profile','pi-agent','settings.json');
    fs.mkdirSync(path.dirname(settingsFile),{recursive:true});
    const settings=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{};
    settings.shellPath=shell;
    const temporary=settingsFile+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify(settings,null,2)+'\n');fs.renameSync(temporary,settingsFile);
    const pathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path')??'PATH';
    process.env[pathKey]=path.join(root,'tools','git','cmd')+path.delimiter+(process.env[pathKey]??'');
    fs.mkdirSync(path.join(root,'data','git'),{recursive:true});
    const gitConfig=path.join(root,'data','git','config');if(!fs.existsSync(gitConfig))fs.writeFileSync(gitConfig,'');
    process.env.GIT_CONFIG_GLOBAL=gitConfig;
    process.env.GIT_CONFIG_SYSTEM=path.join(root,'tools','git','etc','gitconfig');
  }
  process.env.ATLAS_ROOT=root;
  return root;
}
module.exports={bootstrap};
