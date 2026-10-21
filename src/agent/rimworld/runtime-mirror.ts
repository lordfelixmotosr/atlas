import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {planRelease,copyRelease,auditRelease,allowedDll,isDevelopmentPath,releaseRelative,fileSha,runtimeInventory,runtimeSignature,type ReleasePlan} from './release-package.js';

interface MirrorRecord {
  format: 'atlas-runtime-mirror-v1';
  source: string;
  target: string;
  identity: {dev: number; ino: number; birthtimeMs: number};
  publishedId: string | null;
  plan?: ReleasePlan;
  heldWorkspace?: string;
  /** Durable removal intent prevents launch recovery from reinstalling a removed copy. */
  removed?: boolean;
}
const locks = new Map<string, Promise<unknown>>();
const watchers = new Map<string, () => void>();
const callbacks = new Map<string, () => void>();
const syncContext = new AsyncLocalStorage<Map<string, {active: boolean}>>();
const key = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const recordPath = (target: string, stateDir: string) => path.join(stateDir, createHash('sha256').update(key(target)).digest('hex') + '.json');
const same = (a: string, b: string) => key(a) === key(b);

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const transient = (error: unknown) => ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '');

async function retry<T>(label: string, work: () => Promise<T>): Promise<T> {
  const delays = [40, 100, 200, 400, 800, 1200];
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (!transient(error) || attempt === delays.length) throw error;
      console.warn('[runtime mirror] retry', JSON.stringify({pid: process.pid, operation: label, attempt: attempt + 1, code: (error as NodeJS.ErrnoException).code}));
      await pause(delays[attempt]);
    }
  }
}

/** One queue and one filesystem lease for the WHOLE Mods root, including prune.
 * Async context makes nested refresh/remove/ID reconciliation reentrant. The
 * on-disk lease also excludes another Atlas process or a diagnostic CLI. */
export function withRuntimeSync<T>(modsRoot: string, work: () => Promise<T>): Promise<T> {
  const k = key(modsRoot);
  if (syncContext.getStore()?.get(k)?.active) return work();
  const task = (locks.get(k) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const parent = path.join(path.dirname(path.resolve(modsRoot)), '.atlas-release-stage');
    await fsp.mkdir(parent, {recursive: true});
    if ((await fsp.lstat(parent)).isSymbolicLink()) throw new Error('Runtime staging directory must not be a link.');
    const lease = path.join(parent, '.sync-lock'), token = randomUUID(), deadline = Date.now() + 60000;
    for (;;) {
      try { await fsp.mkdir(lease); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const st = await stat(lease);
        if (st?.isSymbolicLink() || st && !st.isDirectory()) throw new Error(`Unsafe runtime sync lock: ${lease}`);
        let owner: {pid: number; token: string} | null = null;
        try { owner = JSON.parse(await fsp.readFile(path.join(lease, 'owner.json'), 'utf8')); } catch { /* owner may still be writing */ }
        if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
          let dead = false;
          try { process.kill(owner.pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
          if (dead) {
            // Only retire a proven-dead lease. Preserve it for diagnosis rather
            // than recursively deleting a possibly live lock/recovery folder.
            const again = await stat(lease);
            if (again && st && again.ino === st.ino && again.birthtimeMs === st.birthtimeMs) {
              // Elect one reaper before renaming. Otherwise two waiters can
              // both observe a dead owner and the late waiter can accidentally
              // retire the NEW owner's lock after the first waiter acquired it.
              const reaper = path.join(lease, '.reaping');
              try {
                await fsp.mkdir(reaper);
                const current = await stat(lease), currentOwner = JSON.parse(await fsp.readFile(path.join(lease, 'owner.json'), 'utf8'));
                if (current && matches(current, identity(st)) && currentOwner.token === owner.token) {
                  const abandoned = path.join(parent, 'abandoned-lock-' + randomUUID());
                  await fsp.rename(lease, abandoned);
                  console.warn('[runtime mirror] retired dead process lock:', abandoned); continue;
                }
                await fsp.rmdir(reaper);
              } catch (e) { if (!['ENOENT', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) console.warn('[runtime mirror] lease recovery:', String(e)); }
            }
          }
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for runtime sync${owner ? ` (PID ${owner.pid})` : ''}. Lock: ${lease}. No runtime copy was changed. Do not remove a live process's lock.`);
        await pause(100);
      }
    }
    const scope = {active: true};
    try {
      await fsp.writeFile(path.join(lease, 'owner.json'), JSON.stringify({pid: process.pid, token, modsRoot: path.resolve(modsRoot), startedAt: new Date().toISOString()}), {flag: 'wx'});
      return await syncContext.run(new Map([...(syncContext.getStore() ?? []), [k, scope]]), work);
    } finally {
      scope.active = false;
      const ownerFile = path.join(lease, 'owner.json');
      try {
        const owner = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));
        if (owner.token === token) {
          await retry('release runtime sync owner', () => fsp.unlink(ownerFile));
          await retry('release runtime sync directory', () => fsp.rmdir(lease));
        }
      } catch (e) { console.warn('[runtime mirror] retained sync lease:', lease, String(e)); }
    }
  });
  locks.set(k, task);
  void task.finally(() => {if (locks.get(k) === task) locks.delete(k);}).catch(() => {});
  return task;
}

