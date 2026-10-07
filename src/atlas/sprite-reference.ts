import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';

export const MAX_SPRITE_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_SPRITE_REFERENCE_TOTAL_BYTES = 24 * 1024 * 1024;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

/** Caller supplies an owned, hash-validated Studio path, never a renderer path. */
export async function readSpriteReference(filename: string): Promise<{ image: ImageContent; bytes: number }> {
  const absolute = path.resolve(filename);
  if (!path.isAbsolute(filename) || path.extname(absolute).toLowerCase() !== '.png') throw new Error('Saved sprite references must be local PNG files.');
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const entry = await fs.lstat(current);
    if (entry.isSymbolicLink()) throw new Error('Linked sprite reference paths are not supported. Import the PNG again.');
  }
  const handle = await fs.open(absolute, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 45 || stat.size > MAX_SPRITE_REFERENCE_BYTES) throw new Error('Each saved sprite reference must be a valid PNG no larger than 8 MB. Import a smaller PNG.');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('A saved sprite reference changed while it was being read. Import it again.');
      offset += read.bytesRead;
    }
    if ((await handle.stat()).size !== stat.size) throw new Error('A saved sprite reference changed while it was being read. Import it again.');
    if (!bytes.subarray(0, 8).equals(pngSignature) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) > 2048 || bytes.readUInt32BE(20) > 2048) throw new Error('A saved sprite reference has an invalid PNG header or canvas. Import it again.');
    // Do not flatten transparency or recompress identity artwork as JPEG.
    return { image: { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }, bytes: bytes.length };
  } finally { await handle.close(); }
}
