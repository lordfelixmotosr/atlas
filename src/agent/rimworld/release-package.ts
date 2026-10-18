import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const DEV_DIRS = new Set(['source', 'tests', 'test', 'tools', 'artsources', '.atlas', '.modmixer', '.git', '.github', '.vs', '.vscode', '.idea', 'bin', 'obj', 'node_modules', '__pycache__']);
const ROOT_CONTENT = new Set(['defs', 'patches', 'textures', 'sounds', 'assemblies', 'languages', 'strings', 'assetbundles', 'assetpacks']);
const ROOT_DOCUMENTS = /^(?:licen[cs]e|copying|notice|readme)(?:\.(?:txt|md))?$/i;

export interface ReleaseFile { path: string; bytes: number; sha256: string }
export interface ReleasePlan {
  valid: boolean;
  files: ReleaseFile[];
  directories: string[];
  totalBytes: number;
  excluded: string[];
  warnings: string[];
  errors: string[];
  unknownRootFolders: string[];
  versions: { version: string; folders: string[] }[];
  loadRoots: string[];
  allowDlls: string[];
}

/** Directory and filename rules apply at every depth, including explicit extras. */
export function isDevelopmentPath(relative: string): boolean {
  const parts = relative.replace(/\\/g, '/').split('/');
  return parts.some(p => DEV_DIRS.has(p.toLowerCase()))
    || /\.(?:cs|csx|csproj|sln|slnx|pdb|deps\.json|user|suo)$/i.test(parts.at(-1) ?? '')
    || /^assets\.zip/i.test(parts.at(-1) ?? '');
}

/** RimWorld uses / or \\ alone to mean the mod root; never permit an escape. */
export function releaseRelative(value: unknown, rootAllowed = false): string {
  if (typeof value !== 'string') throw new Error('Release paths must be strings.');
  if (rootAllowed && ['/', '\\', '.', ''].includes(value.trim())) return '';
  const p = value.trim().replace(/\\/g, '/').replace(/\/$/, '');
  if (!p || p.startsWith('/') || /[:\x00-\x1f]/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..')) {
    throw new Error(`Unsafe release path: ${JSON.stringify(value)}.`);
  }
  return p;
}

export function loadFolderLists(xml: string): ReleasePlan['versions'] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('LoadFolders.xml must not contain a DTD or entity declaration.');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`Invalid LoadFolders.xml: ${validation.err.msg}`);
  const parsed = new XMLParser({preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false}).parse(xml);
  const root = parsed.find((n: Record<string, unknown>) => Array.isArray(n.loadFolders))?.loadFolders;
  if (!root) throw new Error('LoadFolders.xml must have a loadFolders root.');
  const versions: ReleasePlan['versions'] = [];
  for (const node of root) {
    const tag = Object.keys(node).find(k => !k.startsWith('#') && k !== ':@');
    if (!tag) continue;
    const version = tag.toLowerCase().replace(/^v/, '');
    if (version !== 'default' && !/^\d+\.\d+(?:\.\d+)*$/.test(version)) throw new Error(`Invalid LoadFolders.xml version: ${tag}.`);
    const folders: string[] = [];
    for (const child of node[tag]) {
      const entryTag = Object.keys(child).find(k => !k.startsWith('#') && k !== ':@');
      if (!entryTag) continue;
      const text = child[entryTag].map((n: Record<string, unknown>) => n['#text'] ?? '').join('');
      folders.push(releaseRelative(text, true));
    }
    if (!folders.length) throw new Error(`LoadFolders.xml ${tag} has no folders.`);
    const existing = versions.find(v => v.version === version);
    if (existing) existing.folders.push(...folders); else versions.push({version, folders});
  }
  return versions;
}

