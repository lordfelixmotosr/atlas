import fs from 'node:fs/promises';
import path from 'node:path';

export interface AssetModRoot { source: string; folder: string; path: string }
export interface ResolvedAsset { filePath: string; contentType: string; immutable: boolean }

const validSources = new Set(['official', 'local', 'workshop', 'workspace']);
const imageTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.avif': 'image/avif',
};
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function hasImageHeader(header: Buffer, type: string): boolean {
  if (type === 'image/png') return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return header[0] === 255 && header[1] === 216 && header[2] === 255;
  if (type === 'image/gif') return /^GIF8[79]a$/.test(header.subarray(0, 6).toString('ascii'));
  if (type === 'image/webp') return header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  if (type === 'image/bmp') return header.subarray(0, 2).toString('ascii') === 'BM';
  if (type === 'image/x-icon') return header.readUInt32LE(0) === 65536;
  if (type === 'image/avif') return header.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(header.subarray(8).toString('ascii'));
  return false;
}

/** Resolve image requests only inside owned workspace or live registry mod roots. */
export async function resolveAssetRequest(rawUrl: string, workspaceDir: string, mods: readonly AssetModRoot[]): Promise<ResolvedAsset | null> {
  let url: URL, segments: string[];
  try {
    url = new URL(rawUrl);
    if (url.protocol !== 'modmixer-asset:' || url.username || url.password || url.port) return null;
    segments = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
  } catch { return null; }
  let candidate: string, roots: string[], immutable = false;
  if (url.hostname === 'preview' && segments.length === 2) {
    const [source, folder] = segments;
    if (!validSources.has(source)) return null;
    const mod = mods.find(entry => entry.source === source && entry.folder === folder);
    if (!mod) return null;
    roots = [mod.path]; candidate = path.join(mod.path, 'About', 'Preview.png'); immutable = true;
  } else if (url.hostname === 'chat' && segments.length === 2) {
    const [folder, relative] = segments;
    if (!folder || folder === '.' || folder === '..' || /[\\/:\u0000]/.test(folder) || path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) return null;
    const modRoot = path.resolve(workspaceDir, folder);
    candidate = path.resolve(modRoot, relative.replace(/\\/g, path.sep));
    if (!inside(modRoot, candidate)) return null;
    roots = [workspaceDir];
  } else if (url.hostname === 'workspace' && segments.length === 1) {
    const relative = segments[0];
    if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) return null;
    roots = [workspaceDir]; candidate = path.resolve(workspaceDir, relative.replace(/\\/g, path.sep));
  } else if (url.hostname === 'image' && segments.length === 1) {
    if (!path.isAbsolute(segments[0])) return null;
    candidate = path.resolve(segments[0]); roots = [workspaceDir, ...mods.map(mod => mod.path)];
  } else { return null; }
  if (candidate.includes('\0')) return null;
  const contentType = imageTypes[path.extname(candidate).toLowerCase()];
  if (!contentType) return null;
  try {
    // Both lexical and canonical containment are required. A workspace symlink
    // must not grant image access to an unrelated directory outside its root.
    const realFile = await fs.realpath(candidate);
    let permitted = false;
    for (const root of roots) {
      const absoluteRoot = path.resolve(root);
      if (!inside(absoluteRoot, candidate)) continue;
      if (inside(await fs.realpath(absoluteRoot), realFile)) { permitted = true; break; }
    }
    if (!permitted || !(await fs.stat(realFile)).isFile()) return null;
    const file = await fs.open(realFile, 'r');
    try {
      const header = Buffer.alloc(32);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead < 8 || !hasImageHeader(header.subarray(0, bytesRead), contentType)) return null;
    } finally { await file.close(); }
    return { filePath: realFile, contentType, immutable };
  } catch { return null; }
}
