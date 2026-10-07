import type { ModelSelection } from '../agent/settings';

export type SpriteBodyType = 'Male' | 'Female' | 'Thin' | 'Fat' | 'Hulk';
export type SpriteDirection = 'south' | 'east' | 'north' | 'west' | 'item' | `${SpriteBodyType}_${'south' | 'east' | 'north'}`;
export type SpriteKind = 'sprite' | 'bird' | 'apparel' | 'hat' | 'building' | 'furniture';
export interface SpriteRecipe {
  name: string;
  kind: SpriteKind;
  brief: string;
  /** Legacy family metadata; colors now come from artwork references and the brief. */
  palette?: string[];
  canvasSize: 128 | 256 | 512;
  frameCount: number;
  ticksPerFrame: number;
  drawSize: number;
  groundedDrawSize?: number;
  textureName: string;
  apparelLayer?: 'OnSkin' | 'Middle' | 'Shell';
  apparelCoverage?: 'upper' | 'lower' | 'full';
  hatCoverage?: 'upper' | 'full';
  graphicMode?: 'single' | 'multi';
  footprintX?: number;
  footprintZ?: number;
  drawWidth?: number;
  drawHeight?: number;
  rotatable?: boolean;
}
export interface SpriteArt {
  preview: string;
  frames: string[];
  previewHash?: string;
  frameHashes?: string[];
  hasWingRig: boolean;
  warnings: string[];
  source?: 'generated' | 'imported';
  /** Original revision for artwork copied into an imported working snapshot. */
  originCandidateId?: string;
}
export interface SpriteCandidate {
  id: string;
  createdAt: string;
  model: string;
  source: 'generated' | 'imported';
  directions: Partial<Record<SpriteDirection, SpriteArt>>;
}
export interface SpriteReference { id: string; name: string; path: string; hash: string }
export interface SpriteProject {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  recipe: SpriteRecipe;
  references: SpriteReference[];
  candidates: SpriteCandidate[];
  approved: Partial<Record<SpriteDirection, string>>;
  archivedAt?: string | null;
}
export interface SpriteProjectSummary {
  id: string; name: string; kind: SpriteKind; updatedAt: string;
  approvedCount: number; preview: string | null; requiredCount?: number; archivedAt?: string | null;
}
export interface SpriteGeneration {
  projectId: string;
  version: number;
  directions: SpriteDirection[];
  instruction: string;
  model: ModelSelection | null;
}
/** Counts completed work in the current stage; model reply time is indeterminate. */
export interface SpriteGenerationProgress {
  stage: 'preparing' | 'designing' | 'rendering' | 'saving' | 'complete';
  completed: number;
  total: number;
  direction?: SpriteDirection;
  /** null means the standing/static preview; flight frames use 1 through 8. */
  frame?: number | null;
}
export interface SpriteLayer { svg: string; pivot?: { x: number; y: number } }
export interface SpriteScene {
  body: SpriteLayer;
  wingNear?: SpriteLayer;
  wingFar?: SpriteLayer;
}
/** Model response: SVG fragments only, validated before any rendering or saving. */
export interface SpriteSceneResponse { directions: Partial<Record<SpriteDirection, SpriteScene>> }
export interface SpriteExportRow { path: string; action: 'create' | 'replace'; bytes: number }
export interface SpriteExportPlan {
  token: string;
  rows: SpriteExportRow[];
  xml: string;
  warnings: string[];
}
export interface SpriteStudioApi {
  spriteList: () => Promise<SpriteProjectSummary[]>;
  spriteCreate: (recipe: SpriteRecipe) => Promise<SpriteProject>;
  spriteCreateFromMaster: (recipe: SpriteRecipe, mode: 'reference' | 'slot', slot?: SpriteDirection) => Promise<SpriteProject | null>;
  spriteRead: (id: string) => Promise<SpriteProject>;
  spriteSaveRecipe: (id: string, recipe: SpriteRecipe, version: number) => Promise<SpriteProject>;
  spriteImport: (id: string, direction: SpriteDirection | 'reference', version: number) => Promise<SpriteProject | null>;
  spriteGenerate: (request: SpriteGeneration) => Promise<SpriteProject>;
  spriteCancel: (id: string) => Promise<void>;
  spriteApprove: (id: string, candidateId: string, directions: SpriteDirection[], version: number) => Promise<SpriteProject>;
  spriteExportPlan: (id: string, folder: string, version: number) => Promise<SpriteExportPlan>;
  spriteExportApply: (token: string) => Promise<{ files: number; backup: string | null }>;
  spriteReveal: (id: string) => Promise<void>;
  spriteArchive: (id: string, archived: boolean, version: number) => Promise<SpriteProject>;
  spriteDelete: (id: string, version: number) => Promise<void>;
}
export function spriteAssetUrl(id: string, relative: string): string {
  return `modmixer-asset://studio/${encodeURIComponent(id)}/${encodeURIComponent(relative)}`;
}