function exclusive<T>(target: string, work: () => Promise<T>): Promise<T> {
  return withRuntimeSync(path.dirname(target), work);
}

async function stat(p: string) { return fsp.lstat(p).catch((error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return null; throw error;}); }

export async function ownedMirror(source: string, target: string, stateDir: string): Promise<boolean> {
  return (await record(source, target, stateDir)) !== null;
}

/** An interrupted older Atlas swap can leave the owned destination absent. */
export async function missingRecordedMirror(source: string, target: string, stateDir: string): Promise<boolean> {
  if (await stat(target)) return false;
  try {
    const r = JSON.parse(await fsp.readFile(recordPath(target, stateDir), 'utf8')) as MirrorRecord;
    return r.format === 'atlas-runtime-mirror-v1' && !r.removed && same(r.source, source) && same(r.target, target);
  } catch { return false; }
}

async function record(source: string, target: string, stateDir: string): Promise<MirrorRecord | null> {
  try {
    const r = JSON.parse(await fsp.readFile(recordPath(target, stateDir), 'utf8')) as MirrorRecord;
    if (r.format !== 'atlas-runtime-mirror-v1' || !same(r.source, source) || !same(r.target, target)) return null;
    const st = await stat(target);
    if (!st?.isDirectory() || st.isSymbolicLink()) return null;
    return st.dev === r.identity.dev && st.ino === r.identity.ino && st.birthtimeMs === r.identity.birthtimeMs ? r : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[runtime mirror] ownership check:', String(error));
    return null;
  }
}

async function saveRecord(r: MirrorRecord, stateDir: string): Promise<void> {
  await fsp.mkdir(stateDir, {recursive: true});
  const destination = recordPath(r.target, stateDir), temporary = destination + '.' + randomUUID() + '.tmp';
  try {await fsp.writeFile(temporary, JSON.stringify(r), {flag: 'wx'}); await retry('save ownership', () => fsp.rename(temporary, destination));}
  finally {await fsp.unlink(temporary).catch(() => {});}
}

async function publishedId(root: string): Promise<string | null> {
  const about = await stat(path.join(root, 'About'));
  if (!about) return null;
  if (about.isSymbolicLink() || !about.isDirectory()) throw new Error(`Unsafe About folder: ${root}`);
  const file = path.join(root, 'About', 'PublishedFileId.txt'), st = await stat(file);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile() || st.size > 128) throw new Error(`Invalid Workshop ID file: ${file}`);
  const text = (await fsp.readFile(file, 'utf8')).trim();
  if (!text) return null;
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > 18446744073709551615n) throw new Error(`Invalid Workshop ID in ${file}.`);
  return text;
}

async function writeId(root: string, id: string | null): Promise<void> {
  const about = path.join(root, 'About'), st = await stat(about);
  if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error(`Cannot update Workshop ID: About folder is missing or linked in ${root}.`);
  const file = path.join(about, 'PublishedFileId.txt');
  if (id === null) {await fsp.unlink(file).catch((error: NodeJS.ErrnoException) => {if (error.code !== 'ENOENT') throw error;}); return;}
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {await fsp.writeFile(temporary, id, {flag: 'wx'}); await fsp.rename(temporary, file);}
  finally {await fsp.unlink(temporary).catch(() => {});}
}

async function reconcile(source: string, target: string, stateDir: string): Promise<boolean> {
  const r = await record(source, target, stateDir);
  if (!r || !(await stat(source))) return false;
  let src = await publishedId(source);
  const dst = await publishedId(target);
  let copiedBack = false;
  if (dst !== null && dst !== r.publishedId && dst !== src) {
    if (src !== r.publishedId) throw new Error(`Workshop IDs changed in both workspace and mirror (${src ?? 'none'} / ${dst}). Resolve PublishedFileId.txt before syncing.`);
    await writeId(source, dst);
    src = dst;
    copiedBack = true;
  } else if (src !== dst) {
    // A deliberate workspace link/unlink wins when the game did not write a new ID.
    await writeId(target, src);
  }
  if (r.publishedId !== src) {r.publishedId = src;if(r.plan)r.plan=withPublishedId(r.plan,src); await saveRecord(r, stateDir);}
  return copiedBack;
}

