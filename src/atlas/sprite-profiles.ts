import type { SpriteArt, SpriteBodyType, SpriteCandidate, SpriteDirection, SpriteKind, SpriteProject, SpriteRecipe } from './sprite-studio-types';

export const spriteBodyTypes: SpriteBodyType[] = ['Male', 'Female', 'Thin', 'Fat', 'Hulk'];
/** Neutral illustration guides on a 256px canvas, not game mesh measurements. */
export const spriteBodyGuideScales: Record<SpriteBodyType, readonly [number, number]> = { Male: [1, 1], Female: [0.88, 0.97], Thin: [0.76, 1], Fat: [1.26, 1], Hulk: [1.3, 1.08] };
export const spriteGuideBounds = {
  canvas: 256, bodyCenter: [128, 140], torso: [82, 70, 174, 173],
  lower: [82, 154, 174, 224], full: [82, 70, 174, 224], eastWidthScale: 0.62,
  headCenter: [128, 132], headRadius: [45, 58],
  hatUpper: [75, 60, 181, 128], hatFull: [74, 65, 182, 188],
} as const;
export const spriteCompassDirections: SpriteDirection[] = ['south', 'east', 'north'];
export const spriteKindOptions: { value: SpriteKind; label: string }[] = [
  { value: 'bird', label: 'Bird · directional flight' },
  { value: 'sprite', label: 'Pawn · directional artwork' },
  { value: 'apparel', label: 'Apparel · inventory and worn' },
  { value: 'hat', label: 'Hat · inventory and worn' },
  { value: 'building', label: 'Building · world rotations' },
  { value: 'furniture', label: 'Furniture · world rotations' },
];
export function getSpriteKindLabel(kind: SpriteKind): string {
  return ({ bird: 'Bird flight', sprite: 'Pawn sprite', apparel: 'Apparel', hat: 'Hat', building: 'Building', furniture: 'Furniture' } satisfies Record<SpriteKind, string>)[kind];
}
export const spriteTextureDefaults: Record<SpriteKind, string> = { bird: 'NewBird', sprite: 'NewSprite', apparel: 'NewApparel', hat: 'NewHat', building: 'NewBuilding', furniture: 'NewFurniture' };
export function spriteTextureNameForFamily(name: string, kind: SpriteKind): string {
  const ascii = name.trim().replace(/[^A-Za-z0-9_]/g, '');
  return (ascii ? /^[A-Za-z]/.test(ascii) ? ascii : 'Family' + ascii : spriteTextureDefaults[kind]).slice(0, 64);
}
export function getSpriteSlots(recipe: Pick<SpriteRecipe, 'kind' | 'graphicMode'>): SpriteDirection[] {
  if (recipe.kind === 'apparel') return ['item', ...spriteBodyTypes.flatMap(body => spriteCompassDirections.map(direction => `${body}_${direction}` as SpriteDirection))];
  if (recipe.kind === 'hat') return ['item', ...spriteCompassDirections];
  if (recipe.kind === 'building' || recipe.kind === 'furniture') return recipe.graphicMode === 'single' ? ['item'] : [...spriteCompassDirections, 'west'];
  return [...spriteCompassDirections];
}
export function getSpriteSlotLabel(slot: SpriteDirection, recipe?: Pick<SpriteRecipe, 'kind'>): string {
  if (slot === 'item') return recipe?.kind === 'building' || recipe?.kind === 'furniture' ? 'Main texture' : 'Inventory icon';
  const [body, view] = slot.includes('_') ? slot.split('_') : ['', slot];
  const label = ({ south: 'South · front', east: 'East · side', north: 'North · back', west: 'West · side' } as Record<string, string>)[view] ?? view;
  return body ? `${body} · ${label}` : label;
}
export function getVisibleSpriteSlots(recipe: SpriteRecipe, body: SpriteBodyType): SpriteDirection[] {
  return getSpriteSlots(recipe).filter(slot => recipe.kind !== 'apparel' || slot === 'item' || slot.startsWith(body + '_'));
}
export function getMirroredSpriteSlot(recipe: SpriteRecipe, body: SpriteBodyType): SpriteDirection | null {
  if (recipe.kind === 'building' || recipe.kind === 'furniture') return null;
  return recipe.kind === 'apparel' ? `${body}_east` : 'east';
}
export function spriteRecipeForKind(recipe: SpriteRecipe, kind: SpriteKind): SpriteRecipe {
  return {
    ...recipe, kind, frameCount: kind === 'bird' ? 8 : 1,
    groundedDrawSize: kind === 'bird' ? 0.7 : recipe.drawSize,
    apparelLayer: kind === 'apparel' ? 'OnSkin' : undefined,
    apparelCoverage: kind === 'apparel' ? 'upper' : undefined,
    hatCoverage: kind === 'hat' ? 'upper' : undefined,
    graphicMode: kind === 'building' || kind === 'furniture' ? 'multi' : undefined,
    footprintX: kind === 'building' || kind === 'furniture' ? 1 : undefined,
    footprintZ: kind === 'building' || kind === 'furniture' ? 1 : undefined,
    drawWidth: kind === 'building' || kind === 'furniture' ? 1 : undefined,
    drawHeight: kind === 'building' || kind === 'furniture' ? 1 : undefined,
    rotatable: kind === 'building' || kind === 'furniture' ? true : undefined,
  };
}
export function getSpriteGuide(slot: SpriteDirection, recipe: SpriteRecipe): 'body' | 'head' | 'footprint' | null {
  if (recipe.kind === 'building' || recipe.kind === 'furniture') return 'footprint';
  if (slot === 'item') return null;
  if (recipe.kind === 'apparel') return 'body';
  if (recipe.kind === 'hat') return 'head';
  return null;
}

