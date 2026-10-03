import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { metadataReadPath, metadataWritePath } from '../agent/mod-metadata';

type DefinitionRecord = { hash: string; type: string; label: string; description?: string; kind?: string; fields?: Record<string, string> };
type FileRecord = { hash: string; size: number; modifiedAt: number; preview?: string; previewTruncated?: boolean; defs?: Record<string, DefinitionRecord> };
export type ModInventory = { signature: string; modifiedAt: number; files: Record<string, FileRecord> };
type Baseline = { at: number; kind: 'published' | 'updated' | 'tracking'; note: string; inventory: ModInventory };
type ContentDescription = { text: string; at: number; origin: 'ai' | 'manual'; model?: string };
type State = { version: 1; first: Baseline; published?: Baseline; updated?: Baseline; observed: { signature: string; at: number }; descriptions?: Record<string, ContentDescription> };
export interface ModChangeFile { path: string; action: 'added' | 'edited' | 'removed'; category: string; description: string }
export interface ModChangeReport {
  status: 'modified' | 'clean' | 'tracking' | 'unavailable';
  label: string; description: string; baselineAt: number | null; baselineKind: string | null;
  lastModifiedAt: number; lastPublishedAt: number | null; lastUpdatedAt: number | null;
  note: string; count: number; files: ModChangeFile[];
  features?: { added: string[]; changed: string[]; removed: string[] };
  descriptionKey?: string; featureDescription?: string; descriptionOrigin?: string; descriptionAt?: number;
}
export type ModChangeSummary = Omit<ModChangeReport, 'files'>;
const skipped = new Set(['.git', '.atlas', '.modmixer', '.vs', '.DS_Store', 'bin', 'obj', 'node_modules']);
const cache = new Map<string, { stamp: string; value: FileRecord }>();
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const words = (value: string) => value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
const plain = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const previewAllowed = (file: string) => /\.(?:cs|xml|json|txt|md)$/i.test(file) && !/(?:^|\/)(?:auth|credentials?|secrets?|tokens?)(?:[.-]|$)/i.test(file);

function definitions(text: string): FileRecord['defs'] {
  const result: NonNullable<FileRecord['defs']> = Object.create(null);
  const expression = /<([A-Za-z_][\w.]*)\b[^>]*>[\s\S]*?<\/\1>/g;
  // Inspect direct Def children, avoiding a root <Defs> match swallowing the file.
  text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?Defs\b[^>]*>/gi, '');
  for (const match of text.matchAll(expression)) {
    const name = match[0].match(/<defName>\s*([^<]+)\s*<\/defName>/i)?.[1]?.trim();
    if (!name) continue;
    const label = match[0].match(/<label>\s*([^<]+)\s*<\/label>/i)?.[1]?.trim() ?? '';
    const fields: Record<string, string> = Object.create(null);
    for (const field of match[0].matchAll(/<([A-Za-z_][\w.]*)>\s*([^<>]{1,500})\s*<\/\1>/g)) {
      if (['defName','label','description','li'].includes(field[1]) || Object.keys(fields).length >= 40) continue;
      fields[field[1]] = plain(field[2]).slice(0, 160);
    }
    const description = plain(match[0].match(/<description>\s*([\s\S]*?)\s*<\/description>/i)?.[1] ?? '').slice(0, 320);
    const kind = match[1] === 'ThingDef' ? /<apparel\b/.test(match[0]) ? 'apparel' : /<category>\s*Building\s*<\/category>/.test(match[0]) ? 'building' : /<category>\s*Pawn\s*<\/category>/.test(match[0]) ? 'creature' : /<weaponTags\b|<verbs\b/.test(match[0]) ? 'weapon / equipment' : 'item / object' : ({RecipeDef:'recipe',GeneDef:'gene',HediffDef:'health condition',PawnKindDef:'pawn type',FactionDef:'faction',AbilityDef:'ability',ResearchProjectDef:'research',ThoughtDef:'thought',TraitDef:'trait',JobDef:'job'} as Record<string,string>)[match[1]] ?? words(match[1].replace(/Def$/, '')).toLowerCase();
    result[name] = { hash: hash(match[0]), type: match[1], label, description, kind, fields };
  }
  return result;
}