export function reconcileMirrorId(source: string, target: string, stateDir: string): Promise<boolean> {
  return exclusive(target, () => reconcile(source, target, stateDir));
}

export function watchMirrorId(source: string, target: string, stateDir: string, onChange?: () => void): void {
  const k = key(target);
  if (onChange) callbacks.set(k, onChange);
  if (watchers.has(k)) return;
  const file = path.join(target, 'About', 'PublishedFileId.txt');
  // Detached callbacks must queue behind their registering transaction, rather
  // than inherit its reentrant lease and run concurrently with its commit.
  const update = () => syncContext.exit(() => {void reconcileMirrorId(source, target, stateDir).then(changed => {if (changed) callbacks.get(k)?.();}).catch(error => console.warn('[runtime mirror] Workshop ID recovery:', String(error)));});
  fs.watchFile(file, {persistent: false, interval: 1500}, update);
  watchers.set(k, () => fs.unwatchFile(file, update));
  update();
}

export async function restoreMirrorWatchers(stateDir: string, workspaceRoot: string, modsRoot: string, onChange?: (folder: string) => void): Promise<void> {
  for (const name of await fsp.readdir(stateDir).catch(() => [] as string[])) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const r = JSON.parse(await fsp.readFile(path.join(stateDir, name), 'utf8')) as MirrorRecord;
      if (!same(path.dirname(r.source), workspaceRoot) || !same(path.dirname(r.target), modsRoot) || path.basename(r.source) !== path.basename(r.target)) continue;
      if (r.removed && !await stat(r.target)) continue;
      await exclusive(r.target, async () => {
        await recoverPending(r.source, r.target, stateDir, path.join(path.dirname(path.dirname(path.resolve(r.target))), '.atlas-release-stage'));
        if (await ownedMirror(r.source, r.target, stateDir)) watchMirrorId(r.source, r.target, stateDir, () => onChange?.(path.basename(r.source)));
      });
    } catch (error) {console.warn('[runtime mirror] restore:', String(error));}
  }
}

export async function isLegacyWorkspaceLink(source: string, target: string): Promise<boolean> {
  const st = await stat(target);
  if (!st?.isSymbolicLink()) return false;
  try {return same(await fsp.realpath(target), await fsp.realpath(source));} catch {return false;}
}

function locked(error: unknown, file: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  return new Error(`Cannot refresh runtime mirror: ${file} is locked or not writable${code ? ` (${code})` : ''}. Close RimWorld and any program using this DLL, then retry. The workspace has not been replaced.`);
}

async function checkDllLocks(dir: string): Promise<void> {
  for (const e of await fsp.readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`Unexpected link in existing runtime mirror: ${file}`);
    if (e.isDirectory()) await checkDllLocks(file);
    else if (e.name.toLowerCase().endsWith('.dll')) {
      try {await retry('check DLL ' + file, async () => {const handle = await fsp.open(file, 'r+'); await handle.close();});}
      catch (error) {throw locked(error, file);}
    }
  }
}

type Identity = MirrorRecord['identity'];
interface Journal {
  format: 'atlas-runtime-transaction-v1'; source: string; target: string;
  phase: 'prepared' | 'previous-moved' | 'installed' | 'committed' | 'recovered' | 'failed';
  previous: Identity | null; installed?: Identity; oldRecord: MirrorRecord | null;
  originalError?: string; rollbackError?: string; recovery?: string;
}
const identity = (st: fs.Stats): Identity => ({dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs});
const matches = (st: fs.Stats | null, id: Identity | null | undefined) => !!st && !!id && st.dev === id.dev && st.ino === id.ino && st.birthtimeMs === id.birthtimeMs;
async function journalWrite(staging: string, journal: Journal): Promise<void> {
  const temporary = path.join(staging, 'journal-' + randomUUID() + '.tmp');
  await fsp.writeFile(temporary, JSON.stringify(journal, null, 2), {flag: 'wx'});
  await retry('save recovery journal', () => fsp.rename(temporary, path.join(staging, 'transaction.json')));
}

/** Copy is a recovery fallback when a directory handle denies DELETE/rename
 * but still allows reads. Keep the original backup even after copy succeeds. */
