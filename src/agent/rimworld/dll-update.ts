import fs from 'node:fs/promises';
import path from 'node:path';
import {fileSha, planRelease} from './release-package.js';
import {ownedMirror, missingRecordedMirror} from './runtime-mirror.js';
import type {RegistrySnapshot} from '../registry/types.js';

export interface DllChange {path: string; action: 'added' | 'modified' | 'removed'}
export interface ModDllUpdate {folder: string; name: string; changes: DllChange[]; error?: string}
export interface DllUpdateOverview {running: boolean; pending: boolean; mods: ModDllUpdate[]; error?: string}
export type DllInstallResult = {status: 'installed'; installed: string[]; warnings: string[]}
  | {status: 'current'}
  | {status: 'confirmation'; token: string; message: string; running: boolean};

/** Includes transitive workspace dependencies and the last test's companions. */
export function dllTestFolders(snapshot: RegistrySnapshot, folder: string, companions: string[]): string[] {
  const byId = new Map(snapshot.mods.filter(m => m.source === 'workspace').map(m => [m.about.packageIdLc, m]));
  const target = snapshot.mods.find(m => m.source === 'workspace' && m.folder === folder);
  if (target?.about.packageIdLc) byId.set(target.about.packageIdLc, target);
  const selected = new Set<string>([folder]);
  const queue = [target?.about.packageIdLc, ...companions.map(p => p.toLowerCase())].filter((p): p is string => !!p);
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; if (seen.has(id)) continue; seen.add(id);
    const mod = byId.get(id); if (!mod) continue;
    selected.add(mod.folder);
    for (const dep of mod.about.modDependencies) queue.push(dep.packageId.toLowerCase());
  }
  return [...selected];
}

async function installedDlls(root: string): Promise<Map<string, {path: string; sha256: string}>> {
  const files = new Map<string, {path: string; sha256: string}>();
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const e of await fs.readdir(dir, {withFileTypes: true})) {
      const relative = prefix + e.name, full = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error(`Unexpected link in runtime copy: ${relative}`);
      if (e.isDirectory()) await walk(full, relative + '/');
      else if (e.isFile() && e.name.toLowerCase().endsWith('.dll')) files.set(relative.toLowerCase(), {path: relative, sha256: await fileSha(full)});
    }
  };
  await walk(root); return files;
}

/** Hash DLL bytes, not timestamps or C# source; never read texture contents. */
export async function inspectDllUpdate(source: string, target: string, stateDir: string): Promise<DllChange[]> {
  const owned = await ownedMirror(source, target, stateDir), missing = !owned && await missingRecordedMirror(source, target, stateDir);
  if (!owned && !missing) return []; // first installation uses the ordinary Test action
  const plan = await planRelease(source, {}, true);
  if (!plan.valid) throw new Error(plan.errors.join('\n'));
  const desired = new Map(plan.files.filter(f => f.path.toLowerCase().endsWith('.dll')).map(f => [f.path.toLowerCase(), f]));
  const installed = missing ? new Map<string, {path: string; sha256: string}>() : await installedDlls(target);
  const changes: DllChange[] = [];
  for (const [key, file] of desired) {
    const previous = installed.get(key);
    if (!previous || previous.sha256 !== file.sha256) changes.push({path: file.path, action: previous ? 'modified' : 'added'});
  }
  for (const [key, file] of installed) if (!desired.has(key)) changes.push({path: file.path, action: 'removed'});
  return changes.sort((a,b) => a.path.localeCompare(b.path));
}
