import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { metadataReadPath, metadataWritePath } from '../agent/mod-metadata';

type FileRecord = { hash: string; size: number; modifiedAt: number; defs?: Record<string, { hash: string; type: string; label: string }> };
export type ModInventory = { signature: string; modifiedAt: number; files: Record<string, FileRecord> };
type Baseline = { at: number; kind: 'published' | 'updated' | 'tracking'; note: string; inventory: ModInventory };
type State = { version: 1; first: Baseline; published?: Baseline; updated?: Baseline; observed: { signature: string; at: number } };
export interface ModChangeFile { path: string; action: 'added' | 'edited' | 'removed'; category: string; description: string }
export interface ModChangeReport {
  status: 'modified' | 'clean' | 'tracking' | 'unavailable';
  label: string; description: string; baselineAt: number | null; baselineKind: string | null;
  lastModifiedAt: number; lastPublishedAt: number | null; lastUpdatedAt: number | null;
  note: string; count: number; files: ModChangeFile[];
}
export type ModChangeSummary = Omit<ModChangeReport, 'files'>;
const skipped = new Set(['.git', '.atlas', '.modmixer', '.vs', '.DS_Store', 'bin', 'obj', 'node_modules']);
const cache = new Map<string, { stamp: string; value: FileRecord }>();
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function definitions(text: string): FileRecord['defs'] {
  const result: NonNullable<FileRecord['defs']> = Object.create(null);
  const expression = /<([A-Za-z_][\w.]*)\b[^>]*>[\s\S]*?<\/\1>/g;
  // Inspect direct Def children, avoiding a root <Defs> match swallowing the file.
  text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?Defs\b[^>]*>/gi, '');
  for (const match of text.matchAll(expression)) {
    const name = match[0].match(/<defName>\s*([^<]+)\s*<\/defName>/i)?.[1]?.trim();
    if (!name) continue;
    const label = match[0].match(/<label>\s*([^<]+)\s*<\/label>/i)?.[1]?.trim() ?? '';
    result[name] = { hash: hash(match[0]), type: match[1], label };
  }
  return result;
}

/** Hash actual content, caching only unchanged size/mtime/ctime identities. */
export async function collectModInventory(root: string): Promise<ModInventory> {
  if ((await fsp.lstat(root)).isSymbolicLink()) throw new Error('Linked project folders cannot be compared.');
  const files: Record<string, FileRecord> = Object.create(null);
  let modifiedAt = 0, count = 0;
  async function walk(dir: string, depth: number) {
    if (depth > 32) throw new Error('Project nesting is too deep to compare.');
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const full = path.join(dir, entry.name), relative = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error('Linked path cannot be compared: ' + relative);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      if (++count > 20000) throw new Error('Projects over 20,000 files cannot be compared automatically.');
      const stat = await fsp.lstat(full), stamp = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
      const previous = cache.get(full);
      let record: FileRecord;
      if (previous?.stamp === stamp) record = previous.value;
      else {
        const digest = createHash('sha256');
        for await (const chunk of fs.createReadStream(full)) digest.update(chunk);
        record = { hash: digest.digest('hex'), size: stat.size, modifiedAt: stat.mtimeMs };
        if (/\.xml$/i.test(relative) && stat.size <= 2 * 1024 * 1024) record.defs = definitions(await fsp.readFile(full, 'utf8'));
        const after = await fsp.lstat(full);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('File changed during comparison. Refresh when work finishes: ' + relative);
        if (cache.size > 30000) cache.clear();
        cache.set(full, { stamp, value: record });
      }
      files[relative] = record; modifiedAt = Math.max(modifiedAt, record.modifiedAt);
    }
  }
  await walk(root, 0);
  return { files, modifiedAt, signature: hash(Object.keys(files).sort().map(file => file + '\0' + files[file].hash).join('\n')) };
}

