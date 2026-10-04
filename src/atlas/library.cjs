'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = '0.2.9';
const ONLINE_SOURCE = 'https://github.com/lordfelixmotosr/atlas/releases/latest/download/';
const MAX_BYTES = 24 * 1024 * 1024;
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_EXT = /\.(md|txt|json|xml|cs|py|svg|png|jpg|jpeg|webp)$/i;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 220 || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..' || /[\x00-\x1f<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe pack file path.');
  return value;
}
function ensureDir(root, target) {
  if (!inside(root, target)) throw new Error('Path escapes the Atlas folder.');
  fs.mkdirSync(root, {recursive:true});
  const canonical = fs.realpathSync(root);
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink() || !inside(canonical, fs.realpathSync(current))) throw new Error('Pack destination contains a link or invalid directory.');
  }
}
function atomicJson(root, target, value) {
  ensureDir(root, path.dirname(target));
  if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !inside(fs.realpathSync(root), fs.realpathSync(target)))) throw new Error('Unsafe state file.');
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {flag:'wx'}); fs.renameSync(temporary, target); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function readJson(file, fallback) { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
function compareVersions(a,b) { const aa=a.split('.').map(Number),bb=b.split('.').map(Number); for(let i=0;i<3;i++) if(aa[i]!==bb[i]) return aa[i]-bb[i]; return 0; }
function verifyEnvelope(bytes, trust, now = Date.now(), allowExpired = false) {
  if (bytes.length > MAX_BYTES) throw new Error('Update exceeds the size limit.');
  const envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!envelope || envelope.format !== 'atlas-signed-v1' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' || !trust.keys[envelope.keyId]) throw new Error('Update publisher is not trusted.');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!crypto.verify(null, payload, trust.keys[envelope.keyId], Buffer.from(envelope.signature,'base64'))) throw new Error('Update signature verification failed.');
  const value = JSON.parse(payload.toString('utf8'));
  if (!Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt) || value.issuedAt > now+300000 || (!allowExpired && value.expiresAt <= now) || value.expiresAt <= value.issuedAt) throw new Error('Update metadata is expired or has an invalid date.');
  return value;
}
function validatePack(pack) {
  if (pack.type !== 'pack' || !SAFE_ID.test(pack.id) || !SAFE_VERSION.test(pack.version) || !SAFE_VERSION.test(pack.minAtlasVersion) || compareVersions(pack.minAtlasVersion,VERSION)>0) throw new Error('Pack is incompatible with this Atlas version.');
  if (!['knowledge','skills','art'].includes(pack.category) || !Array.isArray(pack.files) || !pack.files.length || pack.files.length>800 || typeof pack.name !== 'string' || pack.name.length>100 || typeof pack.description!=='string' || pack.description.length>1000 || !Array.isArray(pack.gameVersions) || pack.gameVersions.some(x=>typeof x!=='string'||x.length>24) || typeof pack.source !== 'string' || !/^https:\/\//.test(pack.source) || typeof pack.license !== 'string' || pack.license.length>200) throw new Error('Invalid knowledge pack metadata.');
  if(!pack.gameVersions.includes('1.6'))throw new Error('Pack is incompatible with the RimWorld 1.6 adapter in this Atlas release.');
  const source = new URL(pack.source);
  if (source.username || source.password || source.hash || source.search) throw new Error('Invalid reference source URL.');
  let total=0; const paths=new Set();
  for (const file of pack.files) {
    safeRelative(file.path);
    if ((!SAFE_EXT.test(file.path) && !/^(?:.*\/)?(?:LICENSE|NOTICE)$/.test(file.path)) || /(?:^|\/)(?:node_modules|\.git|auth\.json|auth\.enc)(?:\/|$)/i.test(file.path) || paths.has(file.path.toLowerCase()) || !['utf8','base64'].includes(file.encoding) || typeof file.content!=='string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid reference file in pack.');
    paths.add(file.path.toLowerCase());
    const bytes=Buffer.from(file.content,file.encoding); total+=bytes.length;
    if (bytes.length>4*1024*1024 || total>16*1024*1024 || sha(bytes)!==file.sha256) throw new Error('Pack file integrity verification failed.');
    if (file.path.endsWith('SKILL.md') && (!/^---\r?\n[\s\S]*?\r?\n---/.test(bytes.toString()) || !/^description: .+/m.test(bytes.toString()))) throw new Error('Skill metadata is incomplete.');
    if (file.path.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
  }
  return pack;
}
class Library {
  constructor(root, resources, options={}) {
    this.root=path.resolve(root); this.resources=resources; this.busy=options.busy??(()=>false); this.fetch=options.fetch??globalThis.fetch; this.now=options.now??Date.now;
    this.trust=readJson(path.join(resources,'trust.json'),{keys:{}});
    this.configPath=path.join(root,'data','atlas-library.json'); this.statePath=path.join(root,'library','state.json');
    const distribution=readJson(path.join(resources,'distribution.json'),{});
    const online=distribution.updateSource===ONLINE_SOURCE&&distribution.feedRevision===1;
    this.config=readJson(this.configPath,{autoUpdate:true,source:online?ONLINE_SOURCE:'updates',lastCheckedAt:null,lastSuccessAt:null,lastError:null});
    if(online&&this.config.feedRevision!==1){
      // Upgrade only the former bundled default. Preserve explicit custom sources and auto-update choices.
      this.saveConfig({...this.config,source:this.config.source==='updates'?ONLINE_SOURCE:this.config.source,feedRevision:1,lastCheckedAt:null});
    }
    this.state=readJson(this.statePath,{active:{},pending:{},previous:{},sequence:0});
    this.available=[]; this.working=false; this.lastChanges=[];
  }
  saveState(next) { atomicJson(this.root,this.statePath,next); this.state=next; }
  saveConfig(next) { atomicJson(this.root,this.configPath,next); this.config=next; }
  packDir(id,version) { if(!SAFE_ID.test(id)||!SAFE_VERSION.test(version))throw new Error('Invalid pack selection.');return path.join(this.root,'library','packs',id,version); }
  installed(id,version) { const dir=this.packDir(id,version);if(!fs.existsSync(dir)||!inside(fs.realpathSync(path.join(this.root,'library')),fs.realpathSync(dir)))throw new Error('Installed pack path escaped the library.');const release=path.join(dir,'release.atlas.json');if(!fs.existsSync(release))throw new Error('Installed pack is missing.');if(!inside(fs.realpathSync(dir),fs.realpathSync(release)))throw new Error('Installed release escaped the pack.');const pack=validatePack(verifyEnvelope(fs.readFileSync(release),this.trust,this.now(),true));if(pack.id!==id||pack.version!==version)throw new Error('Installed pack identity changed.');const manifest={...pack,files:pack.files.map(({content,...rest})=>rest),digest:sha(Buffer.from(JSON.stringify(pack)))};return {dir,manifest}; }
  metadata(id,version) { const {manifest}=this.installed(id,version);return {id,version,name:manifest.name,description:manifest.description,category:manifest.category,source:manifest.source,license:manifest.license,gameVersions:manifest.gameVersions}; }
  status() {
    return {version:VERSION,portableRoot:this.root,config:{...this.config},busy:this.busy(),working:this.working,packs:Object.entries(this.state.active).map(([id,version])=>({...this.metadata(id,version),pending:this.state.pending[id]??null,previous:this.state.previous[id]??null})),available:this.available.map(({pack})=>({id:pack.id,version:pack.version,name:pack.name})),changes:this.lastChanges};
  }
  configure(patch) {
    if(this.working)throw new Error('Wait for the current library operation.');
    const next={...this.config};
    if(patch.autoUpdate!==undefined) {if(typeof patch.autoUpdate!=='boolean')throw new Error('Invalid update setting.');next.autoUpdate=patch.autoUpdate;}
    if(patch.source!==undefined) {
      if(typeof patch.source!=='string'||!patch.source.trim()||patch.source.length>2048)throw new Error('Choose an update folder or HTTPS feed.');
      const source=patch.source.trim();
      if(/^[a-z]+:\/\//i.test(source)){const url=new URL(source);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Use a clean HTTPS feed URL without credentials or query parameters.');}
      next.source=source; next.lastCheckedAt=null; next.feedRevision=1;
    }
    this.available=[];this.saveConfig(next);return this.status();
  }
  async obtain(source,relative,maxBytes=MAX_BYTES,options={}) {
    safeRelative(relative);
    // Optional chunk sink keeps large application archives out of memory.
    const consume=async body=>{
      const chunks=[];let total=options.startByte??0;
      for await(const chunk of body){
        options.signal?.throwIfAborted();
        total+=chunk.length;if(total>maxBytes)throw new Error('Update exceeds size limit.');
        if(options.onChunk)await options.onChunk(chunk);else chunks.push(Buffer.from(chunk));
        options.onProgress?.(total);
      }
      return options.onChunk?total:Buffer.concat(chunks,total-(options.startByte??0));
    };
    if(/^https:\/\//i.test(source)) {
      const base=new URL(source.endsWith('/')?source:source+'/'),url=new URL(relative,base);
      if(url.origin!==base.origin)throw new Error('Update URL changed origin.');
      const github=base.href===ONLINE_SOURCE;
      const timeout=AbortSignal.timeout(maxBytes>MAX_BYTES?1800000:120000);
      const signal=options.signal?AbortSignal.any([timeout,options.signal]):timeout;
      const headers=options.startByte?{Range:`bytes=${options.startByte}-`}:undefined;
      let target=url,response;
      for(let hop=0;hop<=5;hop++){
        response=await this.fetch(target,{signal,redirect:github?'manual':'error',credentials:'omit',headers});
        if(!github||![301,302,303,307,308].includes(response.status))break;
        const location=response.headers.get('location');await response.body?.cancel();
        if(!location||hop===5)throw new Error('Too many or invalid GitHub update redirects.');
        const next=new URL(location,target);
        const repoPath='/lordfelixmotosr/atlas/releases/';
        const sameRepo=next.hostname==='github.com'&&(next.pathname===repoPath+'latest/download/'+relative||next.pathname.startsWith(repoPath+'download/')&&next.pathname.endsWith('/'+relative));
        const assetHost=next.hostname==='release-assets.githubusercontent.com'&&next.pathname.startsWith('/github-production-release-asset/');
        if(next.protocol!=='https:'||next.username||next.password||next.port||next.hash||(!sameRepo&&!assetHost)||sameRepo&&next.search)throw new Error('GitHub update redirect left the trusted release hosts.');
        target=next;
      }
      if(!response.ok)throw new Error('Update download failed ('+response.status+').');
      if(options.startByte){
        if(response.status===206){const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');if(!range||Number(range[1])!==options.startByte||Number(range[3])!==maxBytes||Number(range[2])<options.startByte||Number(range[2])>=maxBytes)throw new Error('Invalid download resume range.');}
        else if(response.status===200){await options.onRestart?.();options.startByte=0;}
        else throw new Error('Download resume was rejected.');
      }else if(response.status===206)throw new Error('Unexpected partial update response.');
      if(Number(response.headers.get('content-length')??0)>maxBytes-(options.startByte??0))throw new Error('Update exceeds size limit.');
      return consume(response.body);
    }
    const folder=path.resolve(this.root,source),file=path.resolve(folder,...relative.split('/'));
    if(!inside(folder,file)||!inside(fs.realpathSync(folder),fs.realpathSync(file))||!fs.statSync(file).isFile()||fs.statSync(file).size>maxBytes)throw new Error('Invalid local update file.');
    return options.onChunk||options.onProgress||options.signal?consume(fs.createReadStream(file,{start:options.startByte??0,signal:options.signal})):fs.readFileSync(file);
  }
  async checkInternal(source=this.config.source,allowExpired=false) {
    const index=verifyEnvelope(await this.obtain(source,'index.atlas.json'),this.trust,this.now(),allowExpired);
    if(index.type!=='feed'||!Number.isSafeInteger(index.sequence)||index.sequence<this.state.sequence||!Array.isArray(index.packs)||index.packs.length>40)throw new Error('Invalid or outdated update feed.');
    const items=[];const ids=new Set();
    for(const entry of index.packs){
      if(!SAFE_ID.test(entry.id)||!SAFE_VERSION.test(entry.version)||ids.has(entry.id)||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Invalid feed entry.');ids.add(entry.id);
      safeRelative(entry.file);
      const current=this.state.active[entry.id],pending=this.state.pending[entry.id];
      if((current&&compareVersions(entry.version,current)<=0)||(pending&&compareVersions(entry.version,pending)<=0))continue;
      const bytes=await this.obtain(source,entry.file);if(sha(bytes)!==entry.sha256)throw new Error('Downloaded pack does not match the feed.');
      const pack=validatePack(verifyEnvelope(bytes,this.trust,this.now(),allowExpired));
      if(pack.id!==entry.id||pack.version!==entry.version)throw new Error('Pack identity differs from the feed.');
      items.push({pack,bytes});
    }
    this.available=items;this.saveState({...this.state,sequence:index.sequence});
    this.saveConfig({...this.config,lastCheckedAt:this.now(),lastSuccessAt:this.now(),lastError:null});
    return this.status();
  }
  async operation(fn) {if(this.working)throw new Error('Another library operation is running.');this.working=true;try{return await fn();}catch(error){this.saveConfig({...this.config,lastCheckedAt:this.now(),lastError:error.message});throw error;}finally{this.working=false;}}
  async check() {await this.operation(()=>this.checkInternal());return this.status();}
  install(pack,bytes) {
    validatePack(pack);if(!bytes||sha(Buffer.from(JSON.stringify(verifyEnvelope(bytes,this.trust,this.now(),true))))!==sha(Buffer.from(JSON.stringify(pack))))throw new Error('Pack installation requires its verified signed release.');const final=this.packDir(pack.id,pack.version);
    if(fs.existsSync(final)){this.verifyInstalled(pack.id,pack.version);const existing=this.installed(pack.id,pack.version).manifest;if(existing.digest!==sha(Buffer.from(JSON.stringify(pack))))throw new Error('A different pack already uses this version.');return;}
    const staging=path.join(this.root,'library','.staging',pack.id+'-'+crypto.randomUUID());ensureDir(this.root,staging);
    try{
      for(const file of pack.files){const target=path.join(staging,...file.path.split('/'));ensureDir(staging,path.dirname(target));fs.writeFileSync(target,Buffer.from(file.content,file.encoding),{flag:'wx'});}
      atomicJson(staging,path.join(staging,'pack.json'),{...pack,files:pack.files.map(({content,...rest})=>rest),digest:sha(Buffer.from(JSON.stringify(pack)))});
      fs.writeFileSync(path.join(staging,'release.atlas.json'),bytes,{flag:'wx'});
      ensureDir(this.root,path.dirname(final));fs.renameSync(staging,final);
    }finally{if(fs.existsSync(staging)&&inside(path.join(this.root,'library','.staging'),staging))fs.rmSync(staging,{recursive:true,force:true});}
    this.verifyInstalled(pack.id,pack.version);
  }
  verifyInstalled(id,version) {
    const {dir,manifest}=this.installed(id,version);
    const canonicalRoot=fs.realpathSync(path.join(this.root,'library'));
    if(!inside(canonicalRoot,fs.realpathSync(dir)))throw new Error('Installed pack path escaped the library.');
    for(const file of manifest.files){safeRelative(file.path);const target=path.join(dir,...file.path.split('/'));if(!inside(fs.realpathSync(dir),fs.realpathSync(target))||sha(fs.readFileSync(target))!==file.sha256)throw new Error('Installed pack integrity check failed.');}
    return manifest;
  }
  activatePending() {
    if(this.busy()||this.working)return false;
    const next=structuredClone(this.state);let changed=false;
    for(const [id,version]of Object.entries(next.pending)){this.verifyInstalled(id,version);if(next.active[id])next.previous[id]=next.active[id];next.active[id]=version;delete next.pending[id];changed=true;}
    if(changed)this.saveState(next);return changed;
  }
  async update() {
    await this.operation(async()=>{
      await this.checkInternal();this.lastChanges=this.available.map(({pack})=>({id:pack.id,from:this.state.active[pack.id]??null,to:pack.version,notes:pack.notes??'Reference pack updated.'}));
      const next=structuredClone(this.state);
      for(const {pack,bytes}of this.available){this.install(pack,bytes);next.pending[pack.id]=pack.version;}
      this.saveState(next);this.available=[];
    });
    this.activatePending();return this.status();
  }
  async seed() { if(Object.keys(this.state.active).length)return;await this.operation(async()=>{await this.checkInternal(path.join(this.resources,'seed'),true);const next=structuredClone(this.state);for(const {pack,bytes}of this.available){this.install(pack,bytes);next.pending[pack.id]=pack.version;}this.saveState(next);this.available=[];});this.activatePending(); }
  revert(id) {
    if(this.working||this.busy())throw new Error('Finish active work before reverting a pack.');
    if(!SAFE_ID.test(id)||!this.state.previous[id])throw new Error('No previous pack version is available.');
    const next=structuredClone(this.state),previous=next.previous[id];this.verifyInstalled(id,previous);next.previous[id]=next.active[id];next.active[id]=previous;delete next.pending[id];this.saveState(next);return this.status();
  }
  skillRoots() {return Object.entries(this.state.active).flatMap(([id,version])=>{try{this.verifyInstalled(id,version);const dir=path.join(this.packDir(id,version),'skills');return fs.existsSync(dir)?[dir]:[];}catch(error){console.warn('[atlas:library] Skipping invalid pack '+id+': '+error.message);return [];}});}
  mergeSkills(managed,custom) {const result=new Map(managed.map(skill=>[skill.name,skill]));for(const skill of custom)result.set(skill.name,skill);return [...result.values()].sort((a,b)=>a.name.localeCompare(b.name));}
  search(query) {
    if(typeof query!=='string'||query.length>300)throw new Error('Enter a search term.');const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean);if(!words.length)return [];
    const matches=[];
    for(const [id,version]of Object.entries(this.state.active)){this.verifyInstalled(id,version);const {dir,manifest}=this.installed(id,version);for(const file of manifest.files){if(!/\.(md|txt|cs|py|xml|json)$/.test(file.path))continue;const text=fs.readFileSync(path.join(dir,...file.path.split('/')),'utf8');const lower=(file.path+' '+text).toLowerCase();if(words.every(word=>lower.includes(word))){const at=text.toLowerCase().indexOf(words[0]);matches.push({id,version,path:file.path,excerpt:text.slice(Math.max(0,at-70),Math.max(0,at-70)+300),source:manifest.source});}}}
    return matches.slice(0,40);
  }
  file(id,relative) {const version=this.state.active[id];if(!version)throw new Error('Choose an installed pack.');safeRelative(relative);const {dir,manifest}=this.installed(id,version);if(!manifest.files.some(file=>file.path===relative))throw new Error('Reference file is not in this pack.');this.verifyInstalled(id,version);return path.join(dir,...relative.split('/'));}
}
module.exports={Library,VERSION,MAX_BYTES,inside,safeRelative,ensureDir,atomicJson,compareVersions,verifyEnvelope,validatePack,sha};
