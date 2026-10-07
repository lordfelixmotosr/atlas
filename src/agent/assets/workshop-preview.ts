import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { normalizePreviewBuffer, STEAM_PREVIEW_LIMIT_BYTES } from './preview-normalize.js';
import { rasterizeSvg } from '../tools/lib/resvg-init.js';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export interface WorkshopGifInfo { width: number; height: number; frames: number }
export interface PreparedWorkshopPreview { png: Buffer; width: number; height: number; gif?: Buffer }

/** Check every existing ancestor, including Windows junctions, before preview I/O. */
export function assertPreviewPathSafe(filename: string): string {
  const absolute = path.resolve(filename), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Preview images cannot be read or written through symbolic links or directory junctions.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return absolute;
}

function regularFile(filename: string, maximum = MAX_SOURCE_BYTES): Buffer | null {
  assertPreviewPathSafe(filename);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > maximum) throw new Error('Preview image is not a regular file or is too large.');
  return fs.readFileSync(filename);
}

function validateGifLzw(data: Buffer, minimum: number, expectedPixels: number, colors: number): void {
  const clear = 1 << minimum, end = clear + 1, prefixes = new Int16Array(4096), suffixes = new Uint8Array(4096);
  let bits = minimum + 1, next = clear + 2, bitOffset = 0, previous = -1, count = 0;
  const sequence = (code: number): { first: number; length: number } => {
    let length = 1, steps = 0;
    while (code >= clear) { if (code >= next || ++steps > 4096) throw new Error('GIF frame compression dictionary is invalid.'); if (suffixes[code] >= colors) throw new Error('GIF frame references an invalid color.'); code = prefixes[code]; length++; }
    if (code >= colors) throw new Error('GIF frame references an invalid color.'); return { first: code, length };
  };
  while (bitOffset + bits <= data.length * 8) {
    let code = 0; for (let bit = 0; bit < bits; bit++) code |= ((data[(bitOffset + bit) >> 3] >> ((bitOffset + bit) & 7)) & 1) << bit; bitOffset += bits;
    if (code === clear) { bits = minimum + 1; next = clear + 2; previous = -1; continue; }
    if (code === end) { if (count !== expectedPixels) throw new Error('GIF decoded frame does not match its canvas.'); return; }
    let decoded: { first: number; length: number };
    if (code < next && code !== clear && code !== end) decoded = sequence(code);
    else if (code === next && previous >= 0) { const last = sequence(previous); decoded = { first: last.first, length: last.length + 1 }; }
    else throw new Error('GIF frame contains invalid compressed image data.');
    count += decoded.length; if (count > expectedPixels) throw new Error('GIF frame exceeds its declared dimensions.');
    if (previous >= 0 && next < 4096) { prefixes[next] = previous; suffixes[next] = decoded.first; next++; if (next === (1 << bits) && bits < 12) bits++; }
    previous = code;
  }
  throw new Error('GIF frame is missing its compression end marker.');
}

