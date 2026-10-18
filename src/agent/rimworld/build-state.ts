import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {metadataReadPath, metadataWritePath} from '../mod-metadata.js';
import {fileSha, planRelease} from './release-package.js';

export interface BuildState {
  status: 'not-needed' | 'untracked' | 'needs-rebuild' | 'current' | 'building' | 'unknown';
  message: string;
  builtAt?: number;
  changedInputs?: string[];
}
interface BuildRecord {version: 1; builtAt?: number; inputs?: Record<string,string>; outputs?: Record<string,string>; attempt?: 'building' | 'failed' | 'changed' | 'success'}
const active = new Set<string>();
const skipped = new Set(['bin','obj','.git','.atlas','.modmixer','node_modules','.live']);
const rootInput = /^(?:Directory\.(?:Build|Packages)\.(?:props|targets)|global\.json|NuGet\.Config|\.editorconfig)$/i;
const codeInput = /\.(?:cs|csproj|props|targets|resx|ruleset|editorconfig)$/i;
const signature = (files: Record<string,string>) => createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');

/** Conservative workspace inputs: all Source files, code projects and MSBuild settings. */
export async function buildInputs(mod: string): Promise<Record<string,string>> {
  const files: Record<string,string> = {};
  async function visit(dir: string, prefix='') {
    for(const e of await fs.readdir(dir,{withFileTypes:true})) {
      if(skipped.has(e.name.toLowerCase()))continue;
      const relative=prefix+e.name,full=path.join(dir,e.name);
      if(e.isSymbolicLink()) {if(prefix.toLowerCase().startsWith('source/')||e.name.toLowerCase()==='source'||codeInput.test(e.name))throw new Error(`Linked build input: ${relative}`);continue;}
      if(e.isDirectory()) {if(!/^(?:Textures|Sounds|ArtSources|\.atlas|\.git)\//i.test(relative+'/'))await visit(full,relative+'/');}
      else if(e.isFile()&&(relative.toLowerCase().startsWith('source/')||codeInput.test(e.name)||!prefix&&rootInput.test(e.name)))files[relative]=await fileSha(full);
    }
  }
  await visit(mod);return files;
}
async function read(mod: string): Promise<BuildRecord|null> {
  try {const r=JSON.parse(await fs.readFile(metadataReadPath(mod,'build-state.json'),'utf8'));if(r.version!==1)throw new Error('Unsupported build record');return r;}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
async function write(mod:string,r:BuildRecord){
  const file=metadataWritePath(mod,'build-state.json'),temp=file+'.'+randomUUID()+'.tmp';
  await fs.mkdir(path.dirname(file),{recursive:true});
  try{await fs.writeFile(temp,JSON.stringify(r),{flag:'wx'});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}
}
async function outputs(mod:string){const plan=await planRelease(mod);if(!plan.valid)throw new Error(plan.errors.join('\n'));return Object.fromEntries(plan.files.filter(f=>f.path.toLowerCase().endsWith('.dll')).map(f=>[f.path,f.sha256]));}
export async function beginBuild(mod:string):Promise<Record<string,string>>{
  const inputs=await buildInputs(mod);const previous=await read(mod).catch(()=>null);
  await write(mod,{...previous,version:1,attempt:'building'});active.add(path.resolve(mod));return inputs;
}
export async function finishBuild(mod:string,before:Record<string,string>|undefined,success:boolean):Promise<void>{
  active.delete(path.resolve(mod));const previous=await read(mod).catch(()=>null);
  if(!success||!before){await write(mod,{...previous,version:1,attempt:'failed'});return;}
  const after=await buildInputs(mod);
  if(signature(before)!==signature(after)){await write(mod,{...previous,version:1,attempt:'changed'});return;}
  const dlls=await outputs(mod);if(!Object.keys(dlls).length)throw new Error('Build produced no releasable DLLs.');
  await write(mod,{version:1,attempt:'success',builtAt:Date.now(),inputs:after,outputs:dlls});
}
export async function getBuildState(mod:string):Promise<BuildState>{
  try{
    const inputs=await buildInputs(mod);
    if(!Object.keys(inputs).some(f=>/\.(?:cs|csproj)$/i.test(f)))return{status:'not-needed',message:'No C# source to rebuild.'};
    if(active.has(path.resolve(mod)))return{status:'building',message:'C# build in progress.'};
    const r=await read(mod);
    if(!r?.builtAt||!r.inputs||!r.outputs)return{status:'untracked',message:'No successful Atlas build recorded. Rebuild once to check source against the released DLLs.'};
    const changed=[...new Set([...Object.keys(inputs),...Object.keys(r.inputs)])].filter(f=>inputs[f]!==r.inputs![f]);
    if(r.attempt!=='success'||changed.length)return{status:'needs-rebuild',builtAt:r.builtAt,changedInputs:changed,message:r.attempt==='failed'?'The last C# build failed. The previous DLLs may still be present.':r.attempt==='changed'?'Source changed during the last build. Rebuild before publishing.':r.attempt==='building'?'The previous build did not finish recording its result. Rebuild to verify the DLLs.':`${changed.length} build input${changed.length===1?' has':'s have'} changed since the recorded build.`};
    if(signature(await outputs(mod))!==signature(r.outputs))return{status:'needs-rebuild',builtAt:r.builtAt,message:'Released DLLs were changed, added or removed since the recorded build.'};
    return{status:'current',builtAt:r.builtAt,message:'Workspace source and released DLLs match the last successful Atlas build.'};
  }catch(e){return{status:'unknown',message:`Build status could not be checked: ${e instanceof Error?e.message:String(e)}`};}
}
export function buildWarning(state:BuildState):string|null{
  return ['current','not-needed'].includes(state.status)?null:`C# build: ${state.message}`;
}