async function copyPrevious(source: string, target: string): Promise<void> {
  const st = await fsp.lstat(source);
  if (st.isSymbolicLink()) throw new Error('Recovery copy cannot follow a legacy workspace link.');
  await fsp.mkdir(target); // never overwrite an unexpected destination
  const walk = async (from: string, to: string): Promise<void> => {
    for (const e of await fsp.readdir(from, {withFileTypes: true})) {
      if (e.isSymbolicLink()) throw new Error(`Recovery contains an unexpected link: ${path.join(from, e.name)}`);
      if (e.isDirectory()) {await fsp.mkdir(path.join(to, e.name)); await walk(path.join(from, e.name), path.join(to, e.name));}
      else await retry('restore file ' + e.name, () => fsp.copyFile(path.join(from, e.name), path.join(to, e.name), fs.constants.COPYFILE_EXCL));
    }
  };
  await walk(source, target);
}

async function restorePrevious(staging: string, j: Journal, stateDir: string): Promise<void> {
  const backup = path.join(staging, 'previous'), candidate = path.join(staging, 'runtime');
  let current = await stat(j.target);
  if (matches(current, j.previous)) return; // old copy never moved, or already restored
  if (current) {
    if (!matches(current, j.installed)) throw new Error('Destination changed independently; refusing to replace it during recovery.');
    // If this rename fails the valid newly installed runtime stays available.
    await retry('move failed installation aside', () => fsp.rename(j.target, candidate));
  }
  if (!j.previous) return;
  if (!matches(await stat(backup), j.previous)) throw new Error('Previous runtime identity changed; recovery copy was retained for inspection.');
  try { await retry('rollback previous runtime', () => fsp.rename(backup, j.target)); }
  catch (renameError) {
    j.rollbackError = String(renameError);
    await copyPrevious(backup, j.target);
    j.recovery = 'Restored previous runtime by copying; the locked original backup is retained.';
  }
  current = await fsp.lstat(j.target);
  if (j.oldRecord) await saveRecord({...j.oldRecord, identity: identity(current)}, stateDir);
}

/** Resume an interrupted swap BEFORE reading ownership or pruning siblings.
 * Never remove a failed transaction; its candidate/backup/journal are evidence. */
async function recoverPending(source: string, target: string, stateDir: string, parent: string): Promise<void> {
  for (const e of await fsp.readdir(parent, {withFileTypes: true})) {
    if (!e.isDirectory() || !/^mirror-/.test(e.name)) continue;
    const staging = path.join(parent, e.name);
    let j: Journal;
    try {j = JSON.parse(await fsp.readFile(path.join(staging, 'transaction.json'), 'utf8'));} catch {continue;}
    if (j.format !== 'atlas-runtime-transaction-v1' || !same(j.source, source) || !same(j.target, target) || j.phase === 'committed' || j.phase === 'recovered') continue;
    try {
      await restorePrevious(staging, j, stateDir);
      j.phase = 'recovered'; await journalWrite(staging, j);
      console.warn('[runtime mirror] recovered interrupted sync; retained recovery data:', staging);
    } catch (error) {
      throw new Error(`Runtime recovery is incomplete: ${String(error)}. Original failure: ${j.originalError ?? 'process interrupted during ' + j.phase}. Previous copy: ${path.join(staging, 'previous')}. Candidate: ${path.join(staging, 'runtime')}. Journal: ${path.join(staging, 'transaction.json')}. No recovery data was deleted.`, {cause: error});
    }
  }
}

async function recoverLegacy(source: string, target: string, stateDir: string): Promise<void> {
  if (await stat(target)) return;
  let r: MirrorRecord;
  try {r = JSON.parse(await fsp.readFile(recordPath(target, stateDir), 'utf8'));} catch {return;}
  if (r.format !== 'atlas-runtime-mirror-v1' || !same(r.source, source) || !same(r.target, target)) return;
  const parent = path.join(path.dirname(target), '.atlas-release-stage'), st = await stat(parent);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  for (const e of await fsp.readdir(parent, {withFileTypes: true})) {
    if (!e.isDirectory() || !e.name.startsWith('mirror-')) continue;
    const staging = path.join(parent, e.name), previous = await stat(path.join(staging, 'previous'));
    if (!matches(previous, r.identity)) continue;
    const j: Journal = {format: 'atlas-runtime-transaction-v1', source, target, phase: 'previous-moved', previous: r.identity, oldRecord: r, originalError: 'Interrupted sync from Atlas before transaction journaling.'};
    try {
      await journalWrite(staging, j); await restorePrevious(staging, j, stateDir);
      j.phase = 'recovered'; await journalWrite(staging, j);
      console.warn('[runtime mirror] recovered legacy rollback; retained staging:', staging);
    } catch (error) {throw new Error(`Cannot recover previous runtime from ${staging}: ${String(error)}. Recovery copies have been retained.`, {cause: error});}
    return;
  }
}

