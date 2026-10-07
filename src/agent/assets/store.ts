import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getWorkspacePaths } from '../workspace.js';
import { normalizePreviewToFile } from './preview-normalize.js';
import { metadataReadPath, metadataWritePath } from '../mod-metadata.js';
import { assertPreviewPathSafe, readWorkshopPreviewDataUrl, setWorkshopPreviewSource } from './workshop-preview.js';

/** Absolute path of a workspace mod folder — no existence check. */
function resolveModDir(folder: string): string {
  const { workspaceDir } = getWorkspacePaths();
  return path.join(workspaceDir, folder);
}

function modRoot(folder: string): string {
  const abs = resolveModDir(folder);
  if (!fs.existsSync(abs)) {
    throw new Error(`Workspace mod not found: ${folder}`);
  }
  return abs;
}

/** Resolve a relative path under the mod root, refusing anything that escapes it. */
function safeJoin(modDir: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(modDir, ...normalized.split('/'));
  const rootResolved = path.resolve(modDir);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error(`Path escapes mod folder: ${relPath}`);
  }
  return abs;
}

export async function addAssetFile(
  folder: string,
  destRelPath: string,
  sourceAbsPath: string,
): Promise<void> {
  const modDir = modRoot(folder);
  const dest = safeJoin(modDir, destRelPath);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(sourceAbsPath, dest);
}

/**
 * Stores a Workshop PNG/JPEG preview or preserves an animated GIF alongside
 * its normalized first frame in About/Preview.png for RimWorld's mod browser.
 * Use this rather than addAssetFile when the user picks a preview image —
 * Steam rejects oversize previews with k_EResultLimitExceeded at publish.
 */
export async function setPreviewImageFile(
  folder: string,
  sourceAbsPath: string,
): Promise<void> {
  const modDir = previewModRoot(folder), { workspaceDir } = getWorkspacePaths();
  const backupRoot = path.dirname(metadataWritePath(workspaceDir, 'preview-import-backups/' + folder + '/index.json'));
  await setWorkshopPreviewSource(modDir, sourceAbsPath, backupRoot);
}

function previewModRoot(folder: string): string {
  if (!folder || folder === '.' || folder === '..' || /[\/\\\x00]/.test(folder)) throw new Error('Invalid mod folder for a preview image.');
  return assertPreviewPathSafe(modRoot(folder));
}

/** Selected animated Workshop preview, or the newer static game preview. */
export function readPreviewImageDataUrl(folder: string): string | null {
  return readWorkshopPreviewDataUrl(previewModRoot(folder));
}

export async function removeAssetFile(folder: string, relPath: string): Promise<void> {
  const modDir = modRoot(folder);
  const target = safeJoin(modDir, relPath);
  try {
    await fsp.unlink(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

export async function readAssetDataUrl(
  folder: string,
  relPath: string,
): Promise<string | null> {
  // A read tolerates a missing mod folder — return null like a missing file
  // does. The renderer fires these from preview components that can outlive
  // the folder (a mod deleted/renamed while a thumbnail is still mounted), and
  // throwing here surfaced as an unhandled rejection (Sentry MODMIXERAPP-E/M/N).
  const modDir = resolveModDir(folder);
  const abs = safeJoin(modDir, relPath);
  let buf: Buffer;
  try {
    buf = await fsp.readFile(abs);
  } catch {
    return null;
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.ogg' ? 'audio/ogg' : 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export function modAbsPath(folder: string): string {
  return modRoot(folder);
}

/**
 * Sidecar dir that holds per-mod Atlas-private data — currently only the
 * preview-image background source. Lives at the workspace root rather than
 * inside the mod folder so it doesn't ship to Steam (publish uploads
 * `<workspaceDir>/<folder>` only) and doesn't get scanned as a mod by
 * RimWorld or by our own listWorkspaceMods (`.atlas` is in SKIP_DIRS).
 */
function previewBgDir(folder: string): string {
  const { workspaceDir } = getWorkspacePaths();
  // Refuse path traversal in the folder id.
  if (folder.includes('/') || folder.includes('\\') || folder.includes('..')) {
    throw new Error(`Invalid mod folder id: ${folder}`);
  }
  return path.dirname(metadataWritePath(workspaceDir, 'preview-bg/' + folder + '/source.png'));
}

function previewBgFile(folder: string, write = false): string {
  previewBgDir(folder); // Validate the folder ID and adopt legacy metadata.
  const { workspaceDir } = getWorkspacePaths();
  return (write ? metadataWritePath : metadataReadPath)(workspaceDir, 'preview-bg/' + folder + '/source.png');
}

/**
 * Copy the user-picked image into the preview-BG sidecar, normalized through
 * the same long-edge / size ladder as the published Preview.png. Returns the
 * absolute path of the stored copy. Existing source is overwritten.
 */
export async function setPreviewBgSource(
  folder: string,
  sourceAbsPath: string,
): Promise<string> {
  // Validate the folder exists as a workspace mod before we write.
  modRoot(folder);
  const dest = previewBgFile(folder, true);
  await normalizePreviewToFile(sourceAbsPath, dest);
  return dest;
}

/** Absolute path to the current BG source for a mod, or null if none. */
export function getPreviewBgSource(folder: string): string | null {
  const dest = previewBgFile(folder);
  return fs.existsSync(dest) ? dest : null;
}

export async function clearPreviewBgSource(folder: string): Promise<void> {
  const dest = previewBgFile(folder);
  try {
    await fsp.unlink(dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

/** Read the BG source as a data URL for the renderer thumbnail, or null. */
export async function readPreviewBgSourceDataUrl(
  folder: string,
): Promise<string | null> {
  const abs = getPreviewBgSource(folder);
  if (!abs) return null;
  const buf = await fsp.readFile(abs);
  return `data:image/png;base64,${buf.toString('base64')}`;
}