export async function fileSha(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function safeRoot(root: string): Promise<string> {
  const st = await fsp.lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Release root must be a real directory: ${root}`);
  return fsp.realpath(root);
}

/** Read-only, deterministic selection for BOTH the game mirror and Steam upload. */
export async function planRelease(modDir: string, virtualFiles: Record<string, string> = {}): Promise<ReleasePlan> {
  const root = await safeRoot(modDir);
  const plan: ReleasePlan = {valid: false, files: [], directories: [], totalBytes: 0, excluded: [], warnings: [], errors: [], unknownRootFolders: [], versions: [], loadRoots: [], allowDlls: []};
  const top = await fsp.readdir(root, {withFileTypes: true});
  const find = (name: string) => top.find(e => e.name.toLowerCase() === name.toLowerCase());
  const selected = new Set<string>();
  const roots = new Set<string>();
  const explicitlyIgnored: string[] = [];
  let extras: string[] = [];
  try {
    const sidecar = path.join(root, '.atlas');
    if (fs.existsSync(sidecar) && (await fsp.lstat(sidecar)).isSymbolicLink()) throw new Error('.atlas must not be a link.');
    const manifest = path.join(sidecar, 'release.json');
    if (fs.existsSync(manifest)) {
      if (!(await fsp.lstat(manifest)).isFile() || (await fsp.lstat(manifest)).isSymbolicLink()) throw new Error('release.json must be a regular file.');
      const m = JSON.parse(await fsp.readFile(manifest, 'utf8'));
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('release.json must be an object.');
      for (const key of Object.keys(m)) if (!['include', 'exclude', 'allowDlls'].includes(key)) throw new Error(`Unknown release.json field: ${key}.`);
      for (const key of ['include', 'exclude', 'allowDlls']) if (m[key] !== undefined && !Array.isArray(m[key])) throw new Error(`release.json ${key} must be an array.`);
      extras = (m.include ?? []).map((p: unknown) => releaseRelative(p));
      explicitlyIgnored.push(...(m.exclude ?? []).map((p: unknown) => releaseRelative(p)));
      plan.allowDlls = (m.allowDlls ?? []).map((p: unknown) => releaseRelative(p));
      for (const p of [...extras, ...plan.allowDlls]) if (isDevelopmentPath(p)) throw new Error(`release.json cannot include development path ${p}.`);
      for (const p of plan.allowDlls) if (!p.toLowerCase().endsWith('.dll')) throw new Error(`allowDlls requires exact DLL paths: ${p}.`);
    }
    const lf = find('LoadFolders.xml');
    if (lf) {
      if (lf.isSymbolicLink()) throw new Error('LoadFolders.xml must not be a link.');
      selected.add(lf.name);
      plan.versions = loadFolderLists(await fsp.readFile(path.join(root, lf.name), 'utf8'));
    }
    if (plan.versions.length) {
      for (const v of plan.versions) for (const p of v.folders) roots.add(p);
    } else {
      roots.add('');
      for (const entry of top) if (entry.isDirectory() && (entry.name === 'Common' || /^\d+\.\d+(?:\.\d+)*$/.test(entry.name))) roots.add(entry.name);
    }
    for (const p of roots) {
      if (isDevelopmentPath(p)) throw new Error(`LoadFolders.xml references development folder ${p}.`);
      if (p) {
        const st = await fsp.lstat(path.join(root, p)).catch(() => null);
        if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error(`Load folder is missing or is a link: ${p}.`);
        selected.add(p);
      } else for (const entry of top) if (ROOT_CONTENT.has(entry.name.toLowerCase())) selected.add(entry.name);
    }
    const about = find('About');
    if (!about) throw new Error('About/About.xml is required.');
    selected.add(about.name);
    for (const entry of top) if (entry.isFile() && ROOT_DOCUMENTS.test(entry.name)) selected.add(entry.name);
    for (const p of extras) {
      const st = await fsp.lstat(path.join(root, p)).catch(() => null);
      if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error(`Extra release folder is missing or is a link: ${p}.`);
      selected.add(p);
    }
  } catch (error) { plan.errors.push(error instanceof Error ? error.message : String(error)); }
  plan.loadRoots = [...roots];
  const under = (p: string, parent: string) => p.toLowerCase() === parent.toLowerCase() || p.toLowerCase().startsWith(parent.toLowerCase() + '/');
  const ignored = (p: string) => explicitlyIgnored.some(e => under(p, e));
  for (const p of selected) if (ignored(p)) plan.errors.push(`Cannot exclude required release folder/file ${p}.`);
  const seen = new Set<string>();
  const visit = async (relative: string): Promise<void> => {
    if (isDevelopmentPath(relative) || ignored(relative)) {plan.excluded.push(relative); return;}
    const full = path.join(root, relative);
    let ancestor = root;
    for (const part of relative.split('/')) {
      ancestor = path.join(ancestor, part);
      if ((await fsp.lstat(ancestor)).isSymbolicLink()) {plan.errors.push(`Linked release path is not allowed: ${relative}.`); return;}
    }
    const st = await fsp.lstat(full);
    if (st.isSymbolicLink()) {plan.errors.push(`Linked release path is not allowed: ${relative}. Materialize its runtime files first.`); return;}
    if (st.isDirectory()) {
      plan.directories.push(relative);
      for (const e of await fsp.readdir(full, {withFileTypes: true})) await visit(relative + '/' + e.name);
    } else if (st.isFile()) {
      if (seen.has(relative)) return;
      seen.add(relative);
      plan.files.push({path: relative, bytes: st.size, sha256: await fileSha(full)});
    } else plan.errors.push(`Non-regular release file: ${relative}.`);
  };
  for (const p of selected) try {await visit(p);} catch (error) {plan.errors.push(`Cannot read ${p}: ${String(error)}`);}
  for (const entry of top) {
    if (isDevelopmentPath(entry.name) || ignored(entry.name)) {plan.excluded.push(entry.name); continue;}
    if ([...selected].some(p => under(p, entry.name))) continue;
    plan.excluded.push(entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) plan.unknownRootFolders.push(entry.name);
    else plan.warnings.push(`Root file omitted: ${entry.name}.`);
  }
  for (const folder of plan.unknownRootFolders) plan.warnings.push(`Unknown root folder omitted: ${folder}/. If the mod reads it by path, add it to .atlas/release.json include.`);
  for (const [name, text] of Object.entries(virtualFiles)) {
    const relative = releaseRelative(name);
    if (isDevelopmentPath(relative)) throw new Error('Development path in virtual release files.');
    plan.files = plan.files.filter(f => f.path !== relative);
    plan.files.push({path: relative, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex')});
  }
  if (!plan.files.some(f => f.path.toLowerCase() === 'about/about.xml')) plan.errors.push('About/About.xml is missing from the runtime package.');
  const folded = new Set<string>();
  for (const file of plan.files) {
    if (folded.has(file.path.toLowerCase())) plan.errors.push(`Case-colliding release path: ${file.path}.`);
    folded.add(file.path.toLowerCase());
    if (file.path.toLowerCase().endsWith('.dll') && !allowedDll(file.path, plan)) plan.errors.push(`Stray DLL: ${file.path}. DLLs must be in a loaded content root's Assemblies/ or declared by exact path in release.json allowDlls.`);
  }
  plan.files.sort((a, b) => a.path.localeCompare(b.path));
  plan.totalBytes = plan.files.reduce((n, f) => n + f.bytes, 0);
  plan.excluded = [...new Set(plan.excluded)].sort();
  plan.directories = [...new Set(plan.directories)].sort();
  plan.valid = plan.errors.length === 0;
  return plan;
}

