'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function buildIcons(source, destination) {
  const sharp = require(process.env.ATLAS_SHARP_MODULE || 'sharp');
  fs.mkdirSync(destination, { recursive: true });
  const resize = (size) => sharp(source).resize(size, size, {
    fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png().toBuffer();
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(resize));
  fs.writeFileSync(path.join(destination, 'icon.png'), images.at(-1));
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    header[at] = sizes[index] === 256 ? 0 : sizes[index];
    header[at + 1] = header[at];
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  fs.writeFileSync(path.join(destination, 'Atlas.ico'), Buffer.concat([header, ...images]));
}

module.exports = { buildIcons };
