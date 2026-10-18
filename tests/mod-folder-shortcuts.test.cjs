const test=require('node:test');
const {load,fixture,fs,path,assert}=require('./runtime-fixture.cjs');
const links=load('atlas/mod-folder-shortcuts.ts');
const mod=(updatedAt=Date.now(),folder='Example')=>({folder,updatedAt,about:{name:'My mod',author:'Felix',packageId:'felix.example'}});
const shell={writeShortcutLink:(file,_op,data)=>{fs.writeFileSync(file,JSON.stringify(data));return true;}};
test('readable shortcut names sanitize Windows paths and retain stable project IDs',()=>{
  assert.match(links.modShortcutName(mod(1792304100000)),/^felix\.example\.\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.[a-f0-9]{6}\.lnk$/);
  const m=mod();m.about.packageId='CON.invalid:/name?';assert.match(links.modShortcutName(m),/^_CON\.invalid__name_/);
});
test('refresh only replaces owned shortcuts and never renames workspace folders',async t=>{
  const f=fixture(t),profile=path.join(f.root,'profile'),workspace=path.dirname(f.source),m=mod(1000);
  const first=await links.refreshModShortcuts(profile,workspace,[m],shell),name=links.modShortcutName(m),link=path.join(first.directory,name);
  assert.equal(JSON.parse(fs.readFileSync(link)).target,f.source);assert(fs.existsSync(f.source));
  fs.writeFileSync(path.join(first.directory,'user.txt'),'keep');fs.writeFileSync(link,'manually edited');
  const next=mod(2000);await links.refreshModShortcuts(profile,workspace,[next],shell);
  assert.equal(fs.readFileSync(link,'utf8'),'manually edited');assert(fs.existsSync(path.join(first.directory,links.modShortcutName(next))));
  const last=mod(3000);await links.refreshModShortcuts(profile,workspace,[last],shell);
  assert(!fs.existsSync(path.join(first.directory,links.modShortcutName(next))));assert(fs.existsSync(path.join(first.directory,'user.txt')));assert(fs.existsSync(f.source));
});
test('unknown files and corrupt ownership indexes are preserved',async t=>{
  const f=fixture(t),profile=path.join(f.root,'profile'),directory=path.join(profile,'Mod folders'),m=mod(1000);fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,links.modShortcutName(m));fs.writeFileSync(file,'not owned');
  fs.writeFileSync(path.join(profile,'mod-folder-shortcuts.json'),JSON.stringify({version:1,links:{Example:{file:4},other:null}}));
  await links.refreshModShortcuts(profile,path.dirname(f.source),[m],shell);assert.equal(fs.readFileSync(file,'utf8'),'not owned');
  const index=JSON.parse(fs.readFileSync(path.join(profile,'mod-folder-shortcuts.json')));assert.notEqual(index.links.Example.file,path.basename(file));
});
test('portable refresh recreates targets for the current computer',async t=>{
  const f=fixture(t),profile=path.join(f.root,'profile'),m=mod(1000);await links.refreshModShortcuts(profile,path.dirname(f.source),[m],shell);
  const moved=path.join(f.root,'new-PC','Mods');fs.mkdirSync(path.join(moved,'Example'),{recursive:true});await links.refreshModShortcuts(profile,moved,[m],shell);
  const link=path.join(profile,'Mod folders',links.modShortcutName(m));assert.equal(JSON.parse(fs.readFileSync(link)).target,path.join(moved,'Example'));assert(fs.existsSync(f.source));
});
