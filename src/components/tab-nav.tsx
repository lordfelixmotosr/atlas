import { cn } from '@/lib/cn';
import type { GameId } from '../agent/games/types';
import { GameIcon } from './game-icon';
import { useConversationRuntime } from '../conversations-store';

export type AppView = 'mods' | 'library' | 'mod' | 'knowledge' | 'settings';
export interface ModTabDescriptor {
  folder: string;
  conversationId: string;
  title: string;
  game: GameId;
}

export function MainNavigation({view, onNavigate}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
}) {
  const entries = [
    {id: 'mods', label: 'Projects'},
    {id: 'mod', label: 'Workspace'},
    {id: 'knowledge', label: 'Knowledge'},
    {id: 'settings', label: 'Settings'},
  ] as const;
  return <nav className="atlas-main-navigation" aria-label="Main navigation">
    {entries.map(entry => <button key={entry.id}
      aria-current={(view === entry.id || (entry.id === 'mods' && view === 'library')) ? 'page' : undefined}
      onClick={() => onNavigate(entry.id)}>{entry.label}</button>)}
  </nav>;
}

export function ProjectTabs({focusedFolder, tabs, onSelectTab, onCloseTab}: {
  focusedFolder: string | null;
  tabs: ModTabDescriptor[];
  onSelectTab: (folder: string) => void;
  onCloseTab: (folder: string) => void;
}) {
  return <nav className="atlas-project-tabs" aria-label="Open projects">
    {tabs.map(tab => <ModTabButton key={tab.folder} title={tab.title} game={tab.game}
      conversationId={tab.conversationId} active={focusedFolder === tab.folder}
      onSelect={() => onSelectTab(tab.folder)} onClose={() => onCloseTab(tab.folder)}/>)}
  </nav>;
}

/**
 * One open-mod tab. A peer of TabButton — same pill shape and active
 * treatment — but carries the mod's name (rendered in the mono face, like
 * mod names elsewhere), a busy dot, and a close affordance. Subscribes to
 * its own conversation runtime so the dot lights up while that mod's agent
 * works, regardless of which tab is focused.
 */
function ModTabButton({
  title,
  game,
  conversationId,
  active,
  onSelect,
  onClose,
}: {
  title: string;
  game: GameId;
  conversationId: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { busy } = useConversationRuntime(conversationId);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center rounded-md pr-1 transition-colors',
        // One focus ring for the whole pill — only when an inner button is
        // keyboard-focused (the buttons themselves drop their own outline,
        // which would otherwise box just the text+dot sub-region).
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
        active
          ? 'bg-ink text-paper'
          : 'text-muted hover:bg-raised/60 hover:text-ink',
      )}
    >
      <button
        onClick={onSelect}
        title={title}
        aria-label={busy ? `${title}, agent working` : undefined}
        className="flex min-w-0 items-center gap-1.5 py-1 pl-2 focus:outline-none"
      >
        {/* Which game this mod targets — leads the tab so cross-game tabs are
            distinguishable at a glance. */}
        <GameIcon game={game} className="h-3.5 w-3.5" />
        {/* Status dot — accent + pulse while this mod's agent is working
            (mirrors the Library session dot), a dim idle dot otherwise so
            the slot is never empty white space and the tab never changes
            width. */}
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full transition-colors',
            busy ? 'animate-pulse bg-accent' : 'bg-current opacity-40',
          )}
        />
        <span className="max-w-[10rem] truncate font-mono text-xs">
          {title}
        </span>
      </button>
      <button
        onClick={onClose}
        aria-label={`Close ${title}`}
        title={`Close ${title}`}
        className={cn(
          'ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors focus:outline-none',
          active
            ? 'text-paper/50 hover:bg-paper/20 hover:text-paper'
            : 'text-subtle hover:bg-ink/10 hover:text-ink',
        )}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="h-3 w-3"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