/** Hash actual content, caching only unchanged size/mtime/ctime identities. */
export async function collectModInventory(root: string): Promise<ModInventory> {
  if ((await fsp.lstat(root)).isSymbolicLink()) throw new Error('Linked project folders cannot be compared.');
  const files: Record<string, FileRecord> = Object.create(null);
  let modifiedAt = 0, count = 0, previewBytes = 0;
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
        if (previewAllowed(relative) && stat.size <= 2*1024*1024) { const handle=await fsp.open(full,'r');try{const buffer=Buffer.alloc(Math.min(stat.size,32768)),read=await handle.read(buffer,0,buffer.length,0);record.preview=buffer.subarray(0,read.bytesRead).toString('utf8');record.previewTruncated=stat.size>read.bytesRead;}finally{await handle.close();} }
        const after = await fsp.lstat(full);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('File changed during comparison. Refresh when work finishes: ' + relative);
        if (cache.size > 30000) cache.clear();
        cache.set(full, { stamp, value: record });
      }
      if (record.preview) { previewBytes += Buffer.byteLength(record.preview); if (previewBytes > 512 * 1024) { const {preview: _preview, ...bounded} = record; record = bounded; } }
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
export function describeModFeatures(previous: ModInventory, current: ModInventory, rows = compareModInventories(previous, current)) {
  const features: {added: string[]; changed: string[]; removed: string[]} = {added:[],changed:[],removed:[]};
  const assets = new Map<string, number>();
  for (const row of rows) {
    const before = previous.files[row.path], after = current.files[row.path], oldDefs = before?.defs ?? {}, newDefs = after?.defs ?? {};
    let definitionChanges = 0;
    for (const name of new Set([...Object.keys(oldDefs), ...Object.keys(newDefs)])) {
      const oldDef = Object.hasOwn(oldDefs,name)?oldDefs[name]:undefined, newDef = Object.hasOwn(newDefs,name)?newDefs[name]:undefined; if (oldDef?.hash === newDef?.hash) continue; definitionChanges++;
      const def = newDef ?? oldDef, action = !oldDef ? 'added' : !newDef ? 'removed' : 'changed';
      if (!def) continue;
      let text = `${def.label || words(name)} (${def.kind || words(def.type.replace(/Def$/, '')).toLowerCase()})`;
      if (action === 'added' && def.description) text += ': ' + def.description;
      if (oldDef && newDef) {
        const changedFields: string[] = [];
        if (oldDef.label !== newDef.label) changedFields.push(`name: ${oldDef.label || name} → ${newDef.label || name}`);
        if (oldDef.fields && newDef.fields) for (const field of new Set([...Object.keys(oldDef.fields), ...Object.keys(newDef.fields)])) {
          if (oldDef.fields[field] === newDef.fields[field]) continue;
          const friendly = ({ArmorRating_Sharp:'sharp protection',ArmorRating_Blunt:'blunt protection',ArmorRating_Heat:'heat protection',damageAmountBase:'damage',Mass:'weight',MarketValue:'value',workToMake:'crafting work',baseHealth:'health',cooldownTime:'cooldown'} as Record<string,string>)[field] ?? words(field).toLowerCase();
          changedFields.push(`${friendly}: ${oldDef.fields[field] ?? 'not set'} → ${newDef.fields[field] ?? 'not set'}`);
        }
        if (changedFields.length) text += ' — ' + changedFields.slice(0, 4).join('; ') + (changedFields.length > 4 ? `; ${changedFields.length - 4} more properties` : '');
      }
      features[action].push(text);
    }
    if (definitionChanges) continue;
    const action = row.action === 'edited' ? 'changed' : row.action;
    if (['textures / images','audio'].includes(row.category)) {
      const key = `${action}\0${row.category}\0${path.posix.dirname(row.path)}`; assets.set(key, (assets.get(key) ?? 0) + 1); continue;
    }
    const file = words(path.basename(row.path, path.extname(row.path)));
    const text = row.category === 'C# source' ? `${file} mod code` : row.category === 'patch XML' ? `${file} compatibility / game patches` : row.category === 'translations' ? `${row.path.split('/')[1] || 'Mod'} translations` : row.category === 'mod metadata' ? 'Mod information and publication metadata' : row.category === 'compiled assemblies' ? `${file} compiled mod assembly` : `${file} (${row.category})`;
    features[action].push(text);
  }
  for (const [key, count] of assets) { const [action, category, directory] = key.split('\0'); features[action as keyof typeof features].push(`${count} ${category === 'audio' ? 'audio files' : 'artwork / texture files'} in ${directory}`); }
  for (const key of ['added','changed','removed'] as const) { const unique = [...new Set(features[key])]; features[key] = unique.slice(0, 16); if(unique.length > 16) features[key].push(`Plus ${unique.length - 16} more changes; see file details.`); }
  return features;
}
function chooseBaseline(state: State, comparison: 'latest'|'published'|'updated') { return comparison === 'latest' ? [state.published,state.updated].filter((x):x is Baseline=>!!x).sort((a,b)=>b.at-a.at)[0] ?? state.first : state[comparison]; }
const descriptionKey = (baseline: Baseline, current: ModInventory) => hash(baseline.kind+'\0'+baseline.at+'\0'+baseline.inventory.signature+'\0'+current.signature);
export function prepareModDescription(root: string, comparison: 'latest'|'published'|'updated', expectedKey: string) {
  return exclusive(root, async()=>{
    const state=await readState(root),current=await collectModInventory(root),baseline=state&&chooseBaseline(state,comparison);
    if(!baseline || descriptionKey(baseline,current)!==expectedKey)throw new Error('The mod or comparison changed. Refresh before describing it.');
    const rows=compareModInventories(baseline.inventory,current); if(!rows.length)throw new Error('There are no changes to describe.');
    const evidence=[];let budget=0,omitted=0;
    for(const row of rows){const before=baseline.inventory.files[row.path],after=current.files[row.path];const entry={...row,before:before?.preview??null,after:after?.preview??null,earlierTextAvailable:!!before?.preview,beforeTextTruncated:!!before?.previewTruncated,afterTextTruncated:!!after?.previewTruncated};const size=JSON.stringify(entry).length;if(budget+size>130000){omitted++;continue};budget+=size;evidence.push(entry);}
    return JSON.stringify({comparison:baseline.kind,baselineAt:baseline.at,features:describeModFeatures(baseline.inventory,current,rows),totalChangedFiles:rows.length,omittedFiles:omitted,evidence});
  });
}
export function saveModDescription(root: string, comparison: 'latest'|'published'|'updated', expectedKey: string, text: string, origin: 'ai'|'manual'='manual', model?: string) {
  return exclusive(root,async()=>{
    if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('Use a description of 1–12,000 characters.');
    const state=await readState(root),current=await collectModInventory(root),baseline=state&&chooseBaseline(state,comparison);
    if(!state||!baseline||descriptionKey(baseline,current)!==expectedKey)throw new Error('The mod or comparison changed. Refresh before saving this description.');
    state.descriptions??={};state.descriptions[expectedKey]={text:text.trim(),at:Date.now(),origin,...(model?{model}: {})};
    state.descriptions=Object.fromEntries(Object.entries(state.descriptions).sort((a,b)=>b[1].at-a[1].at).slice(0,8));await saveState(root,state);
  });
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
      const baseline = chooseBaseline(state, comparison);
      const common = { lastModifiedAt: state.observed.at, lastPublishedAt: state.published?.at ?? lastPublishedAt, lastUpdatedAt: state.updated?.at ?? null, note: baseline?.note ?? '' };
      if (baseline?.kind === 'published' && lastPublishedAt && lastPublishedAt > baseline.at) return { ...common, lastPublishedAt, status: 'unavailable', label: 'Published comparison missing', description: 'The latest publication did not save a file comparison. An older publication snapshot cannot describe the latest upload.', baselineAt: null, baselineKind: null, count: 0, files: [] };
      if (!baseline) return { ...common, status: 'unavailable', label: 'No comparison saved', description: `No file snapshot exists for the last ${comparison === 'published' ? 'publication' : 'marked update'}. Tracking started ${new Date(state.first.at).toLocaleString()}.`, baselineAt: null, baselineKind: null, count: 0, files: [] };
      const files = compareModInventories(baseline.inventory, current), tracking = baseline.kind === 'tracking';
      const key=descriptionKey(baseline,current),saved=state.descriptions?.[key];
      return { ...common, features:describeModFeatures(baseline.inventory,current,files),descriptionKey:key,featureDescription:saved?.text??'',descriptionOrigin:saved?.origin,descriptionAt:saved?.at,status: files.length ? 'modified' : tracking ? 'tracking' : 'clean', label: files.length ? baseline.kind === 'published' ? 'Unpublished changes' : baseline.kind === 'updated' ? 'Changes since update' : 'Changes since tracking started' : tracking ? 'Tracking started' : 'No changes since ' + (baseline.kind === 'published' ? 'publication' : 'update'), description: files.length ? description(files) : tracking ? 'No earlier file snapshot exists. Future changes will be compared from this point.' : 'Mod content matches the saved comparison.', baselineAt: baseline.at, baselineKind: baseline.kind, count: files.length, files };
    } catch (error) {
      return { status: 'unavailable', label: 'Change comparison unavailable', description: error instanceof Error ? error.message : String(error), baselineAt: null, baselineKind: null, lastModifiedAt: 0, lastPublishedAt, lastUpdatedAt: null, note: '', count: 0, files: [] };
    }
  });
}
export async function readModChangeSummary(root: string, lastPublishedAt: number | null): Promise<ModChangeSummary> {
  const { files: _files, ...summary } = await readModChanges(root, lastPublishedAt); return summary;
}
