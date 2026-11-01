import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveIlspycmd, runIlspycmd } from './ilspycmd.js';
import type { IndexProgressListener } from './progress.js';

/**
 * Assemblies we always try to decompile when present in Managed/. ilspycmd
 * is happy to be pointed at a missing path with a non-zero exit; we filter
 * to existing files first to keep progress accurate.
 */
const PRIMARY_ASSEMBLIES = [
  'Assembly-CSharp.dll',
  'Assembly-CSharp-firstpass.dll',
  'UnityStubs.dll',
  'Waylith.UnityCompat.dll',
  'Waylith.dll',
];

/** DLC assemblies — present per-DLC the user owns. */
const DLC_ASSEMBLIES = [
  'Royalty.dll',
  'Ideology.dll',
  'Biotech.dll',
  'Anomaly.dll',
  'Odyssey.dll',
];

export interface DecompileInput {
  managedDir: string;
  /** $MM/index/Source/. Decompile output is written under <DllStem>/. */
  sourceRoot: string;
}

export class IlspycmdMissingError extends Error {
  constructor() {
    super(
      "ilspycmd is not available. Build Atlas with the vendored binary " +
        'in resources/ilspycmd/<platform>-<arch>/, or install one manually with ' +
        '`dotnet tool install -g ilspycmd`.',
    );
    this.name = 'IlspycmdMissingError';
  }
}

/**
 * Reports live progress while ilspycmd works on one assembly, which has no
 * known total: generated C# file count and elapsed time, every 2 seconds.
 */
function startDecompileProgress(
  outDir: string,
  dll: string,
  assemblyIndex: number,
  assemblyCount: number,
  onProgress: IndexProgressListener,
): () => void {
  const startedAt = Date.now();
  let stopped = false;
  let scan: Promise<void> | null = null;
  let filesGenerated = 0;
  const report = () => {
    if (stopped) return;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const seconds = Math.floor(elapsedMs / 1000);
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    try {
      onProgress({
        type: 'phase',
        phase: 'decompile',
        message: `Decompiling ${path.basename(dll)}… ${filesGenerated.toLocaleString('en-US')} C# files generated · ${elapsed} elapsed · assembly ${assemblyIndex + 1} of ${assemblyCount}`,
        fraction: assemblyCount > 0 ? assemblyIndex / assemblyCount : undefined,
        indeterminate: true,
        filesGenerated,
        elapsedMs,
        completedAssemblies: assemblyIndex,
        totalAssemblies: assemblyCount,
      });
    } catch {
      // Progress is best-effort if a view disappears during a rebuild.
    }
  };
  report();
  const timer = setInterval(() => {
    // Walk only the current output directory, without stat-ing every file.
    // Slow drives get at most one scan at a time, while elapsed time keeps
    // updating. A scan already in flight cannot emit after this job ends.
    if (scan) {
      report();
      return;
    }
    scan = fsp.readdir(outDir, { recursive: true, withFileTypes: true }).then((entries) => {
      if (!stopped) filesGenerated = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.cs')).length;
    }).catch(() => {
      // A transient directory read failure must not abort the decompiler.
    }).finally(() => {
      scan = null;
      report();
    });
  }, 2000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function decompileAssemblies(
  input: DecompileInput,
  onProgress: IndexProgressListener,
  signal?: AbortSignal,
): Promise<{ decompiled: string[] }> {
  if (signal?.aborted) throw new Error('Index rebuild aborted');
  const exe = resolveIlspycmd();
  if (!exe) throw new IlspycmdMissingError();

  // Wipe and recreate so a previously-failed build doesn't leak stale
  // namespaces into the index.
  if (fs.existsSync(input.sourceRoot)) {
    await fsp.rm(input.sourceRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(input.sourceRoot, { recursive: true });

  const candidates = [...PRIMARY_ASSEMBLIES, ...DLC_ASSEMBLIES];
  const present = candidates
    .map((name) => path.join(input.managedDir, name))
    .filter((p) => fs.existsSync(p));

  const decompiled: string[] = [];
  for (let i = 0; i < present.length; i++) {
    if (signal?.aborted) throw new Error('Index rebuild aborted');
    const dll = present[i];
    const stem = path.basename(dll, path.extname(dll));
    const outDir = path.join(input.sourceRoot, stem);
    fs.mkdirSync(outDir, { recursive: true });

    // ilspycmd: `<dll> -p -o <outDir>` writes per-namespace .cs files.
    // -p projects per-class files into a folder structure suitable for an
    // IDE. Without -p you get one giant .cs file per assembly which is
    // useless for our index.
    const stopProgress = startDecompileProgress(outDir, dll, i, present.length, onProgress);
    let result: Awaited<ReturnType<typeof runIlspycmd>>;
    try {
      result = await runIlspycmd(exe, [dll, '-p', '-o', outDir], signal);
    } finally {
      stopProgress();
    }
    if (signal?.aborted) throw new Error('Index rebuild aborted');
    if (result.exitCode !== 0) {
      // ilspycmd sometimes returns non-zero for assemblies it partially
      // decompiles; if any .cs file landed, treat it as success but log.
      const hasOutput = await dirHasFiles(outDir, '.cs');
      if (!hasOutput) {
        throw new Error(
          `Decompiling ${path.basename(dll)} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 400)}`,
        );
      }
    }
    decompiled.push(stem);
  }

  onProgress({
    type: 'phase',
    phase: 'decompile',
    message: `Decompiled ${decompiled.length} assemblies`,
    fraction: 1,
  });
  return { decompiled };
}

async function dirHasFiles(dir: string, ext: string): Promise<boolean> {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile() && abs.toLowerCase().endsWith(ext)) return true;
    }
  }
  return false;
}