/** Structural GIF validation bounds animation cost before first-frame decoding. */
export function inspectWorkshopGif(input: Buffer): WorkshopGifInfo {
  if (input.length > STEAM_PREVIEW_LIMIT_BYTES) throw new Error('Animated GIF previews must be 1 MiB or smaller. Export a smaller GIF; Atlas preserves the animation instead of flattening it for Steam.');
  if (input.length < 14 || !['GIF87a', 'GIF89a'].includes(input.toString('ascii', 0, 6))) throw new Error('Choose a valid GIF preview.');
  const width = input.readUInt16LE(6), height = input.readUInt16LE(8);
  if (!width || !height || width > 2048 || height > 2048) throw new Error('GIF preview dimensions must be 1–2048 pixels.');
  let offset = 13, frames = 0, pixels = 0, globalColors = 0;
  const skip = (count: number) => { if (offset + count > input.length) throw new Error('GIF preview is truncated.'); offset += count; };
  const blocks = () => { const parts: Buffer[] = []; while (true) { if (offset >= input.length) throw new Error('GIF preview is truncated.'); const size = input[offset++]; if (!size) break; const start = offset; skip(size); parts.push(input.subarray(start, offset)); } return Buffer.concat(parts); };
  if (input[10] & 0x80) { globalColors = 1 << ((input[10] & 7) + 1); skip(3 * globalColors); }
  while (offset < input.length) {
    const marker = input[offset++];
    if (marker === 0x3b) { if (!frames || offset !== input.length) throw new Error('GIF preview has an invalid end marker.'); return { width, height, frames }; }
    if (marker === 0x21) {
      if (offset >= input.length) throw new Error('GIF extension is truncated.'); const label = input[offset++];
      if (label === 0xf9) { if (offset + 6 > input.length || input[offset] !== 4 || input[offset + 5] !== 0) throw new Error('GIF frame control is invalid.'); skip(6); }
      else blocks();
      continue;
    }
    if (marker !== 0x2c || offset + 9 > input.length) throw new Error('GIF preview contains an invalid frame.');
    const left = input.readUInt16LE(offset), top = input.readUInt16LE(offset + 2), frameWidth = input.readUInt16LE(offset + 4), frameHeight = input.readUInt16LE(offset + 6), flags = input[offset + 8];
    skip(9);
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) throw new Error('GIF frame is outside its canvas.');
    frames++; pixels += frameWidth * frameHeight;
    if (frames > 200 || pixels > 64 * 1024 * 1024) throw new Error('GIF preview has too many frames or too much decoded image data. Use up to 200 frames.');
    let colors = globalColors;
    if (flags & 0x80) { colors = 1 << ((flags & 7) + 1); skip(3 * colors); }
    if (!colors) throw new Error('GIF frame has no color table.');
    if (offset >= input.length || input[offset] < 2 || input[offset] > 8) throw new Error('GIF frame compression is invalid.');
    const minimum = input[offset]; skip(1); const data = blocks(); if (!data.length) throw new Error('GIF frame contains no image data.');
    validateGifLzw(data, minimum, frameWidth * frameHeight, colors);
  }
  throw new Error('GIF preview is missing its end marker.');
}

export async function prepareWorkshopPreviewBuffer(input: Buffer): Promise<PreparedWorkshopPreview> {
  if (input.length > MAX_SOURCE_BYTES) throw new Error('Choose a preview image smaller than 20 MiB.');
  const gifSignature = ['GIF87a', 'GIF89a'].includes(input.toString('ascii', 0, 6));
  let source = input;
  if (gifSignature) {
    const info = inspectWorkshopGif(input);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}" viewBox="0 0 ${info.width} ${info.height}"><image width="${info.width}" height="${info.height}" href="data:image/gif;base64,${input.toString('base64')}"/></svg>`;
    const rendered = await rasterizeSvg(svg, { fitTo: { mode: 'width', value: Math.min(1280, info.width) } });
    source = Buffer.from(rendered.png);
  }
  const normalized = await normalizePreviewBuffer(source);
  if (normalized.buffer.length > STEAM_PREVIEW_LIMIT_BYTES) throw new Error('The normalized preview still exceeds Steam’s 1 MiB limit. Choose a smaller image.');
  return { png: normalized.buffer, width: normalized.width, height: normalized.height, ...(gifSignature ? { gif: Buffer.from(input) } : {}) };
}

