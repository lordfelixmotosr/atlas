import fs from 'node:fs';
import path from 'node:path';

export const MOD_METADATA_DIR = '.atlas';
export const LEGACY_METADATA_DIR = '.modmixer';

/** Adopt the legacy directory intact, without overwriting existing Atlas data. */
export function metadataDirectory(modDir: string): string {
  const current = path.join(modDir, MOD_METADATA_DIR);
  const legacy = path.join(modDir, LEGACY_METADATA_DIR);
  for (const dir of [current, legacy]) {
    if (fs.existsSync(dir)) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Mod metadata must be a local directory: ' + dir);
      }
    }
  }
  if (!fs.existsSync(current) && fs.existsSync(legacy)) fs.renameSync(legacy, current);
  return current;
}

function metadataTarget(dir: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes(':') ||
      relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid mod metadata path.');
  }
  let target = dir;
  for (const part of relative.split(/[\\/]/)) {
    target = path.join(target, part);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('Linked mod metadata is not supported.');
    }
  }
  return target;
}

export function metadataWritePath(modDir: string, relative: string): string {
  return metadataTarget(metadataDirectory(modDir), relative);
}

export function metadataReadPath(modDir: string, relative: string): string {
  const current = metadataWritePath(modDir, relative);
  if (fs.existsSync(current)) return current;
  // Mixed folders can exist after a manual import. Prefer Atlas files and
  // preserve any legacy files until the user resolves the duplicate folders.
  const legacy = metadataTarget(path.join(modDir, LEGACY_METADATA_DIR), relative);
  return fs.existsSync(legacy) ? legacy : current;
}
