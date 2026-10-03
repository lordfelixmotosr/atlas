/**
 * Adapter registry — `getAdapter(game)` is the single dispatch point for
 * per-game behavior, the behavioral counterpart to games/registry.ts's
 * declarative `getGame(game)`. Main-process only (adapters pull in node/electron
 * modules); the renderer gates on `getGame(game).capabilities` instead.
 */
import type { GameId } from '../games/types.js';
import type { GameAdapter } from './types.js';
import { RimWorldAdapter } from '../rimworld/adapter.js';

const ADAPTERS: Partial<Record<GameId, GameAdapter>> = {
  rimworld: RimWorldAdapter,
};

export function getAdapter(game: GameId): GameAdapter {
  const adapter=ADAPTERS[game];
  if(!adapter)throw new Error(`No Atlas adapter is registered for ${game}.`);
  return adapter;
}

export function registerGameAdapter(adapter: GameAdapter): void {
  const id=adapter.def.id;
  if(id==='minecraft')throw new Error('Minecraft integration is excluded.');
  if(ADAPTERS[id])throw new Error(`Adapter ${id} is already registered.`);
  const methods=['isPlaceholderMod','readModMetadata','writeModMetadata','createPlaceholder','buildSystemPrompt','researchTools','build','test'] as const;
  if(methods.some(key=>typeof adapter[key]!=='function')||['getStatus','checkRequirements','rebuild'].some(key=>typeof (adapter.setup as any)?.[key]!=='function')||['ensureAtStartup','ensureForSession','symbolDbReady'].some(key=>typeof (adapter.index as any)?.[key]!=='function')||!adapter.testCycleParams||!adapter.toolText?.testCycle)throw new Error('Atlas game adapter API 1 requires all lifecycle methods.');
  ADAPTERS[id]=adapter;
}

export type {
  GameAdapter,
  BuildModDetails,
  RunTestCycleDetails,
  TestCycleContext,
} from './types.js';