function relativeStore(root: string) { return 'mod-changes/' + path.basename(root) + '/state.json'; }
async function readState(root: string): Promise<State | null> {
  const file = metadataReadPath(path.dirname(root), relativeStore(root));
  try {
    const state = JSON.parse(await fsp.readFile(file, 'utf8')) as State;
    if (state.version !== 1 || !state.first?.inventory?.files || !state.observed || !Number.isFinite(state.first.at)) throw new Error('The saved change baseline is invalid.');
    return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function saveState(root: string, state: State) {
  const file = metadataWritePath(path.dirname(root), relativeStore(root));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await fsp.writeFile(temporary, JSON.stringify(state), { flag: 'wx' }); await fsp.rename(temporary, file); }
  finally { await fsp.rm(temporary, { force: true }); }
}
function category(file: string) {
  if (/\.cs$/i.test(file)) return 'C# source';
  if (/\.(png|dds|jpg|jpeg|webp)$/i.test(file)) return 'textures / images';
  if (/\.(ogg|wav|mp3)$/i.test(file)) return 'audio';
  if (/^Defs\//i.test(file)) return 'Def XML';
  if (/^Patches\//i.test(file)) return 'patch XML';
  if (/^About\//i.test(file)) return 'mod metadata';
  if (/^Languages\//i.test(file)) return 'translations';
  if (/\.(dll|pdb)$/i.test(file)) return 'compiled assemblies';
  return 'other files';
}
export function compareModInventories(previous: ModInventory, current: ModInventory): ModChangeFile[] {
  const rows: ModChangeFile[] = [];
  for (const file of [...new Set([...Object.keys(previous.files), ...Object.keys(current.files)])].sort()) {
    const before = Object.hasOwn(previous.files, file) ? previous.files[file] : undefined, after = Object.hasOwn(current.files, file) ? current.files[file] : undefined;
    if (before?.hash === after?.hash) continue;
    const action = !before ? 'added' : !after ? 'removed' : 'edited', group = category(file), details: string[] = [];
    const oldDefs = before?.defs ?? {}, newDefs = after?.defs ?? {};
    for (const name of new Set([...Object.keys(oldDefs), ...Object.keys(newDefs)])) {
      const oldDef = Object.hasOwn(oldDefs, name) ? oldDefs[name] : undefined, newDef = Object.hasOwn(newDefs, name) ? newDefs[name] : undefined;
      if (oldDef?.hash === newDef?.hash) continue;
      const def = newDef ?? oldDef!;
      details.push((!oldDef ? 'Added ' : !newDef ? 'Removed ' : 'Edited ') + def.type + ' ' + name + (def.label ? ' (“' + def.label + '”)' : ''));
    }
    rows.push({ path: file, action, category: group, description: details.length ? details.slice(0, 8).join('; ') + (details.length > 8 ? `; ${details.length - 8} more definitions` : '') : `${action === 'added' ? 'Added' : action === 'removed' ? 'Removed' : 'Edited'} ${group}: ${path.basename(file)}` });
  }
  return rows;
}
function description(rows: ModChangeFile[]) {
  const groups = new Map<string, number>();
  for (const row of rows) { const key = (row.action === 'added' ? 'Added' : row.action === 'removed' ? 'Removed' : 'Edited') + ' / ' + row.category; groups.set(key, (groups.get(key) ?? 0) + 1); }
  return [...groups].map(([group, count]) => group.replace(' / ', ` ${count} `)).join('; ') + '.';
}
// Serialize baseline writes and reads per project, including publication races.
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(root: string, run: () => Promise<T>): Promise<T> {
  const pending = (locks.get(root) ?? Promise.resolve()).catch(() => {}).then(run);
  locks.set(root, pending);
  void pending.finally(() => { if (locks.get(root) === pending) locks.delete(root); }).catch(() => {});
  return pending;
}
export function recordModBaseline(root: string, kind: 'published' | 'updated', note = '', captured?: ModInventory, savedAt = Date.now()): Promise<void> {
  return exclusive(root, async () => {
    const inventory = captured ?? await collectModInventory(root), now = savedAt;
    const baseline: Baseline = { at: now, kind, note: note.trim().slice(0, 4000), inventory };
    const previous = await readState(root);
    const state: State = previous ?? { version: 1, first: baseline, observed: { signature: inventory.signature, at: inventory.modifiedAt || now } };
    state[kind] = baseline;
    await saveState(root, state);
  });
}
export function readModChanges(root: string, lastPublishedAt: number | null = null, comparison: 'latest' | 'published' | 'updated' = 'latest'): Promise<ModChangeReport> {
  return exclusive(root, async () => {
    try {
      const current = await collectModInventory(root), now = Date.now();
      let state = await readState(root), changedState = false;
      if (!state) {
        const first: Baseline = { at: now, kind: 'tracking', note: '', inventory: current };
        state = { version: 1, first, observed: { signature: current.signature, at: current.modifiedAt || now } }; changedState = true;
      }
      if (state.observed.signature !== current.signature) {
        state.observed = { signature: current.signature, at: Math.max(current.modifiedAt, now) }; changedState = true;
      }
      if (changedState) await saveState(root, state);
      const latest = [state.published, state.updated].filter((x): x is Baseline => !!x).sort((a, b) => b.at - a.at)[0];
      const baseline = comparison === 'latest' ? latest ?? state.first : state[comparison];
      const common = { lastModifiedAt: state.observed.at, lastPublishedAt: state.published?.at ?? lastPublishedAt, lastUpdatedAt: state.updated?.at ?? null, note: baseline?.note ?? '' };
      if (baseline?.kind === 'published' && lastPublishedAt && lastPublishedAt > baseline.at) return { ...common, lastPublishedAt, status: 'unavailable', label: 'Published comparison missing', description: 'The latest publication did not save a file comparison. An older publication snapshot cannot describe the latest upload.', baselineAt: null, baselineKind: null, count: 0, files: [] };
      if (!baseline) return { ...common, status: 'unavailable', label: 'No comparison saved', description: `No file snapshot exists for the last ${comparison === 'published' ? 'publication' : 'marked update'}. Tracking started ${new Date(state.first.at).toLocaleString()}.`, baselineAt: null, baselineKind: null, count: 0, files: [] };
      const files = compareModInventories(baseline.inventory, current), tracking = baseline.kind === 'tracking';
      return { ...common, status: files.length ? 'modified' : tracking ? 'tracking' : 'clean', label: files.length ? baseline.kind === 'published' ? 'Unpublished changes' : baseline.kind === 'updated' ? 'Changes since update' : 'Changes since tracking started' : tracking ? 'Tracking started' : 'No changes since ' + (baseline.kind === 'published' ? 'publication' : 'update'), description: files.length ? description(files) : tracking ? 'No earlier file snapshot exists. Future changes will be compared from this point.' : 'Mod content matches the saved comparison.', baselineAt: baseline.at, baselineKind: baseline.kind, count: files.length, files };
    } catch (error) {
      return { status: 'unavailable', label: 'Change comparison unavailable', description: error instanceof Error ? error.message : String(error), baselineAt: null, baselineKind: null, lastModifiedAt: 0, lastPublishedAt, lastUpdatedAt: null, note: '', count: 0, files: [] };
    }
  });
}
export async function readModChangeSummary(root: string, lastPublishedAt: number | null): Promise<ModChangeSummary> {
  const { files: _files, ...summary } = await readModChanges(root, lastPublishedAt); return summary;
}
