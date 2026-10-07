'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const DIRECTIONS = ['south', 'east', 'north'];
const ID = /^[a-f0-9]{24}$/;
const MAX_PNG = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PHASES = [-35, -15, 10, 35, 25, 5, -5, -25];
const ALLOWED_TAGS = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const COMMON_ATTRS = new Set(['fill', 'stroke', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'transform']);
const TAG_ATTRS = {
  g: [], path: ['d'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'], polygon: ['points'],
};
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function fail(message) { throw new Error(message); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function id() { return crypto.randomBytes(12).toString('hex'); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function contained(root, file) { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function checkedId(value) { if (typeof value !== 'string' || !ID.test(value)) fail('Invalid Sprite Studio project or candidate id.'); return value; }
function validateDirections(value) {
  if (!Array.isArray(value) || !value.length || value.length > 3 || value.some(x => !DIRECTIONS.includes(x)) || new Set(value).size !== value.length) fail('Choose distinct south, east, or north directions.');
  return DIRECTIONS.filter(x => value.includes(x));
}
function validateRecipe(raw) {
  if (!plain(raw)) fail('A sprite recipe is required.');
  const recipe = {
    name: String(raw.name ?? '').trim(), kind: raw.kind, brief: String(raw.brief ?? '').trim(),
    palette: raw.palette, canvasSize: raw.canvasSize, frameCount: raw.frameCount,
    ticksPerFrame: raw.ticksPerFrame, drawSize: raw.drawSize,
    groundedDrawSize: raw.kind === 'bird' ? (raw.groundedDrawSize ?? 0.7) : raw.drawSize, textureName: raw.textureName,
  };
  if (!recipe.name || recipe.name.length > 100 || /[\x00-\x1f]/.test(recipe.name)) fail('Use a sprite name of 1–100 characters.');
  if (!['sprite', 'bird'].includes(recipe.kind)) fail('Invalid sprite preset.');
  if (recipe.brief.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(recipe.brief)) fail('The sprite brief is too long or contains control characters.');
  if (!Array.isArray(recipe.palette) || recipe.palette.length < 2 || recipe.palette.length > 16 || recipe.palette.some(x => typeof x !== 'string' || !/^#[0-9a-f]{6}$/i.test(x))) fail('Choose 2–16 palette colors in #RRGGBB form.');
  recipe.palette = [...new Set(recipe.palette.map(x => x.toLowerCase()))];
  if (recipe.palette.length < 2) fail('Choose at least two distinct palette colors.');
  if (![128, 256, 512].includes(recipe.canvasSize)) fail('Choose a 128, 256, or 512 pixel canvas.');
  if (recipe.frameCount !== (recipe.kind === 'bird' ? 8 : 1)) fail(recipe.kind === 'bird' ? 'Odyssey bird presets use 8 flight frames.' : 'Static sprite presets use one frame.');
  if (!Number.isInteger(recipe.ticksPerFrame) || recipe.ticksPerFrame < 1 || recipe.ticksPerFrame > 30) fail('Ticks per frame must be 1–30.');
  if (typeof recipe.drawSize !== 'number' || !Number.isFinite(recipe.drawSize) || recipe.drawSize < 0.05 || recipe.drawSize > 20) fail('Draw size must be between 0.05 and 20.');
  if (typeof recipe.groundedDrawSize !== 'number' || !Number.isFinite(recipe.groundedDrawSize) || recipe.groundedDrawSize < 0.05 || recipe.groundedDrawSize > 20) fail('Grounded draw size must be between 0.05 and 20.');
  if (typeof recipe.textureName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(recipe.textureName)) fail('Texture name must start with a letter and contain only letters, digits and underscores.');
  return recipe;
}
function noLinks(target, create = false) {
  const absolute = path.resolve(target), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create) { fs.mkdirSync(current); stat = fs.lstatSync(current); } else continue;
    }
    if (stat.isSymbolicLink()) fail('Sprite Studio cannot access symbolic links or directory junctions.');
  }
  return absolute;
}
function pngInfo(value, sourceImage = false) {
  const bytes = Buffer.from(value);
  if (bytes.length < 45 || bytes.length > MAX_PNG || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail('Choose a valid PNG smaller than 16 MB.');
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('Invalid PNG image header.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], color = bytes[25];
  const sourceDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!width || !height || width > 2048 || height > 2048 || !(sourceImage ? sourceDepths[color]?.includes(depth) : [8, 16].includes(depth) && [4, 6].includes(color)) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > (sourceImage ? 1 : 0)) fail('PNG images need valid color encoding and dimensions no larger than 2048 pixels; rendered sprites require a noninterlaced alpha channel.');
  let offset = 8, imageData = false, end = false; const chunks = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > MAX_PNG || offset + length + 12 > bytes.length) fail('Truncated PNG image.');
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail('PNG image checksum is invalid.');
    if (type === 'IDAT') { imageData = true; chunks.push(bytes.subarray(offset + 8, offset + 8 + length)); }
    if (type === 'IEND') { if (length !== 0 || offset + 12 !== bytes.length) fail('Invalid PNG end marker.'); end = true; break; }
    offset += length + 12;
  }
  if (!imageData || !end) fail('Incomplete PNG image.');
  if (sourceImage && (![4, 6].includes(color) || bytes[28] === 1)) {
    const sourceChannels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color], max = Math.ceil(width * sourceChannels * depth / 8) * height + height * 16 + 100;
    try { zlib.inflateSync(Buffer.concat(chunks), { maxOutputLength: max }); } catch { fail('PNG pixel data is invalid or exceeds its declared canvas.'); }
    return { bytes, width, height, warnings: [] };
  }
  const channels = color === 4 ? 2 : 4, sampleBytes = depth / 8, bpp = channels * sampleBytes, rowBytes = width * bpp, expected = (rowBytes + 1) * height;
  let raw; try { raw = zlib.inflateSync(Buffer.concat(chunks), { maxOutputLength: expected }); } catch { fail('PNG pixel data is invalid or exceeds its declared canvas.'); }
  if (raw.length !== expected) fail('PNG pixel data does not match its declared canvas.');
  let previous = Buffer.alloc(rowBytes), opaque = true, clipped = false, visible = false;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]; if (filter > 4) fail('Invalid PNG pixel filter.');
    const row = Buffer.from(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)));
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = previous[x], c = x >= bpp ? previous[x - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = Math.floor((a + b) / 2);
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[x] = (row[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const alphaIndex = x * bpp + (channels - 1) * sampleBytes, alpha = depth === 8 ? row[alphaIndex] : row.readUInt16BE(alphaIndex);
      if (alpha < (depth === 8 ? 255 : 65535)) opaque = false;
      if (alpha > 0) visible = true;
      if (alpha > 0 && (x === 0 || x === width - 1 || y === 0 || y === height - 1)) clipped = true;
    }
    previous = row;
  }
  const warnings = []; if (!visible) warnings.push('The PNG contains no visible sprite pixels.'); if (opaque) warnings.push('The canvas is fully opaque; check that the sprite background is transparent.'); if (clipped) warnings.push('Visible pixels touch the canvas edge; check for clipped wings or insufficient padding.');
  return { bytes, width, height, warnings, visible };
}
function readRegular(file, max = MAX_PNG) {
  noLinks(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > max) fail('Sprite Studio asset is missing, invalid or too large.');
  return fs.readFileSync(file);
}
function atomicWrite(file, bytes) {
  noLinks(path.dirname(file), true); noLinks(file);
  const tmp = file + '.' + id() + '.tmp';
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' }); noLinks(file);
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) { noLinks(tmp); fs.unlinkSync(tmp); } }
}
function numeric(value, max) {
  if (!/^[+\-]?(?:\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > max) fail('SVG coordinates or values are outside the permitted range.');
}
function numbers(value, max) {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean); if (!parts.length || parts.length > 12000) fail('Invalid SVG numbers.');
  for (const part of parts) numeric(part, max);
}
function validateFragment(svg, recipe, budget) {
  if (typeof svg !== 'string' || !svg.trim() || Buffer.byteLength(svg) > 120000 || /[&\x00-\x08\x0b\x0c\x0e-\x1f]/.test(svg)) fail('Return bounded SVG shape fragments without entities or control characters.');
  budget.bytes += Buffer.byteLength(svg); if (budget.bytes > 300000) fail('The sprite geometry exceeds the project limit.');
  const stack = [], token = /<[^>]*>/g; let previous = 0, match;
  while ((match = token.exec(svg))) {
    if (svg.slice(previous, match.index).trim()) fail('SVG fragments may contain shapes only, without text.');
    previous = token.lastIndex;
    const text = match[0], closing = /^<\/([a-z]+)\s*>$/.exec(text);
    if (closing) { if (stack.pop() !== closing[1]) fail('SVG groups are not properly closed.'); continue; }
    const opening = /^<([a-z]+)([\s\S]*?)\s*(\/?)>$/.exec(text);
    if (!opening || !ALLOWED_TAGS.has(opening[1])) fail('SVG contains an unsupported or unsafe element.');
    const tag = opening[1], attributes = opening[2], attributeToken = /\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let end = 0, attr, seen = new Set();
    while ((attr = attributeToken.exec(attributes))) {
      if (attributes.slice(end, attr.index).trim()) fail('Invalid SVG attribute syntax.'); end = attributeToken.lastIndex;
      const key = attr[1], value = attr[2] ?? attr[3];
      if (seen.has(key) || (!COMMON_ATTRS.has(key) && !TAG_ATTRS[tag].includes(key))) fail('SVG contains an unsupported or unsafe attribute.'); seen.add(key);
      if (key === 'fill' || key === 'stroke') { if (value !== 'none' && !recipe.palette.includes(value.toLowerCase())) fail('SVG colors must use the locked project palette.'); }
      else if (key === 'stroke-linecap') { if (!['butt', 'round', 'square'].includes(value)) fail('Invalid stroke line cap.'); }
      else if (key === 'stroke-linejoin') { if (!['miter', 'round', 'bevel'].includes(value)) fail('Invalid stroke line join.'); }
      else if (key === 'fill-rule') { if (!['evenodd', 'nonzero'].includes(value)) fail('Invalid fill rule.'); }
      else if (key === 'd') {
        if (value.length > 80000 || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/.test(value) || !/[Mm]/.test(value)) fail('Invalid or overly complex SVG path.');
        const extracted = value.match(/[+\-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?/g) || []; if (extracted.length > 12000) fail('SVG path is too complex.'); for (const n of extracted) numeric(n, recipe.canvasSize * 8);
      } else if (key === 'points') numbers(value, recipe.canvasSize * 8);
      else if (key === 'transform') {
        let pos = 0; const transformations = /(translate|rotate|scale|matrix)\s*\(([^)]*)\)/g; let transformation;
        while ((transformation = transformations.exec(value))) {
          if (value.slice(pos, transformation.index).trim()) fail('Invalid SVG transform.'); pos = transformations.lastIndex;
          numbers(transformation[2], 4096);
          const n = transformation[2].trim().split(/[\s,]+/).length;
          if (!({ translate: [1, 2], rotate: [1, 3], scale: [1, 2], matrix: [6] })[transformation[1]].includes(n)) fail('Invalid SVG transform arguments.');
        }
        if (!pos || value.slice(pos).trim()) fail('Unsupported SVG transform.');
      } else {
        numeric(value, recipe.canvasSize * 8);
        if (/opacity/.test(key) && (Number(value) < 0 || Number(value) > 1)) fail('SVG opacity must be 0–1.');
        if (['r', 'rx', 'ry', 'width', 'height', 'stroke-width'].includes(key) && Number(value) < 0) fail('SVG sizes must not be negative.');
      }
    }
    if (attributes.slice(end).trim()) fail('Invalid SVG attribute syntax.');
    budget.nodes++; if (budget.nodes > 2000) fail('The sprite geometry exceeds the shape limit.');
    if (!opening[3]) { stack.push(tag); if (stack.length > 24) fail('SVG nesting is too deep.'); }
  }
  if (svg.slice(previous).trim() || stack.length || !previous) fail('SVG fragments are incomplete.');
  return svg;
}
function parseResponse(response, selected, recipe) {
  let parsed = response;
  if (typeof response === 'string') {
    if (Buffer.byteLength(response) > 500000) fail('The model response exceeds 500 KB.');
    const text = response.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
    try { parsed = JSON.parse(text); } catch { fail('The model must return a JSON object with directional SVG layers.'); }
  } else if (Buffer.byteLength(JSON.stringify(response) || '') > 500000) fail('The model response exceeds 500 KB.');
  if (!plain(parsed) || Object.keys(parsed).some(x => x !== 'directions') || !plain(parsed.directions)) fail('Invalid sprite response structure.');
  const keys = Object.keys(parsed.directions); if (keys.length !== selected.length || selected.some(x => !keys.includes(x))) fail('The model response must contain exactly the requested directions.');
  const budget = { bytes: 0, nodes: 0 }, scenes = {};
  for (const direction of selected) {
    const raw = parsed.directions[direction];
    if (!plain(raw) || !raw.body || Object.keys(raw).some(x => !['body', 'wingNear', 'wingFar'].includes(x))) fail('A sprite scene needs body and optional near/far wing layers.');
    const scene = {};
    for (const key of ['body', 'wingNear', 'wingFar']) {
      const layer = raw[key]; if (!layer) continue;
      if (!plain(layer) || Object.keys(layer).some(x => !['svg', 'pivot'].includes(x))) fail('Invalid sprite layer.');
      scene[key] = { svg: validateFragment(layer.svg, recipe, budget) };
      if (key !== 'body') {
        if (!plain(layer.pivot) || Object.keys(layer.pivot).some(x => !['x', 'y'].includes(x)) || !['x', 'y'].every(x => typeof layer.pivot[x] === 'number' && Number.isFinite(layer.pivot[x]) && layer.pivot[x] >= 0 && layer.pivot[x] <= recipe.canvasSize)) fail('Wing pivots must be inside the canvas.');
        scene[key].pivot = { x: layer.pivot.x, y: layer.pivot.y };
      } else if (layer.pivot) fail('Body alignment is fixed at the canvas centre.');
    }
    scenes[direction] = scene;
  }
  return scenes;
}
function composedSvg(recipe, scene, phase = null, embedded = null) {
  const wing = (layer, near) => {
    if (!layer) return '';
    const angle = phase === null ? 0 : PHASES[phase] * (near ? 1 : -1);
    const p = layer.pivot;
    return `<g transform="translate(${p.x} ${p.y}) rotate(${angle}) translate(${-p.x} ${-p.y})">${layer.svg}</g>`;
  };
  const content = embedded ? `<image x="0" y="0" width="${recipe.canvasSize}" height="${recipe.canvasSize}" href="data:image/png;base64,${embedded.toString('base64')}"/>` : wing(scene.wingFar, false) + scene.body.svg + wing(scene.wingNear, true);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${recipe.canvasSize}" height="${recipe.canvasSize}" viewBox="0 0 ${recipe.canvasSize} ${recipe.canvasSize}"><g fill="${recipe.palette[0]}">${content}</g></svg>`;
}
function checkVersion(project, version) { if (!Number.isInteger(version) || project.version !== version) fail('This sprite project changed. Reload it before continuing.'); }

