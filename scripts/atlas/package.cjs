'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),source=path.resolve(process.env.ATLAS_BUILD_OUTPUT??path.join(root,'dist/Atlas')),out=path.resolve(root,'../outputs');
assert(source.startsWith(root+path.sep),'Package source must stay inside the Atlas workspace');
const {read}=require('./asar.cjs'),archive=read(fs.readFileSync(path.join(source,'resources/app.asar')));
assert(!archive.files.some(file=>file.name.endsWith('/atlas/verify.cjs')),'Rebuild without --verify-build before packaging');
assert(!fs.existsSync(path.join(source,'resources/neoforge-mdk')),'Minecraft tools must not ship');
assert(!fs.existsSync(path.join(source,'resources/lore/minecraft')),'Minecraft references must not ship');
const build=JSON.parse(fs.readFileSync(path.join(source,'atlas-build.json')));fs.mkdirSync(out,{recursive:true});
const script=String.raw`import os,sys,json,zipfile,hashlib
source,out,version=sys.argv[1:]
reserved={"data","custom","library","backups"}
files=[]
for base,dirs,names in os.walk(source):
 dirs[:]=[d for d in sorted(dirs) if not (base==source and d in reserved) and d!="__pycache__"]
 for name in sorted(names):
  absolute=os.path.join(base,name)
  relative=os.path.relpath(absolute,source).replace(os.sep,"/")
  if name.endswith((".pyc",".private.pem")) or name.lower() in {"auth.json","auth.enc"}:raise RuntimeError("Unexpected private/cache file: "+relative)
  files.append((absolute,relative))
result={}
for kind in ["portable","application-update"]:
 target=os.path.join(out,"Atlas-"+version+"-win-x64-"+kind+".zip")
 with zipfile.ZipFile(target,"w",zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
  for absolute,relative in files:
   if kind=="application-update" and relative.startswith("updates/"):continue
   z.write(absolute,"Atlas/"+relative)
 with zipfile.ZipFile(target) as z:
  if z.testzip() is not None:raise RuntimeError("ZIP integrity check failed")
 with open(target,"rb") as f:
  digest=hashlib.file_digest(f,"sha256").hexdigest()
 result[kind]={"path":target,"size":os.path.getsize(target),"sha256":digest}
 print(kind+" ZIP complete",flush=True)
with open(os.path.join(out,"Atlas-"+version+"-checksums.json"),"w") as f:json.dump(result,f,indent=2)
`;
cp.execFileSync(path.join(source,'tools/python/python.exe'),['-I','-c',script,source,out,build.version],{stdio:'inherit',windowsHide:true});
fs.copyFileSync(path.join(root,'README-ATLAS.md'),path.join(out,'Atlas-README.md'));
fs.copyFileSync(path.join(out,'Atlas-'+build.version+'-checksums.json'),path.join(root,'release-result.json'));
console.log('Atlas packages verified in '+out);
