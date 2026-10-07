'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const DIRECTIONS = ['south', 'east', 'north'];
const BODY_TYPES = ['Male', 'Female', 'Thin', 'Fat', 'Hulk'];
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
function getSlots(recipe = { kind: 'sprite' }) {
  if (recipe.kind === 'apparel') return ['item', ...BODY_TYPES.flatMap(type => DIRECTIONS.map(direction => type + '_' + direction))];
  if (recipe.kind === 'hat') return ['item', ...DIRECTIONS];
  if (recipe.kind === 'building' || recipe.kind === 'furniture') return recipe.graphicMode === 'single' ? ['item'] : [...DIRECTIONS, 'west'];
  if (recipe.kind === 'sprite' || recipe.kind === 'bird') return [...DIRECTIONS];
  fail('Invalid sprite preset.');
}
function validateDirections(value, recipe) {
  const slots = getSlots(recipe);
  if (!Array.isArray(value) || !value.length || value.length > slots.length || value.some(x => !slots.includes(x)) || new Set(value).size !== value.length) fail('Choose distinct artwork slots from this sprite profile.');
  return slots.filter(x => value.includes(x));
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
  if (!['sprite', 'bird', 'apparel', 'hat', 'building', 'furniture'].includes(recipe.kind)) fail('Invalid sprite preset.');
  if (recipe.brief.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(recipe.brief)) fail('The sprite brief is too long or contains control characters.');
  // Preserve historical palette metadata without constraining artwork colors.
  recipe.palette = Array.isArray(recipe.palette) && recipe.palette.length >= 2 && recipe.palette.length <= 16 && recipe.palette.every(x => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x)) ? [...new Set(recipe.palette.map(x => x.toLowerCase()))] : ['#000000', '#ffffff'];
  if (recipe.palette.length < 2) recipe.palette = ['#000000', '#ffffff'];
  if (![128, 256, 512].includes(recipe.canvasSize)) fail('Choose a 128, 256, or 512 pixel canvas.');
  if (recipe.frameCount !== (recipe.kind === 'bird' ? 8 : 1)) fail(recipe.kind === 'bird' ? 'Odyssey bird presets use 8 flight frames.' : 'Static sprite presets use one frame.');
  if (!Number.isInteger(recipe.ticksPerFrame) || recipe.ticksPerFrame < 1 || recipe.ticksPerFrame > 30) fail('Ticks per frame must be 1–30.');
  if (typeof recipe.drawSize !== 'number' || !Number.isFinite(recipe.drawSize) || recipe.drawSize < 0.05 || recipe.drawSize > 20) fail('Draw size must be between 0.05 and 20.');
  if (typeof recipe.groundedDrawSize !== 'number' || !Number.isFinite(recipe.groundedDrawSize) || recipe.groundedDrawSize < 0.05 || recipe.groundedDrawSize > 20) fail('Grounded draw size must be between 0.05 and 20.');
  if (typeof recipe.textureName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(recipe.textureName)) fail('Texture name must start with a letter and contain only letters, digits and underscores.');
  if (recipe.kind === 'apparel') {
    recipe.apparelLayer = raw.apparelLayer ?? 'OnSkin'; recipe.apparelCoverage = raw.apparelCoverage ?? 'upper';
    if (!['OnSkin', 'Middle', 'Shell'].includes(recipe.apparelLayer) || !['upper', 'lower', 'full'].includes(recipe.apparelCoverage)) fail('Choose an apparel layer and upper, lower or full body coverage.');
  }
  if (recipe.kind === 'hat') { recipe.hatCoverage = raw.hatCoverage ?? 'upper'; if (!['upper', 'full'].includes(recipe.hatCoverage)) fail('Choose upper-head or full-head hat coverage.'); }
  if (recipe.kind === 'building' || recipe.kind === 'furniture') {
    recipe.graphicMode = raw.graphicMode ?? 'multi'; recipe.footprintX = raw.footprintX ?? 1; recipe.footprintZ = raw.footprintZ ?? 1;
    recipe.drawWidth = raw.drawWidth ?? 1; recipe.drawHeight = raw.drawHeight ?? 1; recipe.rotatable = recipe.graphicMode === 'single' ? false : (raw.rotatable ?? true);
    if (!['single', 'multi'].includes(recipe.graphicMode)) fail('Choose a single or four-direction building graphic.');
    if (![recipe.footprintX, recipe.footprintZ].every(value => Number.isInteger(value) && value >= 1 && value <= 10)) fail('Building footprints must be whole numbers from 1 to 10 tiles.');
    if (![recipe.drawWidth, recipe.drawHeight].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0.05 && value <= 20)) fail('Building draw width and height must be between 0.05 and 20.');
    if (typeof recipe.rotatable !== 'boolean') fail('Building rotation must be enabled or disabled.');
  }
  return recipe;
}
function profileMeta(raw) {
  const recipe = validateRecipe(raw), texture = recipe.textureName, slots = getSlots(recipe);
  const apparel = recipe.kind === 'apparel' || recipe.kind === 'hat', structure = recipe.kind === 'building' || recipe.kind === 'furniture';
  const base = apparel ? `Textures/Things/Pawn/Humanlike/Apparel/${texture}/` : structure ? `Textures/Things/Building/${texture}/` : `Textures/Things/Pawn/Animal/${texture}/`;
  const pathRoot = base.slice('Textures/'.length) + texture;
  const filenames = Object.fromEntries(slots.map(slot => [slot, slot === 'item' ? texture + '.png' : recipe.kind === 'hat' ? texture + '_Worn_' + slot + '.png' : texture + '_' + slot + '.png']));
  const warnings = ['Artwork and XML have not been load, runtime or visually tested in RimWorld.'];
  let xml, description;
  if (apparel) {
    const coverage = recipe.kind === 'hat' ? [recipe.hatCoverage === 'full' ? 'FullHead' : 'UpperHead'] : ({ upper: ['Torso', 'Shoulders'], lower: ['Legs'], full: ['Torso', 'Neck', 'Shoulders', 'Arms', 'Legs'] })[recipe.apparelCoverage];
    const wornPath = pathRoot + (recipe.kind === 'hat' ? '_Worn' : '');
    xml = `<!-- Merge these artwork fields into your existing apparel ThingDef; retain its verified parent, stats, costs and recipes. -->\n<ThingDef>\n  <graphicData>\n    <texPath>${pathRoot}</texPath>\n    <graphicClass>Graphic_Single</graphicClass>\n    <shaderType>Cutout</shaderType>\n    <drawSize>${recipe.drawSize}</drawSize>\n  </graphicData>\n  <apparel>\n    <wornGraphicPath>${wornPath}</wornGraphicPath>\n    <useWornGraphicMask>false</useWornGraphicMask>\n    <developmentalStageFilter>Adult</developmentalStageFilter>\n    <parentTagDef>${recipe.kind === 'hat' ? 'ApparelHead' : 'ApparelBody'}</parentTagDef>\n    <bodyPartGroups>\n${coverage.map(group => `      <li>${group}</li>`).join('\n')}\n    </bodyPartGroups>\n    <layers>\n      <li>${recipe.kind === 'hat' ? 'Overhead' : recipe.apparelLayer}</li>\n    </layers>\n  </apparel>\n</ThingDef>`;
    description = recipe.kind === 'hat' ? 'One inventory PNG plus three worn hat views; west mirrors east.' : 'One inventory PNG plus 15 worn views covering five vanilla adult body types; west mirrors east.';
    warnings.push('Adult vanilla humans only. Check mannequin alignment, worn fit, body coverage and layering in game. Child/Baby and custom race body types are not included.');
  } else if (structure) {
    xml = `<!-- Merge these artwork and footprint fields into your existing building ThingDef; retain its verified parent, stats, costs and behavior. -->\n<ThingDef>\n  <graphicData>\n    <texPath>${pathRoot}</texPath>\n    <graphicClass>Graphic_${recipe.graphicMode === 'single' ? 'Single' : 'Multi'}</graphicClass>\n    <shaderType>Cutout</shaderType>\n    <drawSize>(${recipe.drawWidth},${recipe.drawHeight})</drawSize>\n    <drawRotated>${recipe.graphicMode === 'single' && recipe.rotatable ? 'true' : 'false'}</drawRotated>\n    <allowFlip>false</allowFlip>\n  </graphicData>\n  <size>(${recipe.footprintX},${recipe.footprintZ})</size>\n  <rotatable>${recipe.rotatable ? 'true' : 'false'}</rotatable>\n</ThingDef>`;
    description = recipe.graphicMode === 'single' ? 'One single graphic PNG. Physical footprint and drawn dimensions are separate.' : 'Four explicit north/east/south/west PNGs. Physical footprint and drawn dimensions are separate.';
    warnings.push('Graphics do not add functional building, chair, table or bed behavior. Check footprint, placement, rotation, lighting and any existing interaction cells in game.');
  } else {
    const flight = recipe.kind === 'bird' ? `\n  <flyingAnimationFramePathPrefix>${pathRoot}_Flying_</flyingAnimationFramePathPrefix>\n  <flyingAnimationFrameCount>8</flyingAnimationFrameCount>\n  <flyingAnimationTicksPerFrame>${recipe.ticksPerFrame}</flyingAnimationTicksPerFrame>\n  <flyingAnimationDrawSize>${recipe.drawSize}</flyingAnimationDrawSize>\n  <flyingAnimationDrawSizeIsMultiplier>false</flyingAnimationDrawSizeIsMultiplier>\n  <flyingAnimationInheritColors>false</flyingAnimationInheritColors>` : '';
    xml = `<!-- Merge into your animal PawnKindDef after checking its parent and life stages. -->\n<PawnKindDef>${flight}\n  <lifeStages>\n    <li>\n      <bodyGraphicData>\n        <texPath>${pathRoot}</texPath>\n        <drawSize>${recipe.groundedDrawSize}</drawSize>\n      </bodyGraphicData>\n    </li>\n  </lifeStages>\n</PawnKindDef>`;
    description = recipe.kind === 'bird' ? '24 numbered full-body flight PNGs plus 3 grounded PNGs; west mirrors east.' : '3 grounded PNGs; west mirrors east.';
    if (recipe.kind === 'bird') warnings.push('Odyssey flight mirrors east for west. Check animation, grounded pose and flight draw size in game.');
  }
  return { slots, base, pathRoot, filenames, xml, warnings, description, mirrorWest: !structure, manifestKind: ({ bird: 'odyssey_bird_directional_flight', sprite: 'pawn_directional', apparel: 'vanilla_adult_apparel', hat: 'vanilla_adult_hat', building: 'building_graphic', furniture: 'furniture_graphic' })[recipe.kind] };
}
function outputRows(recipe) {
  const profile = profileMeta(recipe), rows = [];
  for (const slot of profile.slots) {
    rows.push({ slot, relative: profile.base + profile.filenames[slot] });
    if (recipe.kind === 'bird') for (let frame = 0; frame < 8; frame++) rows.push({ slot, frame, relative: profile.base + recipe.textureName + '_Flying_' + (frame + 1) + '_' + slot + '.png' });
  }
  return rows;
}
function active(project) { if (project.archivedAt) fail('This sprite family is archived. Restore it before editing, generating or exporting.'); }
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
      if (key === 'fill' || key === 'stroke') { if (value !== 'none' && !/^#[0-9a-f]{6}$/i.test(value)) fail('SVG paint must use safe #RRGGBB colors or none.'); }
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
  selected = validateDirections(selected, recipe);
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
    if (recipe.kind !== 'bird' && (raw.wingNear || raw.wingFar)) fail('Only Odyssey bird scenes may contain animated wing layers. Static artwork must be one body layer.');
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${recipe.canvasSize}" height="${recipe.canvasSize}" viewBox="0 0 ${recipe.canvasSize} ${recipe.canvasSize}"><g fill="#000000">${content}</g></svg>`;
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
    if (project.archivedAt !== undefined && project.archivedAt !== null && (typeof project.archivedAt !== 'string' || project.archivedAt.length > 64 || !Number.isFinite(Date.parse(project.archivedAt)))) fail('Invalid sprite family archive date.');
    const slots = getSlots(project.recipe);
    const ids = new Set();
    for (const candidate of project.candidates) {
      checkedId(candidate.id); if (ids.has(candidate.id) || !plain(candidate.directions) || !['generated', 'imported'].includes(candidate.source)) fail('Invalid sprite candidate.'); ids.add(candidate.id);
      for (const [direction, art] of Object.entries(candidate.directions)) {
        if (!slots.includes(direction) || !plain(art) || !Array.isArray(art.frames) || art.frames.length > 8 || !Array.isArray(art.warnings) || art.source !== undefined && !['generated', 'imported'].includes(art.source)) fail('Invalid sprite candidate assets.');
        const prefix = `candidates/${candidate.id}/`;
        if (art.preview !== prefix + direction + '-preview.png' || art.frames.some((value, i) => value !== prefix + direction + `/frame-${i + 1}.png`)) fail('Invalid sprite candidate path.');
        if (!/^[a-f0-9]{64}$/.test(art.previewHash) || !Array.isArray(art.frameHashes) || art.frameHashes.length !== art.frames.length || art.frameHashes.some(value => !/^[a-f0-9]{64}$/.test(value))) fail('Invalid sprite candidate integrity hashes.');
        if (art.originCandidateId !== undefined) {
          checkedId(art.originCandidateId);
          const origin = project.candidates.find(item => item.id === art.originCandidateId)?.directions[direction];
          if (!ids.has(art.originCandidateId) || !origin || origin.previewHash !== art.previewHash || JSON.stringify(origin.frameHashes) !== JSON.stringify(art.frameHashes)) fail('Invalid sprite artwork origin.');
        }
        this._file(projectId, art.preview); for (const frame of art.frames) this._file(projectId, frame);
      }
    }
    for (const [direction, candidateId] of Object.entries(project.approved)) {
      if (!slots.includes(direction) || !ids.has(candidateId) || !project.candidates.find(c => c.id === candidateId).directions[direction]) fail('Invalid approved sprite direction.');
    }
    for (const reference of project.references) { checkedId(reference.id); if (reference.path !== `references/${reference.id}.png` || !/^[a-f0-9]{64}$/.test(reference.hash)) fail('Invalid sprite reference path.'); this._file(projectId, reference.path); }
    return project;
  }
  read(projectId) { return clone(this._read(checkedId(projectId))); }
  list() {
    noLinks(this.root);
    const entries = fs.readdirSync(this.root, { withFileTypes: true });
    return entries.filter(x => x.isDirectory() && ID.test(x.name)).map(entry => {
      const project = this._read(entry.name), slots = getSlots(project.recipe), approvedDirection = slots.find(x => project.approved[x]), candidate = approvedDirection && project.candidates.find(x => x.id === project.approved[approvedDirection]);
      const latest = project.candidates.at(-1);
      return { id: project.id, name: project.recipe.name, kind: project.recipe.kind, updatedAt: project.updatedAt, archivedAt: project.archivedAt || null, approvedCount: Object.keys(project.approved).length, requiredCount: slots.length, preview: candidate?.directions[approvedDirection]?.preview || (latest && Object.values(latest.directions)[0]?.preview) || null };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  _save(project) { atomicWrite(path.join(this.projectDir(project.id), 'project.json'), Buffer.from(JSON.stringify(project, null, 2))); return clone(project); }
  _changed(project) { project.version++; project.updatedAt = new Date().toISOString(); }
  _verifyArt(projectId, art) {
    if (hash(readRegular(this._file(projectId, art.preview))) !== art.previewHash || art.frames.some((frame, index) => hash(readRegular(this._file(projectId, frame))) !== art.frameHashes[index])) fail('Sprite candidate artwork changed outside Sprite Studio. Import or generate a new candidate before approval or export.');
  }
  create(recipe) {
    recipe = validateRecipe(recipe); if (this.list().length >= 100) fail('Sprite Studio supports up to 100 projects.');
    const now = new Date().toISOString(), project = { id: id(), version: 1, createdAt: now, updatedAt: now, archivedAt: null, recipe, references: [], candidates: [], approved: {} };
    noLinks(this.projectDir(project.id), true);
    try { this._saveManifest(project); return this._save(project); }
    catch (error) { const directory = this.projectDir(project.id); if (contained(this.root, directory)) fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }
  _saveManifest(project) {
    const recipe = project.recipe, profile = profileMeta(recipe), profileRecipe = clone(recipe); delete profileRecipe.palette;
    const manifest = { schemaVersion: 1, projectId: project.id, kind: profile.manifestKind, transparent: true, canvas: [recipe.canvasSize, recipe.canvasSize], directions: profile.slots, mirrorWest: profile.mirrorWest, colorSource: 'Master/reference artwork and descriptive brief; colors are not restricted to a fixed palette.', anchor: [0.5, 0.5], groundedDrawSize: recipe.groundedDrawSize, textureName: recipe.textureName, brief: recipe.brief, profile: profileRecipe, files: outputRows(recipe).map(row => row.relative), camera: 'RimWorld orthographic directional game texture', forbid: ['background', 'floor', 'text', 'baked ground shadow', 'scenic perspective'], ...(recipe.kind === 'bird' ? { flightDrawSize: recipe.drawSize, framesPerDirection: 8, ticksPerFrame: recipe.ticksPerFrame, gameLoopTicks: 9 * recipe.ticksPerFrame, layers: ['fixed body', 'near wing', 'far wing'] } : {}), export: profile.description, evidence: { generated: 'candidate', approved: 'human approved artwork', exported: 'asset_present', gameVisualTest: 'pending; no load/runtime/visual test performed' } };
    atomicWrite(path.join(this.projectDir(project.id), 'ASSETS-NEEDED.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
  }
  saveRecipe(projectId, recipe, version) {
    const project = this._read(projectId); checkVersion(project, version); active(project); recipe = validateRecipe(recipe);
    if (project.candidates.length && ['kind', 'palette', 'canvasSize', 'frameCount', 'ticksPerFrame', 'drawSize', 'groundedDrawSize', 'textureName', 'apparelLayer', 'apparelCoverage', 'hatCoverage', 'graphicMode', 'footprintX', 'footprintZ', 'drawWidth', 'drawHeight', 'rotatable'].some(key => JSON.stringify(recipe[key]) !== JSON.stringify(project.recipe[key]))) fail('Canvas, preset, timing, draw sizes, native profile settings, historical metadata and texture name are locked once artwork exists. Create a new sprite project for these changes.');
    const previous = clone(project.recipe); project.recipe = recipe; this._changed(project);
    try { this._saveManifest(project); return this._save(project); }
    catch (error) { project.recipe = previous; try { this._saveManifest(project); } catch {} throw error; }
  }
  archive(projectId, archived, version) {
    const project = this._read(projectId); checkVersion(project, version);
    if (typeof archived !== 'boolean') fail('Choose whether to archive or restore this sprite family.');
    project.archivedAt = archived ? new Date().toISOString() : null; this._changed(project); return this._save(project);
  }
  deleteProject(projectId, version) {
    const project = this._read(projectId); checkVersion(project, version); noLinks(this.root);
    const directory = this.projectDir(project.id), relative = path.relative(this.root, directory);
    if (!relative || !ID.test(relative) || !contained(this.root, directory)) fail('Sprite family deletion escaped the owned Studio directory.');
    noLinks(directory); fs.rmSync(directory, { recursive: true, force: false });
  }
  async importMaster(recipe, mode, filename, slot) {
    recipe = validateRecipe(recipe);
    if (!['reference', 'slot'].includes(mode)) fail('Choose a master reference or final artwork slot.');
    if (mode === 'slot') validateDirections([slot], recipe);
    const project = this.create(recipe);
    try { return await this.importPng(project.id, mode === 'reference' ? 'reference' : slot, filename, project.version); }
    catch (error) {
      const directory = this.projectDir(project.id), relative = path.relative(this.root, directory);
      if (!relative || !ID.test(relative) || !contained(this.root, directory)) fail('Master import cleanup escaped the owned Studio directory.');
      noLinks(directory); fs.rmSync(directory, { recursive: true, force: true }); throw error;
    }
  }
  async _render(svg, canvasSize) {
    if (typeof this.rasterize !== 'function') fail('The sprite renderer is unavailable.');
    const result = await this.rasterize(svg, { fitTo: { mode: 'width', value: canvasSize } });
    const info = pngInfo(result.png); if (info.width !== canvasSize || info.height !== canvasSize || result.width !== canvasSize || result.height !== canvasSize) fail('The sprite renderer returned the wrong canvas size.');
    if (!info.visible) fail('The sprite renderer returned an empty image. Check the imported PNG or sprite geometry.');
    return info.bytes;
  }
  async importPng(projectId, direction, filename, version) {
    const project = this._read(projectId); checkVersion(project, version); active(project);
    if (!getSlots(project.recipe).includes(direction) && direction !== 'reference') fail('Invalid sprite import direction.');
    const imported = pngInfo(readRegular(path.resolve(filename)), true);
    if (direction === 'reference') {
      if (project.references.length >= 6) fail('Use up to six sprite reference images.');
      const referenceId = id(), relative = `references/${referenceId}.png`, file = this._file(projectId, relative), referenceCanvas = Math.min(1024, Math.max(imported.width, imported.height));
      const normalized = await this._render(composedSvg({ ...project.recipe, canvasSize: referenceCanvas }, null, null, imported.bytes), referenceCanvas);
      atomicWrite(file, normalized);
      try { const current = this._read(projectId); checkVersion(current, version); active(current); current.references.push({ id: referenceId, name: path.basename(filename).slice(0, 120), path: relative, hash: hash(normalized), sourceHash: hash(imported.bytes) }); this._changed(current); return this._save(current); }
      catch (error) { fs.unlinkSync(file); throw error; }
    }
    if (project.candidates.length >= 24) fail('This project has 24 candidates. Create a new sprite project to continue.');
    const png = await this._render(composedSvg(project.recipe, null, null, imported.bytes), project.recipe.canvasSize);
    const candidateId = id(), relative = `candidates/${candidateId}/${direction}-preview.png`, file = this._file(projectId, relative);
    try {
      atomicWrite(file, png);
      const current = this._read(projectId); checkVersion(current, version); active(current);
      // An import updates one view in the working set. Copy the latest saved
      // views into this immutable revision so separate imports stay together.
      const collected = {};
      for (const slot of getSlots(current.recipe)) {
        if (slot === direction) continue;
        const origin = [...current.candidates].reverse().find(candidate => candidate.directions[slot]);
        if (!origin) continue;
        const art = origin.directions[slot]; this._verifyArt(projectId, art);
        const preview = `candidates/${candidateId}/${slot}-preview.png`, frames = [];
        atomicWrite(this._file(projectId, preview), readRegular(this._file(projectId, art.preview)));
        for (let index = 0; index < art.frames.length; index++) {
          const frame = `candidates/${candidateId}/${slot}/frame-${index + 1}.png`;
          atomicWrite(this._file(projectId, frame), readRegular(this._file(projectId, art.frames[index]))); frames.push(frame);
        }
        collected[slot] = { ...clone(art), preview, frames, source: art.source ?? origin.source, originCandidateId: art.originCandidateId ?? origin.id };
      }
      collected[direction] = { preview: relative, previewHash: hash(png), frames: [], frameHashes: [], hasWingRig: false, source: 'imported', originCandidateId: candidateId, warnings: [...pngInfo(png).warnings, ...(project.recipe.kind === 'bird' ? ['A flat PNG has no wing rig. Generate layered wings before exporting Odyssey flight.'] : [])] };
      current.candidates.push({ id: candidateId, createdAt: new Date().toISOString(), model: 'Imported PNG · collected views', source: 'imported', directions: collected });
      this._changed(current); return this._save(current);
    } catch (error) { this._removeCandidate(projectId, candidateId); throw error; }
  }
  prepareGeneration(projectId, directions, instruction, version) {
    const project = this._read(projectId); checkVersion(project, version); active(project); directions = validateDirections(directions, project.recipe);
    if (project.candidates.length >= 24) fail('This project has 24 candidates. Create a new sprite project to continue.');
    if (typeof instruction !== 'string' || instruction.length > 12000) fail('Keep revision instructions under 12,000 characters.');
    // API compatibility keeps the approvedPaths name; this list also carries
    // saved identity views so an unapproved master or earlier design can guide
    // the next direction without changing its approval status.
    const approvedPaths = [], included = new Set(), covered = new Set();
    const include = art => { this._verifyArt(projectId, art); const file = this._file(projectId, art.preview); if (!included.has(file)) { included.add(file); approvedPaths.push(file); } };
    for (const direction of getSlots(project.recipe)) {
      const candidate = project.candidates.find(x => x.id === project.approved[direction]);
      if (candidate) { include(candidate.directions[direction]); covered.add(direction); }
    }
    for (const direction of getSlots(project.recipe)) {
      if (covered.has(direction)) continue;
      const saved = [...project.candidates].reverse().find(candidate => candidate.directions[direction]);
      if (saved) { include(saved.directions[direction]); covered.add(direction); }
    }
    if (directions.some(direction => !covered.has(direction))) {
      const master = project.candidates.find(candidate => candidate.source === 'imported' && Object.keys(candidate.directions).length);
      if (master) include(Object.values(master.directions)[0]);
    }
    const referencePaths = project.references.map(reference => { const file = this._file(projectId, reference.path); if (hash(readRegular(file)) !== reference.hash) fail('A sprite reference changed. Reimport it before generation.'); return file; });
    const guidance = project.recipe.kind === 'apparel' ? 'Draw the garment alone, without a painted pawn, skin, face or mannequin. Preserve one garment identity across Male/Female/Thin/Fat/Hulk adult body shapes and south/east/north views. The item slot is a separate inventory illustration. Match approved body-type alignment; do not merely stretch one body type into every other.' : project.recipe.kind === 'hat' ? 'Draw the hat alone with no head, face or hair. The item slot is the inventory illustration; south/east/north are worn head-aligned views, independent of body-type suffixes. West mirrors east.' : ['building', 'furniture'].includes(project.recipe.kind) ? 'Draw the structure alone. Keep design, materials, lighting and details consistent across all explicit cardinal views. item means one complete single graphic, not a pawn view. Physical footprint is separate from drawn width/height; horizontal directional views swap the drawn dimensions. Do not invent functional building behavior.' : 'Preserve species identity, anatomy and markings. Keep the body/head/tail at the same anchor across views and animation frames. West mirrors east.';
    const example = { directions: { [directions[0]]: { body: { svg: '<path .../>' }, ...(project.recipe.kind === 'bird' ? { wingNear: { svg: '<path .../>', pivot: { x: project.recipe.canvasSize / 2, y: project.recipe.canvasSize / 2 } }, wingFar: { svg: '<path .../>', pivot: { x: project.recipe.canvasSize / 2, y: project.recipe.canvasSize / 2 } } } : {}) } } };
    const promptRecipe = clone(project.recipe); delete promptRecipe.palette;
    const prompt = `Create one consistent RimWorld artwork family, using the attached saved identity artwork and master references. Saved identity views may be unapproved; use them as visual references without treating them as approved output.\nProject recipe: ${JSON.stringify(promptRecipe)}\nRequested artwork slots: ${directions.join(', ')}.\nRevision: ${instruction}\n${guidance}\nMatch colors from the master/reference artwork and descriptive brief; preserve outline width, materials, proportions and identity. Use the exact square canvas, transparent background, orthographic game perspective, no floor, text, shadow or scenery.\nReturn only JSON following this structure: ${JSON.stringify(example)} with exactly the requested slot keys under directions. The body layer is the complete static artwork for each slot. ${project.recipe.kind === 'bird' ? 'Both wing layers are required. Wings must be separate absolute canvas-space shapes with shoulder pivots; they are animated deterministically while the body stays unchanged. West flight will mirror east. Do not output numbered frames yourself.' : 'Use one body layer only. No wings, masks, animated parts or other layer keys.'}\nSVG fragments may contain only g/path/rect/circle/ellipse/line/polyline/polygon shapes, safe geometry transforms, fill/stroke as any safe #RRGGBB color or none, bounded numeric attributes and opacity. No outer svg, images, text, scripts, links, CSS, use, comments, entities or external files.`;
    return { project: clone(project), prompt, referencePaths, approvedPaths, version: project.version };
  }
  _removeCandidate(projectId, candidateId) { const directory = this._file(projectId, `candidates/${checkedId(candidateId)}`); if (fs.existsSync(directory)) { noLinks(directory); fs.rmSync(directory, { recursive: true, force: true }); } }
  async saveGeneration(projectId, response, model, directions, version, signal, onProgress) {
    if (this.pending >= 2) fail('Two sprite render jobs are already running.');
    const project = this._read(projectId); checkVersion(project, version); active(project); directions = validateDirections(directions, project.recipe);
    if (project.candidates.length >= 24) fail('This project has 24 candidates.');
    const scenes = parseResponse(response, directions, project.recipe), candidateId = id(), candidate = { id: candidateId, createdAt: new Date().toISOString(), model: String(model).slice(0, 160), source: 'generated', directions: {} };
    const stop = () => { if (signal?.aborted) fail('Sprite generation was cancelled.'); };
    const total = directions.reduce((count, direction) => count + (project.recipe.kind === 'bird' && scenes[direction].wingNear && scenes[direction].wingFar ? 9 : 1), 0);
    let completed = 0;
    const progress = (stage, direction, frame) => { stop(); onProgress?.({ stage, completed, total, ...(direction ? { direction, frame } : {}) }); stop(); };
    this.pending++;
    try {
      stop();
      progress('rendering');
      for (const direction of directions) {
        stop(); const scene = scenes[direction], rig = !!(scene.wingNear && scene.wingFar), prefix = `candidates/${candidateId}/`, preview = prefix + direction + '-preview.png', frames = [], frameHashes = [];
        const previewPng = await this._render(composedSvg(project.recipe, scene), project.recipe.canvasSize), warnings = new Set(pngInfo(previewPng).warnings);
        stop();
        atomicWrite(this._file(projectId, preview), previewPng);
        completed++; progress('rendering', direction, null);
        if (project.recipe.kind === 'bird' && rig) {
          for (let phase = 0; phase < 8; phase++) {
            stop();
            const relative = prefix + direction + `/frame-${phase + 1}.png`, framePng = await this._render(composedSvg(project.recipe, scene, phase), project.recipe.canvasSize);
            stop();
            for (const warning of pngInfo(framePng).warnings) warnings.add(warning);
            atomicWrite(this._file(projectId, relative), framePng); frames.push(relative); frameHashes.push(hash(framePng));
            completed++; progress('rendering', direction, phase + 1);
          }
        }
        candidate.directions[direction] = { preview, previewHash: hash(previewPng), frames, frameHashes, hasWingRig: rig, source: 'generated', originCandidateId: candidateId, warnings: [...warnings, ...(project.recipe.kind === 'bird' && !rig ? ['Both separate wing layers are required before Odyssey flight export.'] : [])] };
      }
      stop();
      progress('saving');
      atomicWrite(this._file(projectId, `candidates/${candidateId}/scenes.json`), Buffer.from(JSON.stringify({ scenes, bodyHashes: Object.fromEntries(directions.map(direction => [direction, hash(scenes[direction].body.svg)])) })));
      const current = this._read(projectId); checkVersion(current, version); active(current); current.candidates.push(candidate); this._changed(current); return this._save(current);
    } catch (error) { this._removeCandidate(projectId, candidateId); throw error; }
    finally { this.pending--; }
  }
  approve(projectId, candidateId, directions, version) {
    const project = this._read(projectId); checkVersion(project, version); active(project); directions = validateDirections(directions, project.recipe);
    const candidate = project.candidates.find(x => x.id === checkedId(candidateId));
    if (!candidate || directions.some(direction => !candidate.directions[direction])) fail('The candidate does not contain all selected directions.');
    for (const direction of directions) { this._verifyArt(projectId, candidate.directions[direction]); project.approved[direction] = candidateId; }
    this._changed(project); return this._save(project);
  }
  planExport(projectId, modRoot, version) {
    const project = this._read(projectId); checkVersion(project, version); active(project);
    modRoot = noLinks(path.resolve(modRoot)); if (!fs.statSync(modRoot).isDirectory() || contained(this.root, modRoot) || contained(modRoot, this.root)) fail('Choose a separate mod directory for sprite export.');
    const exports = [], profile = profileMeta(project.recipe);
    for (const direction of profile.slots) {
      const candidate = project.candidates.find(x => x.id === project.approved[direction]), art = candidate?.directions[direction];
      if (!art) fail(`Approve all ${profile.slots.length} required artwork slots before export. Missing: ${direction}.`);
      this._verifyArt(projectId, art);
      if (project.recipe.kind === 'bird' && (!art.hasWingRig || art.frames.length !== 8 || (art.source ?? candidate.source) !== 'generated')) fail('Approve layered wing rigs and eight flight frames in every direction before exporting Odyssey birds.');
      exports.push({ relative: profile.base + profile.filenames[direction], source: this._file(projectId, art.preview) });
      if (project.recipe.kind === 'bird') for (let frame = 0; frame < 8; frame++) exports.push({ relative: profile.base + project.recipe.textureName + '_Flying_' + (frame + 1) + '_' + direction + '.png', source: this._file(projectId, art.frames[frame]) });
    }
    for (const entry of exports) {
      const source = pngInfo(readRegular(entry.source)); if (source.width !== project.recipe.canvasSize || source.height !== project.recipe.canvasSize) fail('A sprite candidate canvas changed.');
      entry.hash = hash(source.bytes); entry.bytes = source.bytes.length;
      const target = noLinks(path.join(modRoot, entry.relative));
      entry.previousHash = fs.existsSync(target) ? hash(readRegular(target)) : null;
    }
    return { rows: exports.map(entry => ({ path: entry.relative, action: entry.previousHash ? 'replace' : 'create', bytes: entry.bytes })), xml: profile.xml, warnings: profile.warnings, internal: { projectId, version, modRoot, exports } };
  }
  applyExport(plan, backupRoot) {
    const internal = plan?.internal; if (!internal || !Array.isArray(internal.exports) || internal.exports.length > 27) fail('Invalid sprite export plan.');
    const project = this._read(internal.projectId); checkVersion(project, internal.version); active(project);
    const modRoot = noLinks(internal.modRoot), safeBackupRoot = noLinks(path.resolve(backupRoot));
    if (contained(modRoot, safeBackupRoot) || contained(safeBackupRoot, modRoot)) fail('Sprite backups must be outside the mod directory.');
    const expectedFiles = new Set(outputRows(project.recipe).map(row => row.relative)), seen = new Set(), records = [];
    if (internal.exports.length !== expectedFiles.size) fail('Invalid sprite export file count.');
    for (const entry of internal.exports) {
      if (typeof entry.relative !== 'string' || !expectedFiles.has(entry.relative) || seen.has(entry.relative)) fail('Invalid export filename.'); seen.add(entry.relative);
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

module.exports = { SpriteStudio, getSlots, validateDirections, profileMeta, validateRecipe, validateFragment, parseResponse, composedSvg, pngInfo };
