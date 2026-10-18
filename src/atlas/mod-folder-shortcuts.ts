import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

interface ModFolder {folder: string; about: {name: string; author: string; packageId: string}; updatedAt: number}
interface Link {file: string; sha256: string}
interface ShortcutShell {writeShortcutLink(file: string, operation: 'create', details: {target: string; cwd: string; description: string}): boolean}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const plain = (s: string) => {
  const name=Array.from(s.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/\s+/g,'_')).slice(0,70).join('').replace(/[. ]+$/g,'')||'Mod';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)?'_'+name:name;
};
async function retry<T>(work:()=>Promise<T>):Promise<T>{
  for(let attempt=0;;attempt++)try{return await work();}catch(error){
    if(attempt===4||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code||''))throw error;
    await new Promise(resolve=>setTimeout(resolve,50*2**attempt));
  }
}
export function modShortcutName(mod: ModFolder): string {
  const identity = mod.about.packageId || `${mod.about.author || 'UnknownAuthor'}.${mod.about.name || 'UntitledMod'}`;
  const date = new Date(Number.isFinite(mod.updatedAt) && mod.updatedAt > 0 ? mod.updatedAt : 0);
  const stamp = [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-') + '_' + [date.getHours(),date.getMinutes(),date.getSeconds()].map(n=>String(n).padStart(2,'0')).join('-');
  return `${plain(identity)}.${stamp}.${createHash('sha256').update(mod.folder).digest('hex').slice(0,6)}.lnk`;
}
let refreshing: Promise<{directory: string; count: number}> | null = null;
/** Regenerated on demand on the current PC. Never rename a project/save path. */
export function refreshModShortcuts(profile: string, workspace: string, mods: ModFolder[], shell: ShortcutShell): Promise<{directory: string; count: number}> {
  if (refreshing) return refreshing;
  const work = async () => {
    const directory = path.join(profile,'Mod folders'), indexFile = path.join(profile,'mod-folder-shortcuts.json');
    await fs.mkdir(directory,{recursive:true});
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('The named mod folders directory must not be a link.');
    let old: Record<string,Link> = Object.create(null);
    try {const saved=JSON.parse(await fs.readFile(indexFile,'utf8'));if(saved?.version===1&&saved.links&&typeof saved.links==='object'&&!Array.isArray(saved.links))old=Object.assign(Object.create(null),saved.links);} catch { /* first use */ }
    const next: Record<string,Link> = Object.create(null);
    const owned = async (entry: Link) => {
      if (!entry || typeof entry.file!=='string'||typeof entry.sha256!=='string'||path.basename(entry.file)!==entry.file || !entry.file.endsWith('.lnk')) return false;
      try {const file=path.join(directory,entry.file);const st=await fs.lstat(file);return st.isFile()&&!st.isSymbolicLink()&&hash(await fs.readFile(file))===entry.sha256;} catch {return false;}
    };
    for (const mod of mods) {
      if (!mod.folder || mod.folder==='.' || mod.folder==='..' || /[\\/\x00]/.test(mod.folder)) throw new Error('Invalid mod folder.');
      const target=path.join(workspace,mod.folder), st=await fs.lstat(target);
      if (!st.isDirectory()||st.isSymbolicLink()) continue;
      let name=modShortcutName(mod), destination=path.join(directory,name);
      const exists=await fs.lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if (exists && !(old[mod.folder]?.file===name && await owned(old[mod.folder]))) {name=name.slice(0,-4)+'-'+randomUUID().slice(0,6)+'.lnk';destination=path.join(directory,name);}
      const temporary=path.join(directory,'.atlas-'+randomUUID()+'.lnk');
      try {
        if (!shell.writeShortcutLink(temporary,'create',{target,cwd:target,description:`Atlas workspace: ${mod.about.name || mod.folder}`})) throw new Error(`Could not create folder shortcut for ${mod.about.name || mod.folder}.`);
        await retry(()=>fs.rename(temporary,destination));
        next[mod.folder]={file:name,sha256:hash(await fs.readFile(destination))};
      } finally {await fs.unlink(temporary).catch(()=>{});}
    }
    // Only unchanged shortcut files recorded by Atlas may be removed. User
    // files, project directories, and manually edited shortcuts are retained.
    for (const [folder,entry] of Object.entries(old)) if (await owned(entry)&&next[folder]?.file!==entry.file) await retry(()=>fs.unlink(path.join(directory,entry.file)));
    const temporary=indexFile+'.'+randomUUID()+'.tmp';
    try {await fs.writeFile(temporary,JSON.stringify({version:1,links:next}),{flag:'wx'});await retry(()=>fs.rename(temporary,indexFile));}finally{await fs.unlink(temporary).catch(()=>{});}
    const readme=path.join(directory,'About these shortcuts.txt');
    await fs.writeFile(readme,'Atlas mod folder shortcuts\r\n\r\nNames show package ID (or author and mod name), last modified time and a short identifier.\r\nThese are shortcuts to the original workspace folders. Existing paths, chats and saves are kept.\r\nAfter moving Atlas to another PC, use Open named mod folders in Atlas to recreate these shortcuts.\r\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    return {directory,count:Object.keys(next).length};
  };
  refreshing=work().finally(()=>{refreshing=null;});return refreshing;
}