/** A partial revision replaces its own slots and retains earlier working views. */
export function getSpriteCandidateView(project: SpriteProject, candidate: SpriteCandidate | undefined, slot: SpriteDirection): { art: SpriteArt; candidateId: string } | null {
  if (!candidate) return null;
  const own = candidate.directions[slot];
  if (own) return { art: own, candidateId: candidate.id };
  const selectedIndex = project.candidates.findIndex(item => item.id === candidate.id);
  for (let index = selectedIndex - 1; index >= 0; index--) {
    const art = project.candidates[index].directions[slot];
    if (art) return { art, candidateId: project.candidates[index].id };
  }
  return null;
}
export function getSpriteCandidateSnapshot(project: SpriteProject, candidate: SpriteCandidate | undefined): SpriteCandidate | undefined {
  if (!candidate) return candidate;
  const views: Partial<Record<SpriteDirection, SpriteArt>> = { ...candidate.directions };
  for (const slot of getSpriteSlots(project.recipe)) {
    const view = getSpriteCandidateView(project, candidate, slot);
    if (view) views[slot] = view.art;
  }
  return { ...candidate, directions: views };
}
export function isSpriteArtApproved(project: SpriteProject, slot: SpriteDirection, visible?: SpriteArt): boolean {
  if (!visible) return false;
  const saved = project.candidates.find(item => item.id === project.approved[slot])?.directions[slot];
  if (!saved) return false;
  if (saved.previewHash && visible.previewHash) {
    if (saved.previewHash !== visible.previewHash || saved.frames.length !== visible.frames.length) return false;
    if (saved.frameHashes && visible.frameHashes) return JSON.stringify(saved.frameHashes) === JSON.stringify(visible.frameHashes);
  }
  // Old revisions without hashes still share the same immutable file paths.
  return saved.preview === visible.preview && JSON.stringify(saved.frames) === JSON.stringify(visible.frames);
}

export interface SpriteGalleryEntry {
  id: string; slot: SpriteDirection; path: string; kind: 'preview' | 'frame'; frame?: number;
  revisionId: string; revisionIndex: number; originRevisionId: string; originIndex: number;
  source: SpriteCandidate['source']; model: string; createdAt: string; carried: boolean;
}
function artworkOrigin(project: SpriteProject, revision: SpriteCandidate, slot: SpriteDirection, art: SpriteArt): SpriteCandidate {
  const end = project.candidates.findIndex(item => item.id === revision.id);
  if (art.originCandidateId) {
    const explicit = project.candidates.findIndex(item => item.id === art.originCandidateId);
    if (explicit === end) return revision;
    if (explicit >= 0 && explicit < end) {
      const prior = project.candidates[explicit], priorArt = prior.directions[slot];
      return priorArt ? artworkOrigin(project, prior, slot, priorArt) : prior;
    }
  }
  // A genuine generated revision remains a distinct result even if its pixels
  // happen to equal earlier artwork. Legacy flat imports are kept distinct too.
  if (revision.source === 'generated' && art.source !== 'imported' || revision.source === 'imported' && art.source !== 'generated') return revision;
  for (let index = end - 1; index >= 0; index--) {
    const prior = project.candidates[index], priorArt = prior.directions[slot];
    if (priorArt && (priorArt.source ?? prior.source) === (art.source ?? revision.source) && priorArt.frames.length === art.frames.length && (priorArt.previewHash && art.previewHash && priorArt.frameHashes && art.frameHashes ? priorArt.previewHash === art.previewHash && JSON.stringify(priorArt.frameHashes) === JSON.stringify(art.frameHashes) : priorArt.preview === art.preview && JSON.stringify(priorArt.frames) === JSON.stringify(art.frames))) return artworkOrigin(project, prior, slot, priorArt);
  }
  return revision;
}
/** Collect files for a working revision, or unique files across its history. */
export function getSpriteGalleryEntries(project: SpriteProject, selected: SpriteCandidate | undefined, allRevisions = false): SpriteGalleryEntry[] {
  const rows: SpriteGalleryEntry[] = [], seen = new Set<string>();
  const slots = getSpriteSlots(project.recipe), revisions = allRevisions ? project.candidates : selected ? [selected] : [];
  for (const revision of revisions) {
    for (const slot of slots) {
      const view = allRevisions ? revision.directions[slot] ? { art: revision.directions[slot]!, candidateId: revision.id } : null : getSpriteCandidateView(project, revision, slot);
      if (!view) continue;
      const sourceRevision = project.candidates.find(item => item.id === view.candidateId) ?? revision;
      const origin = artworkOrigin(project, sourceRevision, slot, view.art);
      const revisionIndex = project.candidates.findIndex(item => item.id === revision.id) + 1;
      const originIndex = project.candidates.findIndex(item => item.id === origin.id) + 1;
      const files = [{ path: view.art.preview, kind: 'preview' as const, hash: view.art.previewHash }, ...view.art.frames.map((path, index) => ({ path, kind: 'frame' as const, frame: index + 1, hash: view.art.frameHashes?.[index] }))].filter((file, index) => !index || file.path !== view.art.preview);
      for (const file of files) {
        const key = origin.id + ':' + slot + ':' + file.kind + ':' + ('frame' in file ? file.frame : 0);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ ...file, id: key, slot, revisionId: revision.id, revisionIndex, originRevisionId: origin.id, originIndex, source: view.art.source ?? origin.source, model: origin.model, createdAt: origin.createdAt, carried: origin.id !== revision.id });
      }
    }
  }
  return allRevisions ? rows.sort((a, b) => b.originIndex - a.originIndex || slots.indexOf(a.slot) - slots.indexOf(b.slot) || (a.frame ?? 0) - (b.frame ?? 0)) : rows;
}
