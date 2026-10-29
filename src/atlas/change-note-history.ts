import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {readBlob} from 'isomorphic-git';

export interface ChangeNoteHistoryRequest {path: string; hash: string; size: number}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RETURNED_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const privatePath = /(?:^|\/)(?:auth|credentials?|secrets?|tokens?)(?:[./-]|$)/i;

/** Check existing ancestors too: a local child of a junction is still linked. */
function assertUnlinked(filename: string): void {
  const absolute = path.resolve(filename), root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked snapshot paths cannot provide change-note evidence.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}

function safeRequest(request: ChangeNoteHistoryRequest): ChangeNoteHistoryRequest {
  if (!request || typeof request.path !== 'string') throw new Error('Invalid historical change-note path.');
  const filename = request.path.replaceAll('\\', '/');
  if (!filename || path.isAbsolute(filename) || filename.includes(':') || filename.includes('\0')
      || filename.split('/').some(part => !part || part === '.' || part === '..')
      || privatePath.test(filename) || !/\.(?:cs|xml|json|txt|md)$/i.test(filename)) throw new Error('Unsafe or private historical change-note path.');
  if (!/^[a-f\d]{64}$/i.test(request.hash) || !Number.isSafeInteger(request.size) || request.size < 0 || request.size > MAX_FILE_BYTES) throw new Error('Invalid historical change-note file identity.');
  return {...request, path: filename, hash: request.hash.toLowerCase()};
}

/**
 * Recover exact baseline bytes from pinned Atlas saves. A nearby date is only
 * a search preference: a full SHA-256 match is required before text is used.
 * No checkout, repository repair, pruning, index update or source write occurs.
 */
export async function recoverChangeNoteHistory(snapshotDir: string, requests: readonly ChangeNoteHistoryRequest[], baselineAt: number): Promise<Map<string, string>> {
  if (!Array.isArray(requests) || requests.length > 64 || !Number.isFinite(baselineAt)) throw new Error('The historical change-note search is too large or invalid.');
  const wanted = requests.map(safeRequest), recovered = new Map<string, string>();
  if (!wanted.length) return recovered;
  const directory = path.resolve(snapshotDir), repo = path.join(directory, 'repo.git'), index = path.join(directory, 'index.json');
  for (const filename of [directory, repo, index]) assertUnlinked(filename);
  let manifest: {version?: unknown; saves?: unknown};
  try {
    const stat = fs.lstatSync(index);
    if (!stat.isFile() || stat.size > 1024 * 1024 || !fs.lstatSync(repo).isDirectory()) return recovered;
    manifest = JSON.parse(fs.readFileSync(index, 'utf8'));
  } catch (error) { if ((error as Error).message.includes('Linked snapshot')) throw error; return recovered; }
  if (!manifest || typeof manifest !== 'object' || manifest.version !== 2 || !Array.isArray(manifest.saves) || manifest.saves.length > 5000) return recovered;
  const commits = [...new Map(manifest.saves.filter((save): save is {sha: string; timestamp: number} =>
    !!save && typeof save === 'object' && /^[a-f\d]{40}$/i.test(save.sha) && Number.isFinite(save.timestamp))
    .map(save => [save.sha.toLowerCase(), save])).values()]
    .sort((a, b) => Math.abs(a.timestamp - baselineAt) - Math.abs(b.timestamp - baselineAt) || a.timestamp - b.timestamp).slice(0, 32);
  let reads = 0, bytesRead = 0, returnedBytes = 0;
  let unsafeRead: Error | undefined;
  const deadline = Date.now() + 5000;
  function safeRepoPath(filename: string): string {
    const resolved = path.resolve(filename), relative = path.relative(repo, resolved);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { unsafeRead = new Error('A snapshot object read escaped its repository.'); throw unsafeRead; }
    try { assertUnlinked(resolved); } catch (error) { unsafeRead = error as Error; throw error; } return resolved;
  }
  // The adapter rejects accidental mutation as well as linked object files.
  const readonlyFs = {promises: {
    readFile: async (filename: string, options?: any) => {
      const resolved = safeRepoPath(filename), stat = fs.lstatSync(resolved);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || bytesRead + stat.size > MAX_READ_BYTES) throw new Error('Snapshot object read budget exceeded.');
      bytesRead += stat.size; return fs.promises.readFile(resolved, options);
    },
    readdir: async (filename: string, options?: any) => fs.promises.readdir(safeRepoPath(filename), options),
    stat: async (filename: string) => fs.promises.stat(safeRepoPath(filename)),
    lstat: async (filename: string) => fs.promises.lstat(safeRepoPath(filename)),
    readlink: async () => { throw new Error('Linked snapshot objects are not supported.'); },
    writeFile: async () => { throw new Error('Snapshot evidence is read-only.'); },
    unlink: async () => { throw new Error('Snapshot evidence is read-only.'); },
    mkdir: async () => { throw new Error('Snapshot evidence is read-only.'); },
    rmdir: async () => { throw new Error('Snapshot evidence is read-only.'); },
    symlink: async () => { throw new Error('Snapshot evidence is read-only.'); },
    chmod: async () => { throw new Error('Snapshot evidence is read-only.'); },
  }};
  const cache = {};
  for (const commit of commits) for (const request of wanted) {
    if (recovered.has(request.path)) continue;
    if (++reads > 256 || Date.now() > deadline || bytesRead >= MAX_READ_BYTES || returnedBytes >= MAX_RETURNED_BYTES) return recovered;
    try {
      const result = await readBlob({fs: readonlyFs as any, gitdir: repo, oid: commit.sha, filepath: 'mod/' + request.path, cache});
      if (unsafeRead) throw unsafeRead;
      const bytes = Buffer.from(result.blob);
      if (bytes.length !== request.size || bytes.length > MAX_FILE_BYTES || returnedBytes + bytes.length > MAX_RETURNED_BYTES
          || createHash('sha256').update(bytes).digest('hex') !== request.hash) continue;
      const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) continue;
      recovered.set(request.path, text); returnedBytes += bytes.length;
    } catch (error) {
      if (unsafeRead) throw unsafeRead;
      if (/Linked snapshot|escaped its repository/.test((error as Error).message)) throw error;
      // A removed/pruned/corrupt object is missing evidence, never a reason to
      // repair history or substitute a different revision's contents.
    }
  }
  return recovered;
}
