import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {assertPreviewPathSafe, prepareWorkshopPreviewBuffer, writeWorkshopPreview, preserveWorkshopPreviewSelection} from './workshop-preview.js';
import {emitModChanged} from '../mod-events.js';

const PREVIEW_NAMES = ['Preview.png', 'WorkshopPreview.gif'] as const;
const MAX_BYTES = 20 * 1024 * 1024;
const hash = (bytes: Buffer | null) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const key = (filename: string) => path.resolve(filename).toLowerCase();
const queues = new Map<string, Promise<unknown>>();
type Original = {name: typeof PREVIEW_NAMES[number]; bytes: Buffer | null; hash: string | null; atimeMs?: number; mtimeMs?: number};
type CandidateRecord = {version: 1; id: string; modRoot: string; createdAt: number; state: 'pending' | 'applied' | 'discarded'; source: 'render' | 'protected-write'; pngHash: string; gifHash: string | null; originals: {name: string; hash: string | null}[]; selected?: string | null; warning?: string};
export interface PreviewCandidate {id: string; dataUrl: string; createdAt: number; warning?: string}

/** Shared with explicit Browse/Apply, so restoring an agent write cannot undo a user action. */
export async function serializePreviewMutation<T>(modRoot: string, action: () => Promise<T>): Promise<T> {
  const id = key(modRoot), previous = queues.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action); queues.set(id, next);
  try { return await next; } finally { if (queues.get(id) === next) queues.delete(id); }
}
function rootSafe(modRoot: string): string {
  const root = assertPreviewPathSafe(modRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('The mod folder is missing.');
  return root;
}
function privateRoot(modRoot: string, area = 'preview-candidates'): string {
  const root = rootSafe(modRoot), identity = createHash('sha256').update(key(root)).digest('hex').slice(0, 24);
  return assertPreviewPathSafe(path.join(path.dirname(root), '.atlas', area, identity));
}
function regular(filename: string, maximum = MAX_BYTES): Buffer | null {
  assertPreviewPathSafe(filename);
  let stat: fs.Stats; try { stat = fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > maximum) throw new Error(`Preview protection requires a regular file under ${maximum} bytes: ${filename}`);
  return fs.readFileSync(filename);
}
function originals(modRoot: string): Original[] {
  return PREVIEW_NAMES.map(name => {
    const filename = path.join(modRoot, 'About', name), bytes = regular(filename);
    const times = bytes === null ? null : fs.statSync(filename);
    return {name, bytes, hash: hash(bytes), ...(times ? {atimeMs: times.atimeMs, mtimeMs: times.mtimeMs} : {})};
  });
}
function selection(files: Original[]): string | null {
  const png = files.find(file => file.name === 'Preview.png')!, gif = files.find(file => file.name === 'WorkshopPreview.gif')!;
  return gif.bytes && (!png.bytes || gif.mtimeMs! >= png.mtimeMs!) ? gif.name : png.bytes ? png.name : null;
}
type RetainedPreview = {directory: string; files: {name: string; size: number | null; mtimeMs?: number; ino?: number}[]};
async function retainUnexpectedPreviews(modRoot: string): Promise<RetainedPreview> {
  const directory = path.join(privateRoot(modRoot, 'preview-replacements'), randomUUID()); await ensure(directory);
  const files: RetainedPreview['files'] = [];
  try {
    for (const name of PREVIEW_NAMES) {
      const filename = assertPreviewPathSafe(path.join(modRoot, 'About', name));
      let stat: fs.Stats; try { stat = await fsp.lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {files.push({name, size: null}); continue;} throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`The changed preview is not a regular file: ${filename}`);
      // Copy without loading large, invalid images into memory. The copy must
      // succeed before restoration may replace any unexpected artwork.
      await fsp.copyFile(filename, assertPreviewPathSafe(path.join(directory, name)), fs.constants.COPYFILE_EXCL);
      const current = await fsp.lstat(assertPreviewPathSafe(filename));
      if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ino !== stat.ino) throw new Error('A preview changed again while its recovery copy was being saved.');
      files.push({name, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino});
    }
    await atomic(path.join(directory, 'receipt.json'), Buffer.from(JSON.stringify({modRoot, createdAt: Date.now(), files}, null, 2)));
    return {directory, files};
  } catch (error) { throw new Error(`${String(error)} Partial replacement copies, if any, are retained at ${directory}.`); }
}
function assertRetainedStillCurrent(modRoot: string, retained: RetainedPreview): void {
  for (const file of retained.files) {
    const filename = assertPreviewPathSafe(path.join(modRoot, 'About', file.name));
    let stat: fs.Stats | null = null; try { stat = fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (file.size === null ? stat !== null : !stat || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs || stat.ino !== file.ino) throw new Error(`A preview changed again before restoration: ${filename}. It was left in place.`);
  }
}
async function atomic(filename: string, bytes: Buffer): Promise<void> {
  assertPreviewPathSafe(filename); const temporary = filename + '.' + randomUUID() + '.tmp';
  try { await fsp.writeFile(temporary, bytes, {flag: 'wx'}); assertPreviewPathSafe(filename); await fsp.rename(temporary, filename); }
  finally { try { assertPreviewPathSafe(temporary); await fsp.unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
async function ensure(directory: string): Promise<void> { assertPreviewPathSafe(directory); await fsp.mkdir(directory, {recursive: true}); assertPreviewPathSafe(directory); }
function candidatePath(modRoot: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid preview candidate ID.');
  return assertPreviewPathSafe(path.join(privateRoot(modRoot), id));
}
function readRecord(modRoot: string, id: string): CandidateRecord {
  const bytes = regular(path.join(candidatePath(modRoot, id), 'candidate.json'), 64 * 1024);
  if (!bytes) throw new Error('This preview proposal is no longer available.');
  const record = JSON.parse(bytes.toString('utf8')) as CandidateRecord;
  if (record.version !== 1 || record.id !== id || key(record.modRoot) !== key(modRoot) || !['pending', 'applied', 'discarded'].includes(record.state)
      || !Array.isArray(record.originals) || record.originals.length !== 2 || PREVIEW_NAMES.some(name => !record.originals.some(file => file.name === name))) throw new Error('Invalid preview proposal metadata.');
  return record;
}
async function saveCandidate(modRoot: string, png: Buffer, gif: Buffer | undefined, before: Original[], source: CandidateRecord['source'], warning?: string, id = randomUUID()): Promise<CandidateRecord> {
  const root = privateRoot(modRoot), directory = candidatePath(modRoot, id); await ensure(directory);
  await atomic(path.join(directory, 'Preview.png'), png);
  if (gif) await atomic(path.join(directory, 'WorkshopPreview.gif'), gif);
  const record: CandidateRecord = {version: 1, id, modRoot: path.resolve(modRoot), createdAt: Date.now(), state: 'pending', source, pngHash: hash(png)!, gifHash: hash(gif ?? null), originals: before.map(({name, hash}) => ({name, hash})), selected: selection(before), ...(warning ? {warning} : {})};
  await atomic(path.join(directory, 'candidate.json'), Buffer.from(JSON.stringify(record, null, 2)));
  await atomic(path.join(root, 'pending.json'), Buffer.from(JSON.stringify({id})));
  emitModChanged(path.basename(modRoot)); return record;
}

/** The renderer only receives a private candidate path, never the installed preview path. */
export async function renderPreviewCandidate<T>(modRoot: string, render: (outputPath: string) => Promise<T>): Promise<{result: T; outPath: string; candidateId: string}> {
  return serializePreviewMutation(modRoot, async () => {
    const root = rootSafe(modRoot), before = originals(root), id = randomUUID(), directory = candidatePath(root, id);
    await ensure(directory); const outputPath = path.join(directory, 'rendered.png');
    const result = await render(outputPath), bytes = regular(outputPath);
    if (!bytes) throw new Error('The renderer did not create a preview proposal.');
    const prepared = await prepareWorkshopPreviewBuffer(bytes);
    const record = await saveCandidate(root, prepared.png, prepared.gif, before, 'render', undefined, id);
    return {result, outPath: path.join(directory, 'Preview.png'), candidateId: record.id};
  });
}

export function getPreviewCandidate(modRoot: string): PreviewCandidate | null {
  const bytes = regular(path.join(privateRoot(modRoot), 'pending.json'), 1024); if (!bytes) return null;
  const {id} = JSON.parse(bytes.toString('utf8')), record = readRecord(modRoot, id); if (record.state !== 'pending') return null;
  const directory = candidatePath(modRoot, id), gif = record.gifHash ? regular(path.join(directory, 'WorkshopPreview.gif')) : null, png = regular(path.join(directory, 'Preview.png'));
  if (!png || hash(png) !== record.pngHash || hash(gif) !== record.gifHash) throw new Error('The preview proposal changed on disk. Generate a new proposal.');
  return {id, dataUrl: `data:image/${gif ? 'gif' : 'png'};base64,${(gif ?? png).toString('base64')}`, createdAt: record.createdAt, ...(record.warning ? {warning: record.warning} : {})};
}
export async function applyPreviewCandidate(modRoot: string, id: string): Promise<void> {
  return serializePreviewMutation(modRoot, async () => {
    const record = readRecord(modRoot, id); if (record.state !== 'pending') throw new Error('This preview proposal is no longer pending.');
    const selected = getPreviewCandidate(modRoot); if (selected?.id !== id) throw new Error('A newer preview proposal is available. Review it first.');
    const before = originals(modRoot);
    if (before.some(file => record.originals.find(original => original.name === file.name)?.hash !== file.hash) || record.selected !== undefined && record.selected !== selection(before)) throw new Error('Your existing preview changed since this proposal was made. It has been preserved; generate a new proposal before replacing it.');
    const directory = candidatePath(modRoot, id), source = regular(path.join(directory, record.gifHash ? 'WorkshopPreview.gif' : 'Preview.png'))!;
    const prepared = await prepareWorkshopPreviewBuffer(source);
    await writeWorkshopPreview(modRoot, prepared, privateRoot(modRoot, 'preview-backups'));
    record.state = 'applied'; await atomic(path.join(directory, 'candidate.json'), Buffer.from(JSON.stringify(record, null, 2)));
    emitModChanged(path.basename(modRoot));
  });
}
export async function discardPreviewCandidate(modRoot: string, id: string): Promise<void> {
  return serializePreviewMutation(modRoot, async () => {
    const record = readRecord(modRoot, id); if (record.state !== 'pending') throw new Error('This preview proposal is no longer pending.');
    record.state = 'discarded'; await atomic(path.join(candidatePath(modRoot, id), 'candidate.json'), Buffer.from(JSON.stringify(record, null, 2)));
    emitModChanged(path.basename(modRoot));
  });
}

function protectedOutput(modRoot: string, args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  return ['path', 'filePath', 'outPath', 'outputPath', 'destination', 'dest'].some(name => {
    const value = (args as Record<string, unknown>)[name]; if (typeof value !== 'string') return false;
    const target = key(path.resolve(modRoot, value));
    return PREVIEW_NAMES.some(filename => target === key(path.join(modRoot, 'About', filename)));
  });
}
const UNGUARDED = new Set(['read', 'ls', 'find', 'grep', 'search_defs', 'search_source', 'read_symbol', 'read_csharp_symbol', 'read_lore', 'monitor_get_error', 'monitor_poll', 'helper_status', 'wait_helpers', 'render_preview']);
/** Guard normal AI file tools and shell fallbacks. Explicit UI preview actions use the same lock. */
export function withPreviewProtection<T extends AgentTool<any>>(modRoot: string, inner: T): T {
  if (UNGUARDED.has(inner.name)) return inner;
  const wrapped: AgentTool<any> = {...inner, execute: async (id, args, signal, onUpdate) => {
    signal?.throwIfAborted();
    if (protectedOutput(modRoot, args)) throw new Error('The existing Workshop preview is protected. Use render_preview to prepare a proposal; the user applies it from Publish → Preview image.');
    return serializePreviewMutation(modRoot, async () => {
      signal?.throwIfAborted();
      const before = originals(rootSafe(modRoot));
      // A durable original exists before arbitrary code executes, even if Atlas stops unexpectedly.
      // Reuse a content-addressed backup for unchanged previews instead of
      // duplicating the same artwork after every tool call.
      const backupId = createHash('sha256').update(JSON.stringify(before.map(file => [file.name, file.hash]))).digest('hex');
      const backup = path.join(privateRoot(modRoot, 'preview-guard-backups'), backupId);
      if (before.some(file => file.bytes)) { await ensure(backup); for (const file of before) if (file.bytes && hash(regular(path.join(backup, file.name))) !== file.hash) await atomic(path.join(backup, file.name), file.bytes); }
      let value: Awaited<ReturnType<AgentTool<any>['execute']>> | undefined, failure: unknown;
      try { value = await inner.execute(id, args, signal, onUpdate); } catch (error) { failure = error; }
      let changed = false, contentChanged = false, after: Original[] | undefined, candidateSaved = false, retained: RetainedPreview | undefined, candidateError: unknown, restoreError: unknown;
      try {
        after = originals(modRoot); contentChanged = after.some(file => file.hash !== before.find(original => original.name === file.name)!.hash);
        changed = contentChanged || after.some(file => file.mtimeMs !== before.find(original => original.name === file.name)!.mtimeMs);
      } catch (error) { changed = contentChanged = true; candidateError = error; }
      if (contentChanged) {
        try { retained = await retainUnexpectedPreviews(modRoot); }
        catch (error) { throw new Error(`The action changed a protected preview, but safe restoration failed because its replacement could not be retained. Current changed files were left in place. ${String(error)} Original preview backups are retained at ${backup}.${failure ? ` Original action error: ${String(failure)}` : ''}`); }
        const sourceName = after?.find(file => file.name === 'WorkshopPreview.gif' && file.bytes && file.hash !== before.find(original => original.name === file.name)!.hash)?.name ?? 'Preview.png';
        try {
          const source = after ? regular(path.join(retained.directory, sourceName)) : null;
          if (source) { const prepared = await prepareWorkshopPreviewBuffer(source); await saveCandidate(modRoot, prepared.png, prepared.gif, before, 'protected-write', 'The agent attempted to change the preview during another task. Your original was restored; review this proposal before using it.'); candidateSaved = true; }
        } catch (error) { candidateError = error; }
      }
      if (changed) {
        try {
          if (retained) assertRetainedStillCurrent(modRoot, retained);
          const about = assertPreviewPathSafe(path.join(modRoot, 'About')); await ensure(about);
          for (const file of before) {
            const filename = assertPreviewPathSafe(path.join(about, file.name));
            if (file.bytes) { if (contentChanged) await atomic(filename, file.bytes); await fsp.utimes(filename, file.atimeMs! / 1000, file.mtimeMs! / 1000); }
            else { try { await fsp.unlink(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
          }
          await preserveWorkshopPreviewSelection(modRoot, selection(before));
          emitModChanged(path.basename(modRoot));
        } catch (error) { restoreError = error; }
        if (restoreError) throw new Error(`The action changed a protected preview and restoration failed: ${String(restoreError)}. Original preview backups are retained at ${backup}.${retained ? ` Replacement copies are retained at ${retained.directory}.` : ''}${failure ? ` Original action error: ${String(failure)}` : ''}`);
        throw new Error(`The action attempted to change the protected Workshop preview. The original was restored.${candidateError ? ` The replacement could not become a proposal: ${String(candidateError)}` : candidateSaved ? ' Review the replacement proposal under Publish → Preview image.' : ' Preview timestamps and selection were preserved; no replacement proposal was created.'}${retained ? ` Raw replacement files are retained at ${retained.directory}.` : ''}${failure ? ` Original action error: ${String(failure)}` : ''}`);
      }
      if (failure) throw failure;
      return value!;
    });
  }};
  return wrapped as T;
}
