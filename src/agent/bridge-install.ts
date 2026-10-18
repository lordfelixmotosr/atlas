// Wire the in-game Modmixer Bridge into the RimWorld install so test cycles
// get structured diagnostics (errors, warnings, attribution, perf, patch
// graph) over a localhost TCP socket instead of by tailing Player.log.
//
// In production the bridge ships as an extraResource (see forge.config.ts —
// `dist/modmixer-bridge` is staged from `vendor/modmixer-bridge` with only
// About/ and Assemblies/, no C# source). In dev we resolve straight to the
// repo path so iteration on the bridge .cs files works without re-staging.
//
// New installations are owned runtime copies at Mods/AtlasBridge, refreshed
// from the versioned bundled bridge before testing. Historical junctions stay
// supported. Workshop copies and unmanaged real folders are never overwritten.

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from './paths.js';
import type { RegistrySnapshot } from './registry/types.js';
import { ownedMirror, refreshRuntimeMirror } from './rimworld/runtime-mirror.js';
import { getMirrorStateDir } from './workspace.js';

export const BRIDGE_PACKAGE_ID = 'modmixer.bridge';
/** Folder name we use under `<rimworld>/Mods/`. Stable across versions. */
const BRIDGE_MODS_FOLDER = "AtlasBridge";

export interface BridgeInstallResult {
  /** True when the bridge is now available to RimWorld via SOME path. */
  available: boolean;
  /**
   * Why we didn't install our copy (only set when we deliberately skipped):
   * - "workshop" — user has the Workshop subscription.
   * - "local" — user has a real (non-junction) ModmixerBridge folder.
   * - "rimworld-missing" — RimWorld install not found.
   * - "source-missing" — bundled bridge dir wasn't found (broken package).
   */
  skipReason?: 'workshop' | 'local' | 'rimworld-missing' | 'source-missing';
  /** True when we created or refreshed the junction. */
  installed: boolean;
}

/**
 * Resolve the on-disk bundled bridge source. Probes dev first
 * (`<repo>/vendor/modmixer-bridge`), then the packaged extraResource path
 * (`<resourcesPath>/modmixer-bridge`). Returns null if neither exists —
 * happens in unit tests run without Electron's resourcesPath set.
 */
export function resolveBridgeSourceDir(): string | null {
  const candidates: string[] = [];
  if (app.isPackaged && process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'modmixer-bridge'));
  try {
    candidates.push(path.join(app.getAppPath(), 'vendor', 'modmixer-bridge'));
  } catch {
    // app.getAppPath() throws when Electron isn't initialized (unit tests).
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'modmixer-bridge'));
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'About', 'About.xml'))) return c;
  }
  return null;
}

/**
 * Ensure the bridge mod is loadable by RimWorld. Pass the registry snapshot
 * so we can skip if the user already has the bridge from Workshop or a real
 * folder install. Safe to call repeatedly; the common path is a single
 * `lstat` + a `realpath` comparison.
 *
 * Missing RimWorld/source returns unavailable. Filesystem failures propagate
 * so a test cannot silently proceed with a failed diagnostics installation.
 */
export async function ensureBridgeInstalled(
  snapshot: RegistrySnapshot,
): Promise<BridgeInstallResult> {
  const existing = snapshot.mods.find(
    (m) => m.about.packageIdLc === BRIDGE_PACKAGE_ID,
  );
  if (existing && existing.source === 'workshop') {
    return { available: true, installed: false, skipReason: 'workshop' };
  }

  const { modsDir } = detectRimWorldPaths();
  // detectRimWorldPaths always returns a candidate modsDir even when the
  // install isn't found; require the parent to actually exist before we
  // touch the filesystem (matches the guard in getWorkspacePaths).
  if (!fs.existsSync(path.dirname(modsDir))) {
    return { available: false, installed: false, skipReason: 'rimworld-missing' };
  }

  const source = resolveBridgeSourceDir();
  if (!source) {
    // If the user already has a non-Workshop install (real folder), that's
    // still "available" even without our source on disk.
    return {
      available: existing != null,
      installed: false,
      skipReason: 'source-missing',
    };
  }

  const target = path.join(modsDir, BRIDGE_MODS_FOLDER);

  // If a real directory (not a junction/symlink) named ModmixerBridge
  // exists, the user has installed the bridge themselves — leave it alone.
  // Their copy may even be the same packageId from a different folder name,
  // in which case `existing.source === 'local'` and we bail above too.
  try {
    const lst = await fsp.lstat(target);
    if (lst.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await fsp.realpath(target);
      } catch {
        // Dangling junction — remove it and recreate below.
        await fsp.rm(target, { recursive: true, force: true });
        await installBridgeCopy(source, target);
        return { available: true, installed: true };
      }
      if (pathsEqual(resolved, source)) {
        return { available: true, installed: false };
      }
      // Junction pointing somewhere else — stale from a previous install
      // location (e.g. dev → prod transition, or moved repo). Refresh.
      await fsp.rm(target, { recursive: true, force: true });
      await installBridgeCopy(source, target);
      return { available: true, installed: true };
    }
    if (lst.isDirectory()) {
      if (await ownedMirror(source, target, getMirrorStateDir())) {
        await refreshRuntimeMirror(source, target, getMirrorStateDir());
        return {available: true, installed: true};
      }
      // Real directory at the same folder name. Not ours; respect it.
      return { available: true, installed: false, skipReason: 'local' };
    }
    // File (?) sitting at our target path — remove and link over it.
    await fsp.rm(target, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Some other workspace folder uses BRIDGE_PACKAGE_ID? snapshot.mods filter
  // above already caught that. The Mods/ entry with our chosen folder name
  // doesn't exist — create the junction.
  await installBridgeCopy(source, target);
  return { available: true, installed: true };
}

/**
 * Remove the junction we created. Used by uninstall flows; not called in
 * the test-cycle path. Leaves real directories alone (the lstat check
 * mirrors `ensureBridgeInstalled`'s safety net).
 */
export async function removeBridgeInstall(): Promise<boolean> {
  const { modsDir } = detectRimWorldPaths();
  if (!fs.existsSync(modsDir)) return false;
  const target = path.join(modsDir, BRIDGE_MODS_FOLDER);
  try {
    const lst = await fsp.lstat(target);
    if (!lst.isSymbolicLink()) return false;
    await fsp.rm(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function installBridgeCopy(source: string, target: string): Promise<void> {
  await refreshRuntimeMirror(source, target, getMirrorStateDir());
}

/**
 * Case-insensitive on Windows (paths from `realpath` may differ in casing
 * from how we constructed `source`, e.g. "C:\Users" vs "C:\users"). On
 * mac/linux it falls through to exact match.
 */
function pathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}