class SpriteStudio {
  constructor({ root, rasterize }) { this.root = noLinks(root, true); this.rasterize = rasterize; this.pending = 0; }
  projectDir(projectId) { return noLinks(path.join(this.root, checkedId(projectId))); }
  _file(projectId, relative) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(x => !x || x === '.' || x === '..')) fail('Invalid Sprite Studio asset path.');
    const base = this.projectDir(projectId), file = path.resolve(base, relative);
    if (!contained(base, file)) fail('Sprite Studio path escaped its project.');
    return noLinks(file);
  }
  _read(projectId) {
    const project = JSON.parse(readRegular(path.join(this.projectDir(projectId), 'project.json'), 2000000).toString('utf8'));
    if (!plain(project) || project.id !== projectId || !Number.isInteger(project.version) || project.version < 1 || !Array.isArray(project.candidates) || project.candidates.length > 24 || !Array.isArray(project.references) || project.references.length > 6 || !plain(project.approved)) fail('Invalid Sprite Studio project.');
    project.recipe = validateRecipe(project.recipe);
    const ids = new Set();
    for (const candidate of project.candidates) {
      checkedId(candidate.id); if (ids.has(candidate.id) || !plain(candidate.directions) || !['generated', 'imported'].includes(candidate.source)) fail('Invalid sprite candidate.'); ids.add(candidate.id);
      for (const [direction, art] of Object.entries(candidate.directions)) {
        if (!DIRECTIONS.includes(direction) || !plain(art) || !Array.isArray(art.frames) || art.frames.length > 8 || !Array.isArray(art.warnings)) fail('Invalid sprite candidate assets.');
        const prefix = `candidates/${candidate.id}/`;
        if (art.preview !== prefix + direction + '-preview.png' || art.frames.some((value, i) => value !== prefix + direction + `/frame-${i + 1}.png`)) fail('Invalid sprite candidate path.');
        if (!/^[a-f0-9]{64}$/.test(art.previewHash) || !Array.isArray(art.frameHashes) || art.frameHashes.length !== art.frames.length || art.frameHashes.some(value => !/^[a-f0-9]{64}$/.test(value))) fail('Invalid sprite candidate integrity hashes.');
        this._file(projectId, art.preview); for (const frame of art.frames) this._file(projectId, frame);
      }
    }
    for (const [direction, candidateId] of Object.entries(project.approved)) {
      if (!DIRECTIONS.includes(direction) || !ids.has(candidateId) || !project.candidates.find(c => c.id === candidateId).directions[direction]) fail('Invalid approved sprite direction.');
    }
    for (const reference of project.references) { checkedId(reference.id); if (reference.path !== `references/${reference.id}.png` || !/^[a-f0-9]{64}$/.test(reference.hash)) fail('Invalid sprite reference path.'); this._file(projectId, reference.path); }
    return project;
  }
  read(projectId) { return clone(this._read(checkedId(projectId))); }
  list() {
    noLinks(this.root);
    const entries = fs.readdirSync(this.root, { withFileTypes: true });
    return entries.filter(x => x.isDirectory() && ID.test(x.name)).map(entry => {
      const project = this._read(entry.name), approvedDirection = DIRECTIONS.find(x => project.approved[x]), candidate = approvedDirection && project.candidates.find(x => x.id === project.approved[approvedDirection]);
      const latest = project.candidates.at(-1);
      return { id: project.id, name: project.recipe.name, kind: project.recipe.kind, updatedAt: project.updatedAt, approvedCount: Object.keys(project.approved).length, preview: candidate?.directions[approvedDirection]?.preview || (latest && Object.values(latest.directions)[0]?.preview) || null };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  _save(project) { atomicWrite(path.join(this.projectDir(project.id), 'project.json'), Buffer.from(JSON.stringify(project, null, 2))); return clone(project); }
  _changed(project) { project.version++; project.updatedAt = new Date().toISOString(); }
  _verifyArt(projectId, art) {
    if (hash(readRegular(this._file(projectId, art.preview))) !== art.previewHash || art.frames.some((frame, index) => hash(readRegular(this._file(projectId, frame))) !== art.frameHashes[index])) fail('Sprite candidate artwork changed outside Sprite Studio. Import or generate a new candidate before approval or export.');
  }
  create(recipe) {
    recipe = validateRecipe(recipe); if (this.list().length >= 100) fail('Sprite Studio supports up to 100 projects.');
    const now = new Date().toISOString(), project = { id: id(), version: 1, createdAt: now, updatedAt: now, recipe, references: [], candidates: [], approved: {} };
    noLinks(this.projectDir(project.id), true);
    try { this._saveManifest(project); return this._save(project); }
    catch (error) { const directory = this.projectDir(project.id); if (contained(this.root, directory)) fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }
  _saveManifest(project) {
    const recipe = project.recipe;
    const manifest = { schemaVersion: 1, projectId: project.id, kind: recipe.kind === 'bird' ? 'odyssey_bird_directional_flight' : 'pawn_directional', transparent: true, canvas: [recipe.canvasSize, recipe.canvasSize], directions: DIRECTIONS, mirrorWest: true, palette: recipe.palette, anchor: [0.5, 0.5], groundedDrawSize: recipe.groundedDrawSize, textureName: recipe.textureName, brief: recipe.brief, camera: 'RimWorld orthographic directional game texture', forbid: ['background', 'floor', 'text', 'baked ground shadow', 'scenic perspective'], ...(recipe.kind === 'bird' ? { flightDrawSize: recipe.drawSize, framesPerDirection: 8, ticksPerFrame: recipe.ticksPerFrame, gameLoopTicks: 9 * recipe.ticksPerFrame, layers: ['fixed body', 'near wing', 'far wing'], export: '24 numbered full-body flight PNGs plus 3 grounded PNGs; west mirrors east' } : { export: '3 grounded PNGs; west mirrors east' }), evidence: { generated: 'candidate', approved: 'human approved artwork', exported: 'asset_present', gameVisualTest: 'pending; no load/runtime/visual test performed' } };
    atomicWrite(path.join(this.projectDir(project.id), 'ASSETS-NEEDED.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
  }
  saveRecipe(projectId, recipe, version) {
    const project = this._read(projectId); checkVersion(project, version); recipe = validateRecipe(recipe);
    if (project.candidates.length && ['kind', 'palette', 'canvasSize', 'frameCount', 'ticksPerFrame', 'drawSize', 'groundedDrawSize', 'textureName'].some(key => JSON.stringify(recipe[key]) !== JSON.stringify(project.recipe[key]))) fail('Canvas, palette, preset, timing, grounded/flight draw sizes and texture name are locked once artwork exists. Create a new sprite project for these changes.');
    const previous = clone(project.recipe); project.recipe = recipe; this._changed(project);
    try { this._saveManifest(project); return this._save(project); }
    catch (error) { project.recipe = previous; try { this._saveManifest(project); } catch {} throw error; }
  }
  async _render(svg, canvasSize) {
    if (typeof this.rasterize !== 'function') fail('The sprite renderer is unavailable.');
    const result = await this.rasterize(svg, { fitTo: { mode: 'width', value: canvasSize } });
    const info = pngInfo(result.png); if (info.width !== canvasSize || info.height !== canvasSize || result.width !== canvasSize || result.height !== canvasSize) fail('The sprite renderer returned the wrong canvas size.');
    if (!info.visible) fail('The sprite renderer returned an empty image. Check the imported PNG or sprite geometry.');
    return info.bytes;
  }
  async importPng(projectId, direction, filename, version) {
    const project = this._read(projectId); checkVersion(project, version);
    if (!DIRECTIONS.includes(direction) && direction !== 'reference') fail('Invalid sprite import direction.');
    const imported = pngInfo(readRegular(path.resolve(filename)), true);
    if (direction === 'reference') {
      if (project.references.length >= 6) fail('Use up to six sprite reference images.');
      const referenceId = id(), relative = `references/${referenceId}.png`, file = this._file(projectId, relative), referenceCanvas = Math.min(1024, Math.max(imported.width, imported.height));
      const normalized = await this._render(composedSvg({ ...project.recipe, canvasSize: referenceCanvas }, null, null, imported.bytes), referenceCanvas);
      atomicWrite(file, normalized);
      try { const current = this._read(projectId); checkVersion(current, version); current.references.push({ id: referenceId, name: path.basename(filename).slice(0, 120), path: relative, hash: hash(normalized), sourceHash: hash(imported.bytes) }); this._changed(current); return this._save(current); }
      catch (error) { fs.unlinkSync(file); throw error; }
    }
    if (project.candidates.length >= 24) fail('This project has 24 candidates. Create a new sprite project to continue.');
    const png = await this._render(composedSvg(project.recipe, null, null, imported.bytes), project.recipe.canvasSize);
    const candidateId = id(), relative = `candidates/${candidateId}/${direction}-preview.png`, file = this._file(projectId, relative);
    atomicWrite(file, png);
    try {
      const current = this._read(projectId); checkVersion(current, version);
      current.candidates.push({ id: candidateId, createdAt: new Date().toISOString(), model: 'Imported PNG', source: 'imported', directions: { [direction]: { preview: relative, previewHash: hash(png), frames: [], frameHashes: [], hasWingRig: false, warnings: [...pngInfo(png).warnings, ...(project.recipe.kind === 'bird' ? ['A flat PNG has no wing rig. Generate layered wings before exporting Odyssey flight.'] : [])] } } });
      this._changed(current); return this._save(current);
    } catch (error) { this._removeCandidate(projectId, candidateId); throw error; }
  }
  prepareGeneration(projectId, directions, instruction, version) {
    const project = this._read(projectId); checkVersion(project, version); directions = validateDirections(directions);
    if (project.candidates.length >= 24) fail('This project has 24 candidates. Create a new sprite project to continue.');
    if (typeof instruction !== 'string' || instruction.length > 12000) fail('Keep revision instructions under 12,000 characters.');
    const approvedPaths = DIRECTIONS.flatMap(direction => { const candidate = project.candidates.find(x => x.id === project.approved[direction]); if (!candidate) return []; this._verifyArt(projectId, candidate.directions[direction]); return [this._file(projectId, candidate.directions[direction].preview)]; });
    const referencePaths = project.references.map(reference => { const file = this._file(projectId, reference.path); if (hash(readRegular(file)) !== reference.hash) fail('A sprite reference changed. Reimport it before generation.'); return file; });
    const prompt = `Create one consistent RimWorld sprite identity, using the attached approved views and references.\nProject recipe: ${JSON.stringify(project.recipe)}\nRequested directions: ${directions.join(', ')}.\nRevision: ${instruction}\nPreserve species identity, palette, outline width, anatomical proportions and markings across directions. Keep the body/head/tail at the same anchor across frames. Use the exact square canvas, transparent background, orthographic game perspective, no floor, text, shadow or scenery.\nReturn only JSON {"directions":{"south":{"body":{"svg":"<path .../>"},"wingNear":{"svg":"...","pivot":{"x":64,"y":64}},"wingFar":{"svg":"...","pivot":{"x":64,"y":64}}}}} with exactly the requested direction keys. Body must be the full fixed torso/head/tail/feet artwork. ${project.recipe.kind === 'bird' ? 'Both wing layers are required. Wings must be separate absolute canvas-space shapes with shoulder pivots; they are animated deterministically while the body stays unchanged.' : 'Wing layers are optional for a static sprite.'}\nSVG fragments may contain only g/path/rect/circle/ellipse/line/polyline/polygon shapes, safe geometry transforms, fill/stroke from the project palette or none, bounded numeric attributes and opacity. No outer svg, images, text, scripts, links, CSS, use, comments, entities or external files.\nWest flight will mirror east. Do not redraw or output numbered frames yourself.`;
    return { project: clone(project), prompt, referencePaths, approvedPaths, version: project.version };
  }
  _removeCandidate(projectId, candidateId) { const directory = this._file(projectId, `candidates/${checkedId(candidateId)}`); if (fs.existsSync(directory)) { noLinks(directory); fs.rmSync(directory, { recursive: true, force: true }); } }
  async saveGeneration(projectId, response, model, directions, version, signal) {
    if (this.pending >= 2) fail('Two sprite render jobs are already running.');
    const project = this._read(projectId); checkVersion(project, version); directions = validateDirections(directions);
    if (project.candidates.length >= 24) fail('This project has 24 candidates.');
    const scenes = parseResponse(response, directions, project.recipe), candidateId = id(), candidate = { id: candidateId, createdAt: new Date().toISOString(), model: String(model).slice(0, 160), source: 'generated', directions: {} };
    const stop = () => { if (signal?.aborted) fail('Sprite generation was cancelled.'); };
    this.pending++;
    try {
      stop();
      for (const direction of directions) {
        stop(); const scene = scenes[direction], rig = !!(scene.wingNear && scene.wingFar), prefix = `candidates/${candidateId}/`, preview = prefix + direction + '-preview.png', frames = [], frameHashes = [];
        const previewPng = await this._render(composedSvg(project.recipe, scene), project.recipe.canvasSize), warnings = new Set(pngInfo(previewPng).warnings);
        atomicWrite(this._file(projectId, preview), previewPng);
        if (project.recipe.kind === 'bird' && rig) {
          for (let phase = 0; phase < 8; phase++) { stop(); const relative = prefix + direction + `/frame-${phase + 1}.png`, framePng = await this._render(composedSvg(project.recipe, scene, phase), project.recipe.canvasSize); for (const warning of pngInfo(framePng).warnings) warnings.add(warning); atomicWrite(this._file(projectId, relative), framePng); frames.push(relative); frameHashes.push(hash(framePng)); }
        }
        candidate.directions[direction] = { preview, previewHash: hash(previewPng), frames, frameHashes, hasWingRig: rig, warnings: [...warnings, ...(project.recipe.kind === 'bird' && !rig ? ['Both separate wing layers are required before Odyssey flight export.'] : [])] };
      }
      stop();
      atomicWrite(this._file(projectId, `candidates/${candidateId}/scenes.json`), Buffer.from(JSON.stringify({ scenes, bodyHashes: Object.fromEntries(directions.map(direction => [direction, hash(scenes[direction].body.svg)])) })));
      const current = this._read(projectId); checkVersion(current, version); current.candidates.push(candidate); this._changed(current); return this._save(current);
    } catch (error) { this._removeCandidate(projectId, candidateId); throw error; }
    finally { this.pending--; }
  }
  approve(projectId, candidateId, directions, version) {
    const project = this._read(projectId); checkVersion(project, version); directions = validateDirections(directions);
    const candidate = project.candidates.find(x => x.id === checkedId(candidateId));
    if (!candidate || directions.some(direction => !candidate.directions[direction])) fail('The candidate does not contain all selected directions.');
    for (const direction of directions) { this._verifyArt(projectId, candidate.directions[direction]); project.approved[direction] = candidateId; }
    this._changed(project); return this._save(project);
  }
  planExport(projectId, modRoot, version) {
    const project = this._read(projectId); checkVersion(project, version);
    modRoot = noLinks(path.resolve(modRoot)); if (!fs.statSync(modRoot).isDirectory() || contained(this.root, modRoot) || contained(modRoot, this.root)) fail('Choose a separate mod directory for sprite export.');
    const exports = [], texture = project.recipe.textureName, base = `Textures/Things/Pawn/Animal/${texture}/`;
    for (const direction of DIRECTIONS) {
      const candidate = project.candidates.find(x => x.id === project.approved[direction]), art = candidate?.directions[direction];
      if (!art) fail('Approve south, east and north artwork before export.');
      this._verifyArt(projectId, art);
      if (project.recipe.kind === 'bird' && (!art.hasWingRig || art.frames.length !== 8 || candidate.source !== 'generated')) fail('Approve layered wing rigs and eight flight frames in every direction before exporting Odyssey birds.');
      exports.push({ relative: base + texture + '_' + direction + '.png', source: this._file(projectId, art.preview) });
      if (project.recipe.kind === 'bird') for (let frame = 0; frame < 8; frame++) exports.push({ relative: base + texture + '_Flying_' + (frame + 1) + '_' + direction + '.png', source: this._file(projectId, art.frames[frame]) });
    }
    for (const entry of exports) {
      const source = pngInfo(readRegular(entry.source)); if (source.width !== project.recipe.canvasSize || source.height !== project.recipe.canvasSize) fail('A sprite candidate canvas changed.');
      entry.hash = hash(source.bytes); entry.bytes = source.bytes.length;
      const target = noLinks(path.join(modRoot, entry.relative));
      entry.previousHash = fs.existsSync(target) ? hash(readRegular(target)) : null;
    }
    const pathRoot = `Things/Pawn/Animal/${texture}/${texture}`, flight = project.recipe.kind === 'bird' ? `\n  <flyingAnimationFramePathPrefix>${pathRoot}_Flying_</flyingAnimationFramePathPrefix>\n  <flyingAnimationFrameCount>8</flyingAnimationFrameCount>\n  <flyingAnimationTicksPerFrame>${project.recipe.ticksPerFrame}</flyingAnimationTicksPerFrame>\n  <flyingAnimationDrawSize>${project.recipe.drawSize}</flyingAnimationDrawSize>\n  <flyingAnimationDrawSizeIsMultiplier>false</flyingAnimationDrawSizeIsMultiplier>\n  <flyingAnimationInheritColors>false</flyingAnimationInheritColors>` : '';
    const xml = `<!-- Merge into your animal PawnKindDef after checking its parent and life stages. -->\n<PawnKindDef>${flight}\n  <lifeStages>\n    <li>\n      <bodyGraphicData>\n        <texPath>${pathRoot}</texPath>\n        <drawSize>${project.recipe.groundedDrawSize}</drawSize>\n      </bodyGraphicData>\n    </li>\n  </lifeStages>\n</PawnKindDef>`;
    return { rows: exports.map(entry => ({ path: entry.relative, action: entry.previousHash ? 'replace' : 'create', bytes: entry.bytes })), xml, warnings: ['Artwork and XML have not been load, runtime or visually tested in RimWorld.', ...(project.recipe.kind === 'bird' ? ['Odyssey flight mirrors east for west. Check animation, grounded pose and flight draw size in game.'] : [])], internal: { projectId, version, modRoot, exports } };
  }
  applyExport(plan, backupRoot) {
    const internal = plan?.internal; if (!internal || !Array.isArray(internal.exports) || internal.exports.length > 27) fail('Invalid sprite export plan.');
    const project = this._read(internal.projectId); checkVersion(project, internal.version);
    const modRoot = noLinks(internal.modRoot), safeBackupRoot = noLinks(path.resolve(backupRoot));
    if (contained(modRoot, safeBackupRoot) || contained(safeBackupRoot, modRoot)) fail('Sprite backups must be outside the mod directory.');
    const allowedBase = `Textures/Things/Pawn/Animal/${project.recipe.textureName}/`, records = [];
    for (const entry of internal.exports) {
      if (typeof entry.relative !== 'string' || !entry.relative.startsWith(allowedBase) || !/^[A-Za-z0-9_]+\.png$/.test(entry.relative.slice(allowedBase.length))) fail('Invalid export filename.');
      const target = noLinks(path.join(modRoot, entry.relative)); if (!contained(modRoot, target)) fail('Sprite export escaped its mod.');
      const source = noLinks(entry.source); if (!contained(this.projectDir(project.id), source)) fail('Invalid sprite export source.');
      const bytes = pngInfo(readRegular(source)).bytes; if (hash(bytes) !== entry.hash) fail('Sprite artwork changed after export review. Review it again.');
      const before = fs.existsSync(target) ? readRegular(target) : null;
      if ((before ? hash(before) : null) !== entry.previousHash) fail('A target texture changed after export review. Review it again.');
      records.push({ target, relative: entry.relative, bytes, before });
    }
    let backup = null;
    if (records.some(record => record.before)) {
      noLinks(safeBackupRoot, true);
      backup = path.join(safeBackupRoot, id()); noLinks(backup, true);
      for (const record of records) if (record.before) atomicWrite(path.join(backup, record.relative), record.before);
      atomicWrite(path.join(backup, 'receipt.json'), Buffer.from(JSON.stringify({ projectId: project.id, createdAt: new Date().toISOString(), modRoot, files: records.filter(x => x.before).map(x => ({ path: x.relative, hash: hash(x.before) })) }, null, 2)));
    }
    const written = [];
    try {
      for (const record of records) {
        noLinks(record.target); const current = fs.existsSync(record.target) ? readRegular(record.target) : null;
        if ((current ? hash(current) : null) !== (record.before ? hash(record.before) : null)) fail('A target texture changed during export.');
        atomicWrite(record.target, record.bytes); written.push(record);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const record of written.reverse()) {
        try { noLinks(record.target); if (record.before) atomicWrite(record.target, record.before); else fs.unlinkSync(record.target); }
        catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      if (rollbackErrors.length) fail(`Export failed (${error.message}). Restore the retained backup at ${backup || safeBackupRoot}; rollback could not restore every file: ${rollbackErrors.join('; ')}`);
      throw error;
    }
    return { files: records.length, backup };
  }
}

module.exports = { SpriteStudio, validateRecipe, validateFragment, parseResponse, composedSvg, pngInfo };
