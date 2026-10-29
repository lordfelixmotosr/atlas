import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OBSERVED_BYTES = 32 * MAX_FILE_BYTES;
const MAX_OBSERVED_FILES = 256;
const MAX_LIST_ENTRIES = 500;
const MAX_DIFF_BYTES = 128 * 1024;
// Scripts are editable source, even though helpers cannot execute them. Every
// existing and staged file still passes the bounded UTF-8 content checks below.
const textExtensions = new Set(['.xml', '.cs', '.json', '.md', '.markdown', '.txt', '.toml', '.yaml', '.yml', '.cfg', '.ini', '.config', '.props', '.targets', '.csproj', '.sln', '.slnx', '.shader', '.hlsl', '.glsl', '.fs', '.vb', '.lua', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.css', '.html', '.csv', '.tsv', '.ps1', '.psm1', '.psd1', '.py', '.pyw', '.pyi', '.sh', '.bash', '.zsh', '.bat', '.cmd']);
const privateDirectories = new Set(['.atlas', '.git', '.hg', '.svn', '.aws', '.ssh', '.azure', '.codex', '.claude', '.config', '.npm', '.gnupg', 'node_modules', 'bin', 'obj']);
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const inside = (base: string, target: string): boolean => key(target) === key(base) || key(target).startsWith(key(base) + path.sep);

export interface SubagentWorkspaceOptions {
  root: string;
  stagingRoot: string;
  taskId: string;
  ownedFiles: string[];
  /** Host-only hooks, useful for fault injection. Never expose these to workers. */
  hooks?: {
    beforeApplyFile?: (relativePath: string, index: number) => void;
    beforeRollbackFile?: (relativePath: string, index: number) => void;
  };
}

export interface SubagentWorkspaceChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  beforeHash: string | null;
  afterHash: string | null;
  bytes: number;
}

type Snapshot = { path: string; bytes: Buffer | null; hash: string | null; mode: number };
type Overlay = { path: string; file: string | null; hash: string | null; bytes: number };
type WorkspaceMetadata = { version: number; taskId: string; root: string; ownedFiles: string[]; state: string; originals: { path: string; hash: string | null; mode: number }[]; changes: Overlay[]; recoveryPaths: string[]; recoveryDirectory: string | null };

export class SubagentWorkspaceApplyError extends Error {
  readonly recoveryPaths: string[];
  constructor(detail: string, recoveryPaths: string[] = []) {
    super(detail);
    this.name = 'SubagentWorkspaceApplyError';
    this.recoveryPaths = recoveryPaths;
  }
}

/** A bounded text overlay. Only the lead receives apply(); worker tools use read/write/edit/remove/list. */
export class SubagentWorkspace {
  readonly root: string;
  readonly stagingPath: string;
  readonly taskId: string;
  readonly ownedFiles: readonly string[];
  private readonly owned = new Map<string, string>();
  private readonly observed = new Map<string, Snapshot>();
  private readonly overlay = new Map<string, Overlay>();
  private readonly hooks: NonNullable<SubagentWorkspaceOptions['hooks']>;
  private observedBytes = 0;
  private state: 'open' | 'applying' | 'applied' | 'discarded' | 'recovery-required' = 'open';
  private recoveryPaths: string[] = [];
  private recoveryDirectory: string | null = null;

  /** Reject unsupported assignments before queueing a worker or creating staging. */
  static validateAssignment(root: string, ownedFiles: string[]): string[] {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('The mod root must be an absolute path.');
    if (!Array.isArray(ownedFiles) || ownedFiles.length > 30) throw new Error('A helper may own at most 30 text files.');
    const resolvedRoot = path.resolve(root);
    SubagentWorkspace.assertPlainPath(resolvedRoot);
    if (!fs.statSync(resolvedRoot).isDirectory()) throw new Error('The mod root must be a directory.');
    const normalized = new Map<string, string>();
    for (const file of ownedFiles) {
      const relative = SubagentWorkspace.relative(file);
      SubagentWorkspace.assertTextFile(relative);
      if (normalized.has(key(relative))) throw new Error(`Duplicate owned file: ${relative}`);
      normalized.set(key(relative), relative);
      const full = path.resolve(resolvedRoot, relative);
      if (!inside(resolvedRoot, full)) throw new Error('Path escapes the mod root.');
      SubagentWorkspace.assertPlainPath(full);
      try { SubagentWorkspace.decode(SubagentWorkspace.boundedBytes(full)); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return [...normalized.values()];
  }

  /** Restored metadata is always revalidated; the optional second argument is host-internal. */
  constructor(options: SubagentWorkspaceOptions, restored?: { stagingPath: string; metadata: WorkspaceMetadata }) {
    if (!options || typeof options.root !== 'string' || !path.isAbsolute(options.root) || typeof options.stagingRoot !== 'string' || !path.isAbsolute(options.stagingRoot)) throw new Error('Root and stagingRoot must be absolute paths.');
    if (typeof options.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(options.taskId)) throw new Error('Invalid task ID.');
    if (!Array.isArray(options.ownedFiles) || options.ownedFiles.length > 30) throw new Error('A helper may own at most 30 text files.');
    this.root = path.resolve(options.root);
    this.taskId = options.taskId;
    this.hooks = options.hooks ?? {};
    SubagentWorkspace.assertPlainPath(this.root);
    if (!fs.statSync(this.root).isDirectory()) throw new Error('The mod root must be a directory.');
    const stagingRoot = path.resolve(options.stagingRoot);
    SubagentWorkspace.assertPlainPath(stagingRoot);
    if (inside(this.root, stagingRoot)) throw new Error('Staging must be outside the mod root.');
    for (const file of options.ownedFiles) {
      const relative = SubagentWorkspace.relative(file);
      SubagentWorkspace.assertTextFile(relative);
      if (this.owned.has(key(relative))) throw new Error(`Duplicate owned file: ${relative}`);
      this.owned.set(key(relative), relative);
      if (!restored) this.observe(relative);
    }
    this.ownedFiles = Object.freeze([...this.owned.values()]);
    if (!restored) this.ensureDirectory(stagingRoot);
    this.stagingPath = restored ? path.resolve(restored.stagingPath) : fs.mkdtempSync(path.join(stagingRoot, `${this.taskId}-`));
    SubagentWorkspace.assertPlainPath(this.stagingPath);
    if (inside(this.root, this.stagingPath) || inside(this.stagingPath, this.root)) throw new Error('Staging must be separate from the mod root.');
    if (restored) { this.restore(restored.metadata); return; }
    this.ensureDirectory(path.join(this.stagingPath, 'overlay'));
    this.saveMetadata();
  }

  /** Reopen a checkpoint without changing it. The host must additionally authorize its staging directory. */
  static reopen(options: { root: string; stagingPath: string }): SubagentWorkspace {
    if (!options || typeof options.stagingPath !== 'string' || !path.isAbsolute(options.stagingPath)) throw new Error('A saved helper requires an absolute stagingPath.');
    const stagingPath = path.resolve(options.stagingPath);
    const bytes = SubagentWorkspace.boundedBytes(path.join(stagingPath, 'metadata.json'));
    if (bytes.length > 256 * 1024) throw new Error('Helper metadata exceeds the 256 KB limit.');
    let metadata: WorkspaceMetadata;
    try { metadata = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid helper workspace metadata.'); }
    if (!metadata || metadata.version !== 1 || typeof metadata.root !== 'string' || !path.isAbsolute(metadata.root) || typeof options.root !== 'string' || !path.isAbsolute(options.root) || key(path.resolve(metadata.root)) !== key(path.resolve(options.root))) throw new Error('Saved helper metadata belongs to a different mod root.');
    if (!['open', 'applied'].includes(metadata.state)) throw new SubagentWorkspaceApplyError(`Saved helper state ${String(metadata.state)} requires recovery; staging is preserved at ${stagingPath}`, [stagingPath]);
    return new SubagentWorkspace({ root: options.root, stagingRoot: path.dirname(stagingPath), taskId: metadata.taskId, ownedFiles: metadata.ownedFiles }, { stagingPath, metadata });
  }

  /** Persist final read dependencies once before releasing the in-memory worker workspace. */
  checkpoint(): void { this.assertReadable(); this.saveMetadata(); }

  read(relative: string): string {
    this.assertReadable();
    const normalized = SubagentWorkspace.relative(relative);
    SubagentWorkspace.assertTextFile(normalized);
    this.rootPath(normalized);
    const staged = this.overlay.get(key(normalized));
    if (staged) {
      const bytes = this.overlayBytes(staged);
      if (bytes === null) throw new Error(`File was removed in this helper's patch: ${normalized}`);
      return SubagentWorkspace.decode(bytes);
    }
    const snapshot = this.observe(normalized);
    if (snapshot.bytes === null) throw new Error(`File does not exist: ${normalized}`);
    return SubagentWorkspace.decode(snapshot.bytes);
  }

  write(relative: string, text: string): void {
    this.assertOpen();
    const normalized = this.ownedPath(relative);
    if (typeof text !== 'string') throw new Error('File contents must be text.');
    const bytes = Buffer.from(text, 'utf8');
    SubagentWorkspace.decode(bytes);
    const file = path.join(this.stagingPath, 'overlay', digest(key(normalized)) + '.txt');
    this.atomicWrite(file, bytes);
    this.overlay.set(key(normalized), { path: normalized, file, hash: digest(bytes), bytes: bytes.length });
    this.saveMetadata();
  }

  edit(relative: string, oldText: string, newText: string): void {
    this.assertOpen();
    const normalized = this.ownedPath(relative);
    if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') throw new Error('Edit requires a nonempty exact oldText and a string newText.');
    const current = this.read(normalized);
    const start = current.indexOf(oldText);
    if (start < 0 || current.indexOf(oldText, start + 1) >= 0) throw new Error('oldText must match exactly once; include more surrounding text.');
    this.write(normalized, current.slice(0, start) + newText + current.slice(start + oldText.length));
  }

  remove(relative: string): void {
    this.assertOpen();
    const normalized = this.ownedPath(relative);
    this.overlay.set(key(normalized), { path: normalized, file: null, hash: null, bytes: 0 });
    this.saveMetadata();
  }

  /** Lists immediate children, merging new directories and files from this helper's overlay. */
  list(relative = ''): { path: string; type: 'file' | 'directory' }[] {
    this.assertReadable();
    const normalized = SubagentWorkspace.relative(relative, true);
    const directory = this.rootPath(normalized);
    const entries = new Map<string, { path: string; type: 'file' | 'directory' }>();
    let handle: fs.Dir | undefined;
    try {
      handle = fs.opendirSync(directory);
      let entry: fs.Dirent | null;
      let scanned = 0;
      while ((entry = handle.readSync()) !== null) {
        if (++scanned > 5000) throw new Error('Directory is too large; choose a narrower directory.');
        const child = normalized ? `${normalized}/${entry.name}` : entry.name;
        try {
          SubagentWorkspace.relative(child);
          this.rootPath(child);
          if (entry.isFile()) SubagentWorkspace.assertTextFile(child);
          if (!entry.isDirectory() && !entry.isFile()) continue;
        } catch { continue; }
        entries.set(key(child), { path: child, type: entry.isDirectory() ? 'directory' : 'file' });
        if (entries.size > MAX_LIST_ENTRIES) throw new Error('Listing exceeds 500 entries; choose a narrower directory.');
      }
    } catch (error) {
      if (!missing(error)) throw error;
    } finally { handle?.closeSync(); }
    const prefix = normalized ? `${normalized}/` : '';
    for (const staged of this.overlay.values()) {
      if (!key(staged.path).startsWith(key(prefix))) continue;
      const remaining = staged.path.slice(prefix.length);
      const slash = remaining.indexOf('/');
      const child = prefix + (slash < 0 ? remaining : remaining.slice(0, slash));
      if (staged.file === null) { if (slash < 0) entries.delete(key(child)); }
      else entries.set(key(child), { path: child, type: slash < 0 ? 'file' : 'directory' });
    }
    if (entries.size > MAX_LIST_ENTRIES) throw new Error('Listing exceeds 500 entries; choose a narrower directory.');
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  changes(): SubagentWorkspaceChange[] {
    this.assertReadable();
    return [...this.overlay.values()].map(staged => {
      this.overlayBytes(staged);
      const before = this.observed.get(key(staged.path))!;
      return { path: staged.path, kind: before.hash === null ? 'added' as const : staged.hash === null ? 'deleted' as const : 'modified' as const, beforeHash: before.hash, afterHash: staged.hash, bytes: staged.bytes };
    }).filter(change => change.beforeHash !== change.afterHash).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Bounded whole-file before/after hunks; deliberately not an executable patch. */
  diff(): string {
    const chunks: string[] = [];
    let used = 0;
    const append = (line: string): boolean => {
      const size = Buffer.byteLength(line);
      if (used + size > MAX_DIFF_BYTES - 100) return false;
      chunks.push(line); used += size; return true;
    };
    for (const change of this.changes()) {
      const before = this.observed.get(key(change.path))!;
      const after = this.overlayBytes(this.overlay.get(key(change.path))!);
      const oldLines = before.bytes === null ? [] : SubagentWorkspace.decode(before.bytes).split('\n');
      const newLines = after === null ? [] : SubagentWorkspace.decode(after).split('\n');
      const header = `--- ${before.hash === null ? '/dev/null' : 'a/' + change.path}\n+++ ${after === null ? '/dev/null' : 'b/' + change.path}\n@@ -${oldLines.length ? '1' : '0'},${oldLines.length} +${newLines.length ? '1' : '0'},${newLines.length} @@\n`;
      if (!append(header)) return chunks.join('') + '\n[Diff truncated; inspect individual files.]\n';
      for (const [prefix, lines] of [['-', oldLines], ['+', newLines]] as const) {
        for (const line of lines) if (!append(prefix + line + '\n')) return chunks.join('') + '\n[Diff truncated; inspect individual files.]\n';
      }
    }
    return chunks.join('');
  }

  apply(): { files: string[] } {
    this.assertOpen();
    const changes = this.changes();
    const plan = changes.map(change => ({ change, bytes: this.overlayBytes(this.overlay.get(key(change.path))!), before: this.observed.get(key(change.path))! }));
    // Validate every dependency, including unchanged owned files, before creating root directories or files.
    for (const snapshot of this.observed.values()) this.assertUnchanged(snapshot);
    if (!plan.length) { this.state = 'applied'; this.saveMetadata(); return { files: [] }; }
    const recovery = path.join(this.stagingPath, 'recovery-' + randomUUID());
    this.ensureDirectory(recovery);
    const backups = new Map<string, string>();
    for (const { before } of plan) {
      if (before.bytes !== null) {
        const backup = path.join(recovery, digest(key(before.path)) + '.original');
        this.atomicWrite(backup, before.bytes);
        backups.set(key(before.path), backup);
      }
    }
    this.atomicWrite(path.join(recovery, 'manifest.json'), Buffer.from(JSON.stringify({ root: this.root, taskId: this.taskId, files: plan.map(({ change }) => ({ ...change, backup: backups.get(key(change.path)) ?? null })) }, null, 2)));
    this.recoveryDirectory = recovery;
    const applied: typeof plan = [];
    const createdDirectories: string[] = [];
    try {
      this.state = 'applying';
      this.recoveryPaths = [recovery, ...backups.values()];
      this.saveMetadata();
      for (const [index, item] of plan.entries()) {
        this.hooks.beforeApplyFile?.(item.change.path, index);
        if (index === 0) for (const snapshot of this.observed.values()) this.assertUnchanged(snapshot);
        this.assertUnchanged(item.before);
        const target = this.rootPath(item.change.path);
        if (item.bytes === null) fs.unlinkSync(target);
        else {
          this.ensureDirectory(path.dirname(target), createdDirectories);
          this.atomicWrite(target, item.bytes, item.before.mode);
        }
        applied.push(item);
      }
      // A read dependency may have changed while the transaction was being written.
      for (const before of this.observed.values()) {
        const changed = this.overlay.get(key(before.path));
        const expected = changed ? changed.hash : before.hash;
        if (this.snapshot(before.path).hash !== expected) throw new Error(`Conflict: ${before.path} changed during apply.`);
      }
      this.state = 'applied';
      this.saveMetadata();
      return { files: changes.map(change => change.path) };
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const [index, item] of [...applied].reverse().entries()) {
        try {
          this.hooks.beforeRollbackFile?.(item.change.path, index);
          const current = this.snapshot(item.change.path);
          if (current.hash !== item.change.afterHash) throw new Error('File changed during apply; recovery must not overwrite it.');
          const target = this.rootPath(item.change.path);
          if (item.before.bytes === null) fs.unlinkSync(target);
          else {
            const backup = backups.get(key(item.change.path))!;
            SubagentWorkspace.assertPlainPath(backup);
            const bytes = SubagentWorkspace.boundedBytes(backup);
            if (digest(bytes) !== item.before.hash) throw new Error('Recovery backup changed.');
            this.atomicWrite(target, bytes, item.before.mode);
          }
        } catch (rollbackError) { rollbackErrors.push(`${item.change.path}: ${message(rollbackError)}`); }
      }
      for (const directory of createdDirectories.reverse()) {
        try { SubagentWorkspace.assertPlainPath(directory); fs.rmdirSync(directory); }
        catch (directoryError) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((directoryError as NodeJS.ErrnoException).code ?? '')) rollbackErrors.push(`${directory}: ${message(directoryError)}`); }
      }
      this.state = rollbackErrors.length ? 'recovery-required' : 'open';
      this.recoveryPaths = rollbackErrors.length ? [recovery, ...backups.values()] : [];
      try { this.saveMetadata(); } catch { /* Backups and their independent manifest remain available. */ }
      throw new SubagentWorkspaceApplyError(`Apply failed: ${message(error)}. ${rollbackErrors.length ? `Rollback needs recovery (${rollbackErrors.join('; ')}). Recovery files preserved at ${recovery}` : 'All applied files were restored; the staged patch is preserved.'}`, [...this.recoveryPaths]);
    }
  }

  cancel(): void { this.discard(); }

  discard(): void {
    if (this.state === 'discarded') return;
    if (this.state === 'recovery-required') throw new SubagentWorkspaceApplyError('Recovery files must be retained after rollback failure: ' + this.recoveryPaths.join(', '), [...this.recoveryPaths]);
    SubagentWorkspace.assertPlainPath(this.stagingPath);
    if (inside(this.root, this.stagingPath) || inside(this.stagingPath, this.root)) throw new Error('Unsafe staging cleanup path.');
    fs.rmSync(this.stagingPath, { recursive: true, force: true });
    this.observed.clear();
    this.overlay.clear();
    this.observedBytes = 0;
    this.state = 'discarded';
  }

  private static relative(value: string, allowRoot = false): string {
    if (allowRoot && value === '') return '';
    if (typeof value !== 'string' || !value || value.length > 1024 || /[\x00-\x1f\x7f:]/.test(value) || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Choose a relative mod path.');
    const parts = value.replace(/\\/g, '/').split('/');
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('Invalid relative mod path.');
      if (privateDirectories.has(lower) || lower.startsWith('.git') || lower.startsWith('.env') || /^\.?(?:credentials?|secrets?|auth|oauth|tokens?|api[-_]?keys?|client[-_]?secrets?)(?:[._-]|$)/i.test(part)) throw new Error('Private folders and credentials are unavailable to helpers.');
    }
    return parts.join('/');
  }

  private ownedPath(relative: string): string {
    const normalized = SubagentWorkspace.relative(relative);
    const owned = this.owned.get(key(normalized));
    if (!owned) throw new Error(`File is outside this helper's ownedFiles: ${normalized}`);
    this.rootPath(owned);
    return owned;
  }

  private static assertTextFile(relative: string): void {
    const extension = path.extname(relative).toLowerCase();
    if (!textExtensions.has(extension) && !['license', 'readme', 'notice'].includes(path.basename(relative).toLowerCase())) throw new Error(`Unsupported helper file type ${extension || '(no extension)'}: ${relative}. Helpers can edit source, scripts and UTF-8 text files; binary files are unavailable. Delegate binary assets to the lead.`);
  }

  private rootPath(relative: string): string {
    const full = path.resolve(this.root, relative);
    if (!inside(this.root, full)) throw new Error('Path escapes the mod root.');
    SubagentWorkspace.assertPlainPath(full);
    if (!fs.statSync(this.root).isDirectory()) throw new Error('The mod root is no longer a directory.');
    return full;
  }

  /** Check every existing component, including ancestors of root/staging, for junctions and links. */
  private static assertPlainPath(full: string): void {
    const absolute = path.resolve(full);
    const parsed = path.parse(absolute);
    const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const [index, component] of components.entries()) {
      current = path.join(current, component);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); } catch (error) { if (missing(error)) return; throw error; }
      if (stat.isSymbolicLink() || key(fs.realpathSync(current)) !== key(current)) throw new Error(`Linked or redirected paths are unavailable: ${current}`);
      if (index < components.length - 1 && !stat.isDirectory()) throw new Error(`Path parent is not a directory: ${current}`);
    }
  }

  private ensureDirectory(directory: string, created: string[] = []): void {
    SubagentWorkspace.assertPlainPath(directory);
    try { if (!fs.statSync(directory).isDirectory()) throw new Error('Expected a directory.'); return; }
    catch (error) { if (!missing(error)) throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot create a filesystem root.');
    this.ensureDirectory(parent, created);
    SubagentWorkspace.assertPlainPath(directory);
    fs.mkdirSync(directory);
    created.push(directory);
  }

  private static boundedBytes(file: string): Buffer {
    SubagentWorkspace.assertPlainPath(file);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Helpers can read only regular text files up to 1 MB.');
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new Error('Helpers can read only regular text files up to 1 MB.');
      SubagentWorkspace.assertPlainPath(file);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('File changed while opening it.');
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_FILE_BYTES) throw new Error('Text exceeds the 1 MB file limit.');
      // Snapshots retain this buffer. A view would keep the entire 1 MB read allocation
      // alive even for a tiny file and defeat the total observed-text memory limit.
      return Buffer.from(bytes.subarray(0, length));
    } finally { fs.closeSync(descriptor); }
  }

  private static decode(bytes: Buffer): string {
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Text exceeds the 1 MB file limit.');
    if (bytes.includes(0)) throw new Error('Binary text contents are unavailable to helpers.');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('Only valid UTF-8 text files are available to helpers.'); }
  }

  private snapshot(relative: string): Snapshot {
    const full = this.rootPath(relative);
    try {
      const bytes = SubagentWorkspace.boundedBytes(full);
      SubagentWorkspace.decode(bytes);
      return { path: relative, bytes, hash: digest(bytes), mode: fs.statSync(full).mode };
    } catch (error) { if (missing(error)) return { path: relative, bytes: null, hash: null, mode: 0o600 }; throw error; }
  }

  private observe(relative: string): Snapshot {
    const previous = this.observed.get(key(relative));
    if (previous) return previous;
    if (this.observed.size >= MAX_OBSERVED_FILES) throw new Error('Helper has reached the 256 observed-file limit.');
    const snapshot = this.snapshot(relative);
    if (this.observedBytes + (snapshot.bytes?.length ?? 0) > MAX_OBSERVED_BYTES) throw new Error('Helper has reached the 32 MB observed-text limit.');
    this.observed.set(key(relative), snapshot);
    this.observedBytes += snapshot.bytes?.length ?? 0;
    return snapshot;
  }

  private assertUnchanged(before: Snapshot): void {
    if (this.snapshot(before.path).hash !== before.hash) throw new Error(`Conflict: ${before.path} changed since the helper observed it.`);
  }

  private overlayBytes(staged: Overlay): Buffer | null {
    if (staged.file === null) return null;
    if (!inside(this.stagingPath, staged.file)) throw new Error('Overlay file escapes staging.');
    const bytes = SubagentWorkspace.boundedBytes(staged.file);
    SubagentWorkspace.decode(bytes);
    if (digest(bytes) !== staged.hash) throw new Error(`Staged file changed outside this helper: ${staged.path}`);
    return bytes;
  }

  private atomicWrite(target: string, bytes: Buffer, mode = 0o600): void {
    SubagentWorkspace.assertPlainPath(target);
    const temporary = path.join(path.dirname(target), `.atlas-subagent-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let renamed = false;
    try {
      descriptor = fs.openSync(temporary, 'wx', mode);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      SubagentWorkspace.assertPlainPath(target);
      SubagentWorkspace.assertPlainPath(temporary);
      fs.renameSync(temporary, target);
      renamed = true;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      // Nothing after a successful rename may throw: the caller must record that mutation for rollback.
      if (!renamed) try { SubagentWorkspace.assertPlainPath(temporary); fs.unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
    }
  }

  private assertOpen(): void { if (this.state !== 'open') throw new Error(`Helper workspace is ${this.state}.`); }
  private assertReadable(): void { if (this.state === 'discarded') throw new Error('Helper workspace was discarded.'); }
  private restore(metadata: WorkspaceMetadata): void {
    if (!metadata || metadata.version !== 1 || !['open', 'applied'].includes(metadata.state) || key(path.resolve(metadata.root)) !== key(this.root) || metadata.taskId !== this.taskId) throw new Error('Invalid saved helper metadata.');
    if (!Array.isArray(metadata.originals) || metadata.originals.length > MAX_OBSERVED_FILES || !Array.isArray(metadata.changes) || metadata.changes.length > 30 || !Array.isArray(metadata.recoveryPaths) || metadata.recoveryPaths.length > 31) throw new Error('Saved helper metadata exceeds its record limits.');
    const validHash = (hash: unknown): hash is string | null => hash === null || typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
    if (metadata.recoveryDirectory !== null) {
      if (typeof metadata.recoveryDirectory !== 'string' || key(path.dirname(metadata.recoveryDirectory)) !== key(this.stagingPath) || !/^recovery-[a-f0-9-]{36}$/.test(path.basename(metadata.recoveryDirectory))) throw new Error('Invalid recovery directory in saved helper metadata.');
      SubagentWorkspace.assertPlainPath(metadata.recoveryDirectory);
      this.recoveryDirectory = metadata.recoveryDirectory;
    }
    for (const recoveryPath of metadata.recoveryPaths) {
      if (typeof recoveryPath !== 'string' || !this.recoveryDirectory || !inside(this.recoveryDirectory, path.resolve(recoveryPath))) throw new Error('Recovery path escapes saved helper staging.');
      SubagentWorkspace.assertPlainPath(recoveryPath);
    }
    for (const staged of metadata.changes) {
      if (!staged || !validHash(staged.hash) || !Number.isInteger(staged.bytes) || staged.bytes < 0 || staged.bytes > MAX_FILE_BYTES) throw new Error('Invalid saved overlay record.');
      const relative = this.ownedPath(staged.path);
      if (relative !== staged.path || this.overlay.has(key(relative))) throw new Error('Duplicate or noncanonical saved overlay path.');
      const expectedFile = path.join(this.stagingPath, 'overlay', digest(key(relative)) + '.txt');
      if (staged.hash === null ? staged.file !== null || staged.bytes !== 0 : staged.file !== expectedFile) throw new Error('Saved overlay path escapes or does not match staging.');
      const bytes = this.overlayBytes(staged);
      if ((bytes?.length ?? 0) !== staged.bytes) throw new Error('Saved overlay byte count changed.');
      this.overlay.set(key(relative), { ...staged });
    }
    for (const original of metadata.originals) {
      if (!original || !validHash(original.hash) || !Number.isInteger(original.mode)) throw new Error('Invalid saved original file record.');
      const relative = SubagentWorkspace.relative(original.path);
      SubagentWorkspace.assertTextFile(relative);
      if (relative !== original.path || this.observed.has(key(relative))) throw new Error('Duplicate or noncanonical saved original path.');
      const current = this.snapshot(relative);
      const staged = this.overlay.get(key(relative));
      const expected = metadata.state === 'applied' && staged ? staged.hash : original.hash;
      if (current.hash !== expected) throw new Error(`Conflict: ${relative} changed since the saved helper checkpoint; staging is preserved at ${this.stagingPath}`);
      let bytes = current.bytes;
      if (metadata.state === 'applied' && staged && original.hash !== staged.hash) {
        if (original.hash === null) bytes = null;
        else {
          if (!this.recoveryDirectory) throw new Error('Applied helper is missing its recovery originals.');
          bytes = SubagentWorkspace.boundedBytes(path.join(this.recoveryDirectory, digest(key(relative)) + '.original'));
          SubagentWorkspace.decode(bytes);
          if (digest(bytes) !== original.hash) throw new Error('Saved recovery original changed.');
        }
      }
      this.observedBytes += bytes?.length ?? 0;
      if (this.observedBytes > MAX_OBSERVED_BYTES) throw new Error('Saved helper exceeds the 32 MB observed-text limit.');
      this.observed.set(key(relative), { path: relative, hash: original.hash, bytes, mode: original.mode });
    }
    for (const relative of this.ownedFiles) if (!this.observed.has(key(relative))) throw new Error('Saved helper is missing an owned-file original.');
    this.recoveryPaths = [...metadata.recoveryPaths];
    this.state = metadata.state as 'open' | 'applied';
  }
  private saveMetadata(): void {
    const bytes = Buffer.from(JSON.stringify({ version: 1, taskId: this.taskId, root: this.root, ownedFiles: this.ownedFiles, state: this.state, originals: [...this.observed.values()].map(({ path: file, hash, mode }) => ({ path: file, hash, mode })), changes: [...this.overlay.values()], recoveryPaths: this.recoveryPaths, recoveryDirectory: this.recoveryDirectory }, null, 2));
    if (bytes.length > 256 * 1024) throw new Error('Helper metadata exceeds the 256 KB limit.');
    this.atomicWrite(path.join(this.stagingPath, 'metadata.json'), bytes);
  }
}
