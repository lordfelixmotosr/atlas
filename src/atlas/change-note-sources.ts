import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {metadataReadPath, metadataWritePath} from '../agent/mod-metadata';
import type {ModInventory, ModChangeFile} from './mod-changes';
import {recoverChangeNoteHistory} from './change-note-history';

const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 6 * 1024 * 1024;
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const permitted = (file: string) => /\.(?:cs|xml|json|txt|md)$/i.test(file)
  && !/(?:^|\/)(?:auth|credentials?|secrets?|tokens?)(?:[.-]|$)/i.test(file);
const priority = (file: string) => /\.cs$/i.test(file) ? 0 : /\.xml$/i.test(file) ? 1 : 2;
type FileRecord = ModInventory['files'][string];

function checkedFile(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes(':') || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe source comparison path.');
  let filename = path.resolve(root);
  if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Linked source comparison folders are unsupported.');
  for (const component of relative.split(/[\\/]/)) {
    filename = path.join(filename, component);
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Linked source comparison files are unsupported.');
  }
  return filename;
}
async function verifiedBytes(filename: string, expected: FileRecord): Promise<Buffer | null> {
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size || stat.size > MAX_FILE) return null;
  const bytes = await fsp.readFile(filename), after = await fsp.lstat(filename);
  if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || digest(bytes) !== expected.hash) return null;
  const text = bytes.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) return null;
  return bytes;
}
const storedPath = (root: string, hash: string) => {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid source comparison hash.');
  return `mod-note-sources/${path.basename(root)}/${hash}.txt`;
};

/** Capture immutable full source only at explicit update/publication time.
 * Hash checking keeps concurrent edits out of an older upload's comparison. */
export async function captureModNoteSources(root: string, inventory: ModInventory): Promise<void> {
  let used = 0, count = 0;
  // Keep optional evidence bounded without deleting any retained content.
  let cachedBytes = 0;
  try {
    const directory=path.dirname(metadataReadPath(path.dirname(root),storedPath(root,'0'.repeat(64))));
    for (const file of await fsp.readdir(directory,{withFileTypes:true})) {
      if (file.isSymbolicLink()) return;
      if (file.isFile()) cachedBytes+=(await fsp.stat(path.join(directory,file.name))).size;
      if (cachedBytes>=32*1024*1024) return;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') return; }
  for (const file of Object.keys(inventory.files).filter(permitted).sort((a,b) => priority(a)-priority(b)||a.localeCompare(b))) {
    const expected = inventory.files[file];
    if (expected.size > MAX_FILE || used + expected.size > MAX_TOTAL || count >= 256) continue;
    try {
      const bytes = await verifiedBytes(checkedFile(root, file), expected); if (!bytes) continue;
      used += bytes.length; count++;
      const relative = storedPath(root, expected.hash), target = metadataWritePath(path.dirname(root), relative);
      if (fs.existsSync(target)) continue;
      if (cachedBytes+bytes.length>32*1024*1024) continue;
      await fsp.mkdir(path.dirname(target), {recursive: true});
      metadataWritePath(path.dirname(root), relative);
      const temporary = target + '.' + randomUUID() + '.tmp';
      try { await fsp.writeFile(temporary, bytes, {flag:'wx'}); metadataWritePath(path.dirname(root), relative); await fsp.rename(temporary, target); cachedBytes+=bytes.length; }
      finally { await fsp.rm(temporary, {force:true}); }
    } catch { /* Optional text capture must not invalidate a successful upload's hash baseline. */ }
  }
}

/** The library's small preview cache must not limit changed-file evidence.
 * Historical content is used only after its full hash matches the baseline. */
export async function hydrateModNoteSources(root: string, previous: ModInventory, current: ModInventory, rows: ModChangeFile[], baselineAt: number, snapshotDir?: string) {
  const before = {...previous,files:{...previous.files}}, after = {...current,files:{...current.files}}, missing: {path:string;hash:string;size:number}[] = [];
  const warnings: string[] = []; let currentBytes=0, oldBytes=0, count=0;
  for (const row of [...rows].filter(row=>permitted(row.path)).sort((a,b)=>priority(a.path)-priority(b.path)||a.path.localeCompare(b.path))) {
    if (++count > 128) break;
    const now = current.files[row.path], old = previous.files[row.path];
    if (now && now.size <= MAX_FILE && currentBytes + now.size <= MAX_TOTAL) {
      const bytes=await verifiedBytes(checkedFile(root,row.path),now);
      if (!bytes) throw new Error('The mod changed during comparison or contains unreadable source. Refresh before generating update notes.');
      after.files[row.path]={...now,preview:bytes.toString('utf8'),previewTruncated:false}; currentBytes+=bytes.length;
    }
    if (old && (old.preview === undefined || old.previewTruncated) && old.size <= MAX_FILE && oldBytes + old.size <= MAX_TOTAL) {
      let bytes: Buffer|null=null;
      try { bytes=await verifiedBytes(metadataReadPath(path.dirname(root),storedPath(root,old.hash)),old); } catch { /* Missing capture: inspect retained history next. */ }
      if (bytes) {before.files[row.path]={...old,preview:bytes.toString('utf8'),previewTruncated:false};oldBytes+=bytes.length;}
      else missing.push({path:row.path,hash:old.hash,size:old.size});
    }
  }
  if (snapshotDir && missing.length) {
    try {
      const recovered=await recoverChangeNoteHistory(snapshotDir,missing,baselineAt);
      for (const [file,text] of recovered) {
        const old=previous.files[file]; if (!old || oldBytes+old.size>MAX_TOTAL) continue;
        before.files[file]={...old,preview:text,previewTruncated:false}; oldBytes+=old.size;
      }
    } catch { warnings.push('Some saved history could not be read safely. Only available, hash-verified earlier source was used.'); }
  }
  return {previous:before,current:after,warnings};
}
