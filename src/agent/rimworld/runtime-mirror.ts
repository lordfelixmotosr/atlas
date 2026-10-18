import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { planRelease, copyRelease, type ReleasePlan } from './release-package.js';

interface MirrorRecord {
  format: 'atlas-runtime-mirror-v1';
  source: string;
  target: string;
  identity: {dev: number; ino: number; birthtimeMs: number};
  publishedId: string | null;
}
const locks = new Map<string, Promise<unknown>>();
const watchers = new Map<string, () => void>();
const callbacks = new Map<string, () => void>();
const key = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const recordPath = (target: string, stateDir: string) => path.join(stateDir, createHash('sha256').update(key(target)).digest('hex') + '.json');
const same = (a: string, b: string) => key(a) === key(b);

function exclusive<T>(target: string, work: () => Promise<T>): Promise<T> {
  const k = key(target);
  const task = (locks.get(k) ?? Promise.resolve()).catch(() => {}).then(work);
  locks.set(k, task);
  void task.finally(() => {if (locks.get(k) === task) locks.delete(k);}).catch(() => {});
  return task;
}

async function stat(p: string) { return fsp.lstat(p).catch((error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return null; throw error;}); }

export async function ownedMirror(source: string, target: string, stateDir: string): Promise<boolean> {
  return (await record(source, target, stateDir)) !== null;
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
  try {await fsp.writeFile(temporary, JSON.stringify(r), {flag: 'wx'}); await fsp.rename(temporary, destination);}
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
  if (r.publishedId !== src) {r.publishedId = src; await saveRecord(r, stateDir);}
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
  const update = () => {void reconcileMirrorId(source, target, stateDir).then(changed => {if (changed) callbacks.get(k)?.();}).catch(error => console.warn('[runtime mirror] Workshop ID recovery:', String(error)));};
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
      if (await ownedMirror(r.source, r.target, stateDir)) watchMirrorId(r.source, r.target, stateDir, () => onChange?.(path.basename(r.source)));
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
      try {const handle = await fsp.open(file, 'r+'); await handle.close();}
      catch (error) {throw locked(error, file);}
    }
  }
}

export async function refreshRuntimeMirror(source: string, target: string, stateDir: string): Promise<ReleasePlan> {
  return exclusive(target, async () => {
    const inside = (parent: string, child: string) => {const r = path.relative(parent, child); return !r || !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep);};
    if (inside(source, target) || inside(target, source)) throw new Error('The runtime mirror must be outside the workspace mod.');
    const old = await stat(target);
    const owned = await record(source, target, stateDir);
    const legacy = old ? await isLegacyWorkspaceLink(source, target) : false;
    if (old && !owned && !legacy) throw new Error(`Refusing to overwrite an unmanaged game mod: ${target}.`);
    if (owned) await reconcile(source, target, stateDir);
    const plan = await planRelease(source);
    if (!plan.valid) throw new Error('Runtime release check failed:\n' + plan.errors.join('\n'));
    const stagingParent = path.join(path.dirname(target), '.atlas-release-stage');
    await fsp.mkdir(stagingParent, {recursive: true});
    if ((await fsp.lstat(stagingParent)).isSymbolicLink()) throw new Error('Runtime staging directory must not be a link.');
    const staging = await fsp.mkdtemp(path.join(stagingParent, 'mirror-'));
    const next = path.join(staging, 'runtime'), backup = path.join(staging, 'previous');
    let movedOld = false, installed = false, committed = false;
    try {
      await copyRelease(source, next, plan);
      if (old && !(await ownedMirror(source, target, stateDir)) && !(await isLegacyWorkspaceLink(source, target))) throw new Error('Runtime mirror ownership changed during copying.');
      if (!old && await stat(target)) throw new Error('A game mod appeared at the mirror destination during copying.');
      if (owned) await checkDllLocks(target);
      if (old) {try {await fsp.rename(target, backup);} catch (error) {throw locked(error, target + ' (mirror directory)');} movedOld = true;}
      await fsp.rename(next, target); installed = true;
      const st = await fsp.lstat(target);
      await saveRecord({format: 'atlas-runtime-mirror-v1', source: path.resolve(source), target: path.resolve(target), identity: {dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs}, publishedId: await publishedId(source)}, stateDir);
      committed = true;
      watchMirrorId(source, target, stateDir);
      return plan;
    } catch (error) {
      if (!committed) {
        if (installed) await fsp.rename(target, next);
        if (movedOld) await fsp.rename(backup, target);
      }
      throw error;
    } finally {
      // Only our fresh staging subtree is removed. Legacy junctions are unlinked
      // explicitly so recursive cleanup cannot follow them into the workspace.
      try {
        const before = await stat(backup);
        if (!before || committed) {
          if (before?.isSymbolicLink()) await fsp.unlink(backup);
          await fsp.rm(staging, {recursive: true, force: true});
        }
      } catch (error) {console.warn('[runtime mirror] retained staging backup:', staging, String(error));}
    }
  });
}

export async function removeRuntimeMirror(source: string, target: string, stateDir: string): Promise<boolean> {
  return exclusive(target, async () => {
    const owned = await record(source, target, stateDir);
    if (await isLegacyWorkspaceLink(source, target)) {await fsp.unlink(target); return true;}
    if (!owned) return false;
    await reconcile(source, target, stateDir);
    await checkDllLocks(target);
    // The filesystem identity was checked above; never delete an unowned folder.
    if (!await ownedMirror(source, target, stateDir)) throw new Error('Runtime mirror ownership changed before removal.');
    watchers.get(key(target))?.(); watchers.delete(key(target));
    callbacks.delete(key(target));
    await fsp.rm(target, {recursive: true, force: true});
    await fsp.unlink(recordPath(target, stateDir));
    return true;
  });
}