interface PreviousRuntime {
  format:'atlas-runtime-previous-v1';source:string;target:string;staging:string;identity:Identity;savedAt:number;plan:ReleasePlan;
}
export interface PreviousRuntimeInfo {savedAt:number;files:number;bytes:number}
const historyPath=(target:string,stateDir:string)=>recordPath(target,stateDir).replace(/\.json$/,'.previous.json');
const stageRoot=(target:string)=>path.join(path.dirname(path.dirname(path.resolve(target))),'.atlas-release-stage');
function validatePreviousPlan(plan:ReleasePlan):void {
  if(!plan?.valid||plan.inventoryOnly||!Array.isArray(plan.files)||!Array.isArray(plan.directories)||!Array.isArray(plan.loadRoots)||!Array.isArray(plan.allowDlls))throw new Error('Invalid previous runtime manifest.');
  for(const root of plan.loadRoots)releaseRelative(root,true);
  for(const dll of plan.allowDlls)releaseRelative(dll);
  const seen=new Set<string>();
  for(const file of plan.files){
    if(releaseRelative(file.path)!==file.path||isDevelopmentPath(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256)||seen.has(file.path.toLowerCase()))throw new Error('Unsafe previous runtime manifest.');
    if(file.path.toLowerCase().endsWith('.dll')&&!allowedDll(file.path,plan))throw new Error(`Unapproved DLL in previous runtime: ${file.path}.`);
    seen.add(file.path.toLowerCase());
  }
  for(const dir of plan.directories)if(releaseRelative(dir)!==dir||isDevelopmentPath(dir))throw new Error('Unsafe previous runtime directory.');
  if(!seen.has('about/about.xml'))throw new Error('Previous runtime has no About/About.xml.');
}
async function readPrevious(source:string,target:string,stateDir:string):Promise<PreviousRuntime|null>{
  const file=historyPath(target,stateDir),st=await stat(file);if(!st)return null;
  if(!st.isFile()||st.isSymbolicLink())throw new Error('Invalid previous runtime record.');
  const h=JSON.parse(await fsp.readFile(file,'utf8')) as PreviousRuntime;
  if(h.format!=='atlas-runtime-previous-v1'||!same(h.source,source)||!same(h.target,target)||path.dirname(path.resolve(h.staging))!==path.resolve(stageRoot(target))||!/^mirror-[\w-]+$/.test(path.basename(h.staging)))throw new Error('Previous runtime paths do not match this mod.');
  for(const dir of [stageRoot(target),h.staging]){const s=await stat(dir);if(!s?.isDirectory()||s.isSymbolicLink())throw new Error('Previous runtime directory is missing or linked.');}
  const journal=path.join(h.staging,'transaction.json'),js=await stat(journal);if(!js?.isFile()||js.isSymbolicLink())throw new Error('Previous runtime journal is missing or linked.');
  const j=JSON.parse(await fsp.readFile(journal,'utf8')) as Journal;
  if(j.format!=='atlas-runtime-transaction-v1'||j.phase!=='committed'||!same(j.source,source)||!same(j.target,target)||!matches(await stat(path.join(h.staging,'previous')),h.identity)||JSON.stringify(j.previous)!==JSON.stringify(h.identity))throw new Error('Previous runtime identity changed; recovery data was retained.');
  if((await fsp.lstat(path.join(h.staging,'previous'))).isSymbolicLink())throw new Error('Previous runtime must not be a link.');
  validatePreviousPlan(h.plan);return h;
}
export async function previousRuntimeInfo(source:string,target:string,stateDir:string):Promise<PreviousRuntimeInfo|null>{
  const h=await readPrevious(source,target,stateDir);return h?{savedAt:h.savedAt,files:h.plan.files.length,bytes:h.plan.files.reduce((n,f)=>n+f.bytes,0)}:null;
}
export async function previousRuntimePlan(source:string,target:string,stateDir:string):Promise<{plan:ReleasePlan;savedAt:number;id:string}>{
  const h=await readPrevious(source,target,stateDir);if(!h)throw new Error('No previous installed runtime is available yet.');
  const root=path.join(h.staging,'previous');
  for(const file of h.plan.files){
    let current=root;for(const part of file.path.split('/')){current=path.join(current,part);if((await fsp.lstat(current)).isSymbolicLink())throw new Error('Previous runtime contains a linked path.');}
    if(await fileSha(current)!==file.sha256)throw new Error(`Previous runtime changed: ${file.path}. It was retained for recovery.`);
  }
  return {plan:withPublishedId(h.plan,await effectivePublishedId(source,target,stateDir)),savedAt:h.savedAt,id:h.staging};
}
async function effectivePublishedId(source:string,target:string,stateDir:string):Promise<string|null>{
  const r=await record(source,target,stateDir),src=await publishedId(source),dst=r?await publishedId(target):null;
  if(r&&dst!==null&&dst!==r.publishedId&&dst!==src){if(src!==r.publishedId)throw new Error('Workshop IDs changed in both workspace and runtime. Resolve them before restoring.');return dst;}
  return src;
}
function withPublishedId(original:ReleasePlan,id:string|null):ReleasePlan {
  const files=original.files.filter(f=>f.path.toLowerCase()!=='about/publishedfileid.txt');
  if(id!==null)files.push({path:'About/PublishedFileId.txt',bytes:Buffer.byteLength(id),sha256:createHash('sha256').update(id).digest('hex')});
  files.sort((a,b)=>a.path.localeCompare(b.path));return {...original,files,totalBytes:files.reduce((n,f)=>n+f.bytes,0)};
}
async function snapshotPlan(target:string,inventory:Pick<ReleasePlan,'files'|'directories'>,hints?:ReleasePlan):Promise<ReleasePlan>{
  const base=hints??await planRelease(target);
  const files=inventory.files.filter(f=>!isDevelopmentPath(f.path)),directories=inventory.directories.filter(d=>!isDevelopmentPath(d));
  const plan={...base,valid:true,inventoryOnly:false,files,directories,totalBytes:files.reduce((n,f)=>n+f.bytes,0),errors:[],warnings:[]};
  validatePreviousPlan(plan);return plan;
}
async function keepPrevious(h:PreviousRuntime,stateDir:string):Promise<void>{
  let prior:PreviousRuntime|null=null;try{prior=await readPrevious(h.source,h.target,stateDir);}catch(error){console.warn('[runtime mirror] older recovery data retained:',String(error));}
  const file=historyPath(h.target,stateDir),temporary=file+'.'+randomUUID()+'.tmp';
  try{await fsp.writeFile(temporary,JSON.stringify(h),{flag:'wx'});await retry('save previous runtime',()=>fsp.rename(temporary,file));}finally{await fsp.unlink(temporary).catch(()=>{});}
  // Retention is one committed version per mod. Failed transaction directories
  // are never candidates for this cleanup; locked older versions are retained.
  if(prior&&prior.staging!==h.staging)try{await readPrevious(h.source,h.target,stateDir);if(matches(await stat(path.join(prior.staging,'previous')),prior.identity))await fsp.rm(prior.staging,{recursive:true,force:true});}catch(error){console.warn('[runtime mirror] older version retained:',prior.staging,String(error));}
}
export interface MirrorInstallOptions {forceWorkspace?:boolean;expectedRuntime?:string;expectedInstalled?:string}
export async function refreshRuntimeMirror(source:string,target:string,stateDir:string,options:MirrorInstallOptions={}):Promise<ReleasePlan>{
  return installRuntimeMirror(source,target,stateDir,options);
}
export async function restoreRuntimeMirror(source:string,target:string,stateDir:string,options:MirrorInstallOptions={}):Promise<ReleasePlan>{
  return exclusive(target,async()=>{const h=await readPrevious(source,target,stateDir);if(!h)throw new Error('No previous installed runtime is available yet.');return installRuntimeMirror(source,target,stateDir,options,h);});
}
async function installRuntimeMirror(source: string, target: string, stateDir: string,options:MirrorInstallOptions,restore?:PreviousRuntime): Promise<ReleasePlan> {
  return exclusive(target, async () => {
    const inside = (parent: string, child: string) => {const r = path.relative(parent, child); return !r || !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep);};
    if (inside(source, target) || inside(target, source)) throw new Error('The runtime mirror must be outside the workspace mod.');
    // Keep candidates/backups outside Mods so game/registry scans cannot
    // discover or open a half-installed mod (or a duplicate previous copy).
    const stagingParent = path.join(path.dirname(path.dirname(path.resolve(target))), '.atlas-release-stage');
    await recoverPending(source, target, stateDir, stagingParent);
    await recoverLegacy(source, target, stateDir);
    const old = await stat(target);
    let owned = await record(source, target, stateDir);
    const legacy = old ? await isLegacyWorkspaceLink(source, target) : false;
    if (old && !owned && !legacy) throw new Error(`Refusing to overwrite an unmanaged game mod: ${target}.`);
    if (owned) {await reconcile(source, target, stateDir);owned=await record(source,target,stateDir);}
    const workspacePlan=await planRelease(source);
    if(owned?.heldWorkspace&&!options.forceWorkspace&&!restore&&owned.heldWorkspace===runtimeSignature(workspacePlan)&&owned.plan){
      try{await auditRelease(target,owned.plan);return {...owned.plan,warnings:[...owned.plan.warnings,'Using the restored runtime. Install update or change runtime files to use the workspace version.']};}catch{/* independently changed runtime must refresh */}
    }
    const plan = restore?withPublishedId(restore.plan,await publishedId(source)):workspacePlan;
    if (!plan.valid) throw new Error('Runtime release check failed:\n' + plan.errors.join('\n'));
    const inventory=owned?await runtimeInventory(target):null;
    if(options.expectedRuntime&&runtimeSignature(plan)!==options.expectedRuntime)throw new Error('Runtime files changed after review. Open the installation preview again.');
    if(options.expectedInstalled&&runtimeSignature(inventory??{files:[],directories:[]})!==options.expectedInstalled)throw new Error('Installed files changed after review. Open the installation preview again.');
    if(inventory&&!restore&&JSON.stringify(inventory)===JSON.stringify({files:plan.files,directories:plan.directories})){
      if(!owned?.plan||owned.heldWorkspace)await saveRecord({...owned!,plan,heldWorkspace:undefined},stateDir);
      watchMirrorId(source,target,stateDir);return plan;
    }
    let previousPlan:ReleasePlan|undefined,historyError:unknown;
    if(inventory)try{previousPlan=await snapshotPlan(target,inventory,owned?.plan);}catch(error){historyError=error;}
    const staging = await fsp.mkdtemp(path.join(stagingParent, 'mirror-'));
    const next = path.join(staging, 'runtime'), backup = path.join(staging, 'previous');
    const j: Journal = {format: 'atlas-runtime-transaction-v1', source: path.resolve(source), target: path.resolve(target), phase: 'prepared', previous: old ? identity(old) : null, oldRecord: owned};
    let committed = false,keepStaging=false;
    try {
      await copyRelease(restore?path.join(restore.staging,'previous'):source, next,restore?.plan??plan);
      if(restore){await writeId(next,await publishedId(source));await auditRelease(next,plan);}
      j.installed = identity(await fsp.lstat(next)); // journal identity before the rename/crash window
      await journalWrite(staging, j);
      if (old && !(await ownedMirror(source, target, stateDir)) && !(await isLegacyWorkspaceLink(source, target))) throw new Error('Runtime mirror ownership changed during copying.');
      if (!old && await stat(target)) throw new Error('A game mod appeared at the mirror destination during copying.');
      if (owned) await checkDllLocks(target);
      if (old) {
        await retry('move previous runtime ' + target, () => fsp.rename(target, backup));
        j.phase = 'previous-moved'; await journalWrite(staging, j);
      }
      await retry('install runtime ' + target, () => fsp.rename(next, target));
      const st = await fsp.lstat(target);
      j.installed = identity(st); j.phase = 'installed'; await journalWrite(staging, j);
      await saveRecord({format: 'atlas-runtime-mirror-v1', source: path.resolve(source), target: path.resolve(target), identity: {dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs}, publishedId: await publishedId(source),plan,heldWorkspace:restore?runtimeSignature(workspacePlan):undefined}, stateDir);
      j.phase = 'committed'; await journalWrite(staging, j);
      committed = true;
      if(owned&&previousPlan&&runtimeSignature(previousPlan)!==runtimeSignature(plan)){
        keepStaging=true;
        try{await keepPrevious({format:'atlas-runtime-previous-v1',source:path.resolve(source),target:path.resolve(target),staging,identity:j.previous!,savedAt:Date.now(),plan:previousPlan},stateDir);}
        catch(error){plan.warnings.push(`The update installed, but its previous version record could not be saved: ${String(error)}. Recovery copy retained at ${staging}.`);}
      }else if(historyError){keepStaging=true;plan.warnings.push(`The update installed. Its previous copy requires manual recovery: ${String(historyError)}. Retained at ${staging}.`);}
      watchMirrorId(source, target, stateDir);
      return plan;
    } catch (error) {
      j.originalError = String(error);
      try { await restorePrevious(staging, j, stateDir); j.phase = 'recovered'; }
      catch (rollbackError) {j.rollbackError = String(rollbackError); j.phase = 'failed';}
      await journalWrite(staging, j).catch(e => console.warn('[runtime mirror] journal write failed:', String(e)));
      const present = await stat(target).catch(() => null);
      const message = `Runtime mirror sync failed: ${String(error)}. ${j.rollbackError ? `Rollback: ${j.rollbackError}. ` : ''}${j.recovery ?? (present ? 'Runtime directory remains present.' : 'Runtime directory is missing; recovery is required before launch.')} Recovery retained at ${staging} (previous, runtime, transaction.json). Workspace sources were not replaced.`;
      console.error('[runtime mirror]', message, JSON.stringify({pid: process.pid, phase: j.phase, destination: target, destinationIdentity: present ? identity(present) : null}));
      throw new Error(message, {cause: error});
    } finally {
      // Only our fresh staging subtree is removed. Legacy junctions are unlinked
      // explicitly so recursive cleanup cannot follow them into the workspace.
      try {
        const before = await stat(backup);
        if (committed&&!keepStaging) {
          if (before?.isSymbolicLink()) await fsp.unlink(backup);
          await fsp.rm(staging, {recursive: true, force: true});
        }
      } catch (error) {console.warn('[runtime mirror] retained staging backup:', staging, String(error));}
    }
  });
}

