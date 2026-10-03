import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { parseAboutXml } from '../agent/registry/about-xml';

export interface ModMixerImportRow {
  folder: string;
  name: string;
  packageId: string;
  status: 'ready' | 'imported' | 'unsupported' | 'invalid';
  detail: string;
}
export interface ModMixerImportPlan {
  token: string;
  source: string | null;
  sources: string[];
  rows: ModMixerImportRow[];
}
export interface ModMixerImportProgress {
  token: string;
  completed: number;
  total: number;
  current: string;
  copiedFiles: number;
}
export interface ModMixerImportResult {
  imported: { sourceFolder: string; folder: string; name: string }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
  cancelled: boolean;
}

const RECEIPT = '.atlas/modmixer-import.json';
const SKIP = new Set(['.git', '.vs', '.DS_Store', 'node_modules', 'bin', 'obj']);
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const sourceId = (root: string, folder: string) => createHash('sha256').update((process.platform === 'win32' ? root.toLowerCase() : root) + '\0' + folder).digest('hex');

async function directory(file: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(file);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// No migration helpers on the source: even metadata reads must leave ModMixer untouched.
async function readSmall(root: string, relative: string): Promise<string | null> {
  let file = root;
  for (const segment of relative.split('/')) {
    file = path.join(file, segment);
    try {
      const stat = await fsp.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Linked files or folders cannot be imported.');
      if (file === path.join(root, ...relative.split('/'))) {
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Mod metadata is not a readable file (maximum 4 MB).');
      } else if (!stat.isDirectory()) throw new Error('Invalid mod metadata folder.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return fsp.readFile(file, 'utf8');
}

/** Accept a profile, portable root, workspace or its Mods folder. */
export async function resolveModMixerWorkspace(input: string, destination: string): Promise<string> {
  const selected = await fsp.realpath(input);
  for (const suffix of ['workspace/Mods', 'data/profile/workspace/Mods', 'Mods', '']) {
    const candidate = path.join(selected, suffix);
    if (!await directory(candidate)) continue;
    if (suffix === '' && path.basename(candidate).toLowerCase() !== 'mods') continue;
    const resolved = await fsp.realpath(candidate);
    const target = await fsp.realpath(destination);
    if (inside(resolved, target) || inside(target, resolved)) throw new Error('Choose the old ModMixer workspace, outside the Atlas workspace.');
    return resolved;
  }
  throw new Error('No ModMixer workspace found. Choose its profile, portable folder, workspace, or workspace/Mods folder.');
}

export async function detectModMixerWorkspaces(appData: string, destination: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ['Modmixer', 'ModMixer', 'modmixer']) {
    const candidate = path.join(appData, name);
    if (!await directory(candidate)) continue;
    try {
      const source = await resolveModMixerWorkspace(candidate, destination);
      if (!found.some(x => x.toLowerCase() === source.toLowerCase())) found.push(source);
    } catch { /* A manual folder choice is available for other installations. */ }
  }
  return found;
}

async function importedIds(workspace: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const entry of await fsp.readdir(workspace, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const raw = await readSmall(path.join(workspace, entry.name), RECEIPT);
      if (raw) {
        const receipt = JSON.parse(raw);
        if (receipt.version === 1 && typeof receipt.sourceId === 'string') ids.add(receipt.sourceId);
      }
    } catch { /* An unrelated or damaged receipt is not proof of a previous import. */ }
  }
  return ids;
}

async function inspect(root: string, folder: string, ids: Set<string>): Promise<ModMixerImportRow> {
  const row: ModMixerImportRow = { folder, name: folder, packageId: '', status: 'ready', detail: '' };
  try {
    if (!await directory(path.join(root, folder))) throw new Error('Linked or missing project folder.');
    const mod = path.join(root, folder);
    const rawPrefs = await readSmall(mod, '.atlas/prefs.json') ?? await readSmall(mod, '.modmixer/prefs.json');
    const prefs = rawPrefs === null ? {} : JSON.parse(rawPrefs);
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('Invalid preferences.');
    if (prefs.game && prefs.game !== 'rimworld') return { ...row, status: 'unsupported', detail: 'Only RimWorld mods are supported in Atlas.' };
    const xml = await readSmall(mod, 'About/About.xml');
    if (!xml || !/<ModMetaData(?:\s|>)/i.test(xml)) throw new Error('Missing or invalid RimWorld About/About.xml. Use Import mod for a single unfinished folder.');
    const about = parseAboutXml(xml);
    row.name = about.name || folder;
    row.packageId = about.packageId;
    if (ids.has(sourceId(root, folder))) return { ...row, status: 'imported', detail: 'Already imported from this workspace.' };
    row.detail = prefs.archived ? 'Archived mod · archive preference will be kept.' : 'Mod files, assets and metadata';
    return row;
  } catch (error) {
    return { ...row, status: 'invalid', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function scanModMixerWorkspace(source: string, destination: string): Promise<ModMixerImportRow[]> {
  const ids = await importedIds(destination);
  const entries = (await fsp.readdir(source, { withFileTypes: true })).filter(x => !x.name.startsWith('.') && !SKIP.has(x.name) && (x.isDirectory() || x.isSymbolicLink()));
  const rows: ModMixerImportRow[] = [];
  for (const entry of entries) rows.push(await inspect(source, entry.name, ids));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function copyTree(source: string, destination: string, check: () => void, copied: () => void): Promise<void> {
  check();
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('Linked file or folder found. Import stopped for this mod: ' + path.basename(source));
  if (stat.isDirectory()) {
    await fsp.mkdir(destination, { recursive: true });
    for (const entry of await fsp.readdir(source)) {
      if (SKIP.has(entry)) continue;
      await copyTree(path.join(source, entry), path.join(destination, entry), check, copied);
    }
  } else if (stat.isFile()) {
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fsp.utimes(destination, stat.atime, stat.mtime);
    copied();
  } else throw new Error('Unsupported file type: ' + path.basename(source));
}

async function mergeLegacy(legacy: string, current: string, conflicts: string): Promise<void> {
  await fsp.mkdir(current, { recursive: true });
  for (const entry of await fsp.readdir(legacy, { withFileTypes: true })) {
    const from = path.join(legacy, entry.name), to = path.join(current, entry.name);
    if (!fs.existsSync(to)) await fsp.rename(from, to);
    else if (entry.isDirectory() && (await fsp.lstat(to)).isDirectory()) await mergeLegacy(from, to, path.join(conflicts, entry.name));
    else {
      // Preserve colliding legacy bytes under Atlas metadata without replacing Atlas files.
      await fsp.mkdir(conflicts, { recursive: true });
      await fsp.rename(from, path.join(conflicts, entry.name));
    }
  }
  await fsp.rmdir(legacy);
}

class ImportCancelled extends Error {}

/** Copy into an isolated stage, then commit each complete mod with one rename. */
export async function importModMixerBatch(options: {
  source: string;
  destination: string;
  token: string;
  rows: ModMixerImportRow[];
  selected: string[];
  cancelled: () => boolean;
  progress: (state: ModMixerImportProgress) => void;
}): Promise<ModMixerImportResult> {
  const { source, destination, token, rows, selected, cancelled, progress } = options;
  const result: ModMixerImportResult = { imported: [], skipped: [], failed: [], cancelled: false };
  const selectedSet = new Set(selected);
  if (!selected.length || selectedSet.size !== selected.length || selected.some(x => !rows.some(row => row.folder === x && row.status === 'ready'))) throw new Error('Select eligible mods from a fresh import preview.');
  await resolveModMixerWorkspace(source, destination);
  const queue = rows.filter(row => selectedSet.has(row.folder));
  const stageParent = path.join(path.dirname(destination), '.atlas-imports');
  await fsp.mkdir(stageParent, { recursive: true });
  if (!await directory(stageParent)) throw new Error('The import staging folder must be a regular directory.');
  const stage = await fsp.mkdtemp(path.join(stageParent, 'batch-'));
  const ids = await importedIds(destination);
  let completed = 0, copiedFiles = 0, lastProgress = 0;
  const check = () => { if (cancelled()) throw new ImportCancelled(); };
  try {
    for (const row of queue) {
      if (cancelled()) { result.cancelled = true; break; }
      const fresh = await inspect(source, row.folder, ids);
      if (fresh.status !== 'ready') {
        result.skipped.push({ name: fresh.name, reason: fresh.detail });
        completed++;
        progress({ token, completed, total: queue.length, current: '', copiedFiles });
        continue;
      }
      const folder = randomBytes(12).toString('hex');
      const pending = path.join(stage, folder), target = path.join(destination, folder);
      progress({ token, completed, total: queue.length, current: row.name, copiedFiles });
      try {
        await copyTree(path.join(source, row.folder), pending, check, () => {
          copiedFiles++;
          if (Date.now() - lastProgress > 250) { lastProgress = Date.now(); progress({ token, completed, total: queue.length, current: row.name, copiedFiles }); }
        });
        const legacy = path.join(pending, '.modmixer'), current = path.join(pending, '.atlas');
        if (fs.existsSync(legacy)) {
          if (!fs.existsSync(current)) await fsp.rename(legacy, current);
          else await mergeLegacy(legacy, current, path.join(current, 'imported-legacy-' + randomBytes(6).toString('hex')));
        }
        await fsp.mkdir(current, { recursive: true });
        const receipt = path.join(pending, RECEIPT);
        if (fs.existsSync(receipt)) await fsp.rename(receipt, path.join(current, 'previous-import-' + randomBytes(6).toString('hex') + '.json'));
        await fsp.writeFile(receipt, JSON.stringify({ version: 1, sourceId: sourceId(source, row.folder), sourceWorkspace: source, sourceFolder: row.folder, importedAt: new Date().toISOString() }, null, 2));
        check();
        // A generated folder must never replace another project (even an empty directory).
        if (fs.existsSync(target)) throw new Error('Destination folder conflict. Retry the import.');
        await fsp.rename(pending, target);
        ids.add(sourceId(source, row.folder));
        result.imported.push({ sourceFolder: row.folder, folder, name: fresh.name });
      } catch (error) {
        if (error instanceof ImportCancelled) { result.cancelled = true; break; }
        result.failed.push({ name: row.name, reason: error instanceof Error ? error.message : String(error) });
      }
      completed++;
      progress({ token, completed, total: queue.length, current: '', copiedFiles });
    }
  } finally {
    // Only this operation's newly minted staging directory is removed.
    if (!inside(stageParent, stage) || stage === stageParent) throw new Error('Invalid staging cleanup path.');
    await fsp.rm(stage, { recursive: true, force: true });
    progress({ token, completed, total: queue.length, current: '', copiedFiles });
  }
  return result;
}
