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