function allowedDll(relative: string, plan: Pick<ReleasePlan, 'loadRoots' | 'allowDlls'>): boolean {
  const p = relative.toLowerCase();
  if (/^(?:assembly-csharp(?:-firstpass)?|unityengine(?:\..*)?|unitystubs|waylith(?:\..*)?|brutal(?:\..*)?|system\.private\.corelib|mscorlib|netstandard)\.dll$/i.test(path.posix.basename(p))) return false;
  return plan.allowDlls.some(d => d.toLowerCase() === p) || plan.loadRoots.some(r => p.startsWith((r ? r.toLowerCase() + '/' : '') + 'assemblies/'));
}

export function assertRelease(plan: ReleasePlan): void {
  if (!plan.valid) throw new Error('Runtime release check failed:\n' + plan.errors.join('\n'));
}

/** Re-audit actual output, including injected/leftover files, before it can upload. */
export async function auditRelease(output: string, plan: ReleasePlan): Promise<void> {
  await safeRoot(output);
  const expected = new Map(plan.files.map(f => [f.path, f]));
  const seen = new Set<string>();
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const e of await fsp.readdir(dir, {withFileTypes: true})) {
      const relative = prefix + e.name;
      if (e.isSymbolicLink() || isDevelopmentPath(relative)) throw new Error(`Development or linked path in runtime mirror: ${relative}.`);
      if (e.isDirectory()) await walk(path.join(dir, e.name), relative + '/');
      else {
        const entry = expected.get(relative);
        if (!entry) throw new Error(`Unexpected runtime file: ${relative}.`);
        if (relative.toLowerCase().endsWith('.dll') && !allowedDll(relative, plan)) throw new Error(`Stray DLL in runtime mirror: ${relative}.`);
        if (await fileSha(path.join(dir, e.name)) !== entry.sha256) throw new Error(`Runtime file changed during staging: ${relative}. Retry the dry run.`);
        seen.add(relative);
      }
    }
  };
  await walk(output);
  for (const dir of plan.directories) if (!(await fsp.lstat(path.join(output, dir)).catch(() => null))?.isDirectory()) throw new Error(`Runtime mirror is missing load directory ${dir}.`);
  if (seen.size !== expected.size) throw new Error('Runtime mirror is missing planned files. Retry the sync.');
}

/** Destination must be a fresh directory owned by the caller. No links survive. */
export async function copyRelease(source: string, output: string, plan: ReleasePlan): Promise<void> {
  assertRelease(plan);
  await safeRoot(source);
  if (path.resolve(source) === path.resolve(output)) throw new Error('A runtime copy must not replace its workspace.');
  await fsp.mkdir(output, {recursive: false});
  for (const dir of plan.directories) await fsp.mkdir(path.join(output, dir), {recursive: true});
  for (const entry of plan.files) {
    let current = source;
    for (const part of entry.path.split('/')) {
      current = path.join(current, part);
      if ((await fsp.lstat(current)).isSymbolicLink()) throw new Error(`Linked release path changed during copy: ${entry.path}.`);
    }
    const dest = path.join(output, entry.path);
    await fsp.mkdir(path.dirname(dest), {recursive: true});
    await fsp.copyFile(current, dest, fs.constants.COPYFILE_EXCL);
  }
  await auditRelease(output, plan);
}