function digest(bytes: Buffer | null): string | null { return bytes ? createHash('sha256').update(bytes).digest('hex') : null; }
async function atomicPreviewWrite(filename: string, bytes: Buffer): Promise<void> {
  assertPreviewPathSafe(filename); const temporary = filename + '.' + randomUUID() + '.tmp';
  try { await fsp.writeFile(temporary, bytes, { flag: 'wx' }); assertPreviewPathSafe(filename); await fsp.rename(temporary, filename); }
  finally { try { assertPreviewPathSafe(temporary); await fsp.unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}

/** Commit GIF and its static companion together, restoring originals on failure. */
export async function writeWorkshopPreview(modRoot: string, prepared: PreparedWorkshopPreview, backupRoot?: string): Promise<void> {
  const about = assertPreviewPathSafe(path.join(modRoot, 'About'));
  if (!fs.statSync(assertPreviewPathSafe(modRoot)).isDirectory()) throw new Error('Mod folder is missing.');
  const records = [
    { filename: path.join(about, 'Preview.png'), bytes: prepared.png as Buffer | null },
    { filename: path.join(about, 'WorkshopPreview.gif'), bytes: prepared.gif ?? null },
  ].map(record => { const before = regularFile(record.filename); return { ...record, before, beforeTimes: before ? fs.statSync(record.filename) : null }; });
  let backup: string | null = null;
  if (backupRoot && records.some(record => record.before)) {
    const safeRoot = assertPreviewPathSafe(backupRoot), relative = path.relative(path.resolve(modRoot), safeRoot);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Preview backups must be outside the mod folder.');
    backup = assertPreviewPathSafe(path.join(safeRoot, randomUUID())); await fsp.mkdir(backup, { recursive: true }); assertPreviewPathSafe(backup);
    for (const record of records) if (record.before) await atomicPreviewWrite(path.join(backup, path.basename(record.filename)), record.before);
    await atomicPreviewWrite(path.join(backup, 'receipt.json'), Buffer.from(JSON.stringify({ modRoot, createdAt: new Date().toISOString(), files: records.filter(record => record.before).map(record => ({ file: path.basename(record.filename), hash: digest(record.before) })) }, null, 2)));
  }
  await fsp.mkdir(about, { recursive: true }); assertPreviewPathSafe(about);
  const written: typeof records = [];
  try {
    for (const record of records) {
      if (digest(regularFile(record.filename)) !== digest(record.before)) throw new Error('The preview changed during import. Please try again.');
      if (record.bytes) await atomicPreviewWrite(record.filename, record.bytes);
      else if (record.before) { assertPreviewPathSafe(record.filename); await fsp.unlink(record.filename); }
      written.push(record);
    }
    if (prepared.gif) {
      const pngStat = await fsp.stat(records[0].filename), gifStat = await fsp.stat(records[1].filename);
      if (gifStat.mtimeMs < pngStat.mtimeMs) await fsp.utimes(records[1].filename, gifStat.atime, new Date(Math.ceil(pngStat.mtimeMs) + 1));
    }
  } catch (error) {
    const failures: string[] = [];
    for (const record of written.reverse()) {
      try {
        if (record.before) { await atomicPreviewWrite(record.filename, record.before); if (record.beforeTimes) await fsp.utimes(record.filename, record.beforeTimes.atimeMs / 1000, record.beforeTimes.mtimeMs / 1000); }
        else { assertPreviewPathSafe(record.filename); await fsp.unlink(record.filename); }
      }
      catch (rollbackError) { failures.push(String(rollbackError)); }
    }
    if (failures.length) throw new Error(`Preview import failed and some originals could not be restored: ${failures.join('; ')}.${backup ? ` Original previews were saved at ${backup}.` : ''}`);
    throw error;
  }
}

/** Direct PNG regeneration supersedes an older GIF without deleting its source. */
export function selectWorkshopPreviewPath(modRoot: string): string | undefined {
  const png = assertPreviewPathSafe(path.join(modRoot, 'About', 'Preview.png')), gif = assertPreviewPathSafe(path.join(modRoot, 'About', 'WorkshopPreview.gif'));
  const pngStat = fs.existsSync(png) ? fs.lstatSync(png) : null, gifStat = fs.existsSync(gif) ? fs.lstatSync(gif) : null;
  if (gifStat && (!pngStat || gifStat.mtimeMs >= pngStat.mtimeMs)) { if (gifStat.size > STEAM_PREVIEW_LIMIT_BYTES) throw new Error('Animated GIF previews must be 1 MiB or smaller. Export a smaller GIF to publish it.'); const bytes = regularFile(gif, STEAM_PREVIEW_LIMIT_BYTES); if (!bytes) return undefined; inspectWorkshopGif(bytes); return gif; }
  if (pngStat) { if (!pngStat.isFile()) throw new Error('Preview image is not a regular file.'); return png; }
  return undefined;
}

export function readWorkshopPreviewDataUrl(modRoot: string): string | null {
  const filename = selectWorkshopPreviewPath(modRoot); if (!filename) return null;
  const bytes = regularFile(filename); return bytes ? `data:${filename.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/png'};base64,${bytes.toString('base64')}` : null;
}

export async function setWorkshopPreviewSource(modRoot: string, source: string, backupRoot?: string): Promise<void> {
  const input = regularFile(path.resolve(source)); if (!input) throw new Error('Preview image was not found.');
  const prepared = await prepareWorkshopPreviewBuffer(input); await writeWorkshopPreview(modRoot, prepared, backupRoot);
}