export async function removeRuntimeMirror(source: string, target: string, stateDir: string): Promise<boolean> {
  return (await uninstallRuntimeMirror(source, target, stateDir)).removed;
}

export interface RuntimeRemovalResult {removed: boolean; retainedPath?: string}

/** Remove only an owned runtime. Move it out of Mods atomically before cleanup,
 * so a Windows lock cannot leave a half-deleted installed directory. */
export async function uninstallRuntimeMirror(source: string, target: string, stateDir: string): Promise<RuntimeRemovalResult> {
  return exclusive(target, async () => {
    let owned = await record(source, target, stateDir);
    const legacy = await isLegacyWorkspaceLink(source, target);
    if (!owned && !legacy) return {removed: false};
    const relative = path.relative(path.resolve(source), path.resolve(target));
    const reverse = path.relative(path.resolve(target), path.resolve(source));
    if (!relative || !reverse || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) || !reverse.startsWith('..' + path.sep) && !path.isAbsolute(reverse)) throw new Error('Workspace and game installation paths must be separate.');
    await reconcile(source, target, stateDir);
    owned = await record(source, target, stateDir);
    if (!legacy) await checkDllLocks(target);
    if (!owned && !await isLegacyWorkspaceLink(source, target)) throw new Error('Runtime mirror ownership changed before removal.');
    const callback = callbacks.get(key(target));
    watchers.get(key(target))?.(); watchers.delete(key(target));
    callbacks.delete(key(target));
    const staging = await fsp.mkdtemp(path.join(path.dirname(path.dirname(path.resolve(target))), '.atlas-release-stage', 'uninstall-'));
    const parked = path.join(staging, 'runtime');
    const original = owned ?? {format:'atlas-runtime-mirror-v1' as const,source:path.resolve(source),target:path.resolve(target),identity:identity(await fsp.lstat(target)),publishedId:null};
    await fsp.writeFile(path.join(staging, 'uninstall.json'), JSON.stringify({source:path.resolve(source),target:path.resolve(target),identity:original.identity,createdAt:new Date().toISOString()}));
    try {
      await saveRecord({...original, removed:true}, stateDir);
      if (legacy ? !await isLegacyWorkspaceLink(source,target) : !await ownedMirror(source,target,stateDir)) throw new Error('Runtime mirror ownership changed before removal.');
      await retry('uninstall runtime ' + target, () => fsp.rename(target, parked));
    } catch (error) {
      let recordError = '';
      try {if(owned)await saveRecord(original,stateDir);else await fsp.unlink(recordPath(target,stateDir));}
      catch (cause) {recordError = ` Ownership recovery: ${String(cause)}.`;}
      if(owned)watchMirrorId(source,target,stateDir,callback);
      throw new Error(`Could not uninstall the game copy: ${String(error)}.${recordError} Close RimWorld and programs using its files, then retry. Removal details: ${staging}. Your Atlas project is retained.`, {cause:error});
    }
    try {
      // Until this succeeds the removal marker remains, so launch recovery
      // cannot recreate a deliberately uninstalled runtime after a crash.
      await retry('remove runtime ownership', () => fsp.unlink(recordPath(target,stateDir)));
      if (legacy) await fsp.unlink(parked); // never recurse through a workspace junction
      const expected = path.join(path.dirname(path.dirname(path.resolve(target))), '.atlas-release-stage') + path.sep;
      if (!staging.startsWith(expected) || (await fsp.lstat(staging)).isSymbolicLink()) throw new Error('Unsafe uninstall cleanup path.');
      await retry('clean uninstalled runtime', () => fsp.rm(staging,{recursive:true,force:true}));
      return {removed:true};
    } catch (error) {
      console.warn('[runtime mirror] uninstalled; cleanup retained:', staging, String(error));
      return {removed:true,retainedPath:staging};
    }
  });
}
