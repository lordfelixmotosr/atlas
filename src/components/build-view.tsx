import {useState,useRef,useEffect} from "react";
import {FilesView} from "../atlas/files-view";
import type { Conversation } from '../agent/conversations';
import type { WorkspaceMod } from '../agent/workspace';
import type { ModelOption } from '../agent/models';
import { ChatPanel } from './chat-panel';
import { ModHeader } from './mod-header';
import { AssetsView } from './assets-view';
import { ModSchematicPanel } from './mod-schematic-panel';
import { ModPublishPanel } from './mod-publish-panel';
import { ModDepsPanel } from './mod-deps-panel';
import { ModBuildSidebar, type BuildPanel } from './mod-build-sidebar';
import { SavesView, type RestoreResult } from './saves-view';
import { getGame, resolveGameId } from '../agent/games/registry';

export function BuildView({
  activeMod,
  activeConvo,
  panel,
  onSelectPanel,
  onBack,
  onTest,
  onGeneratePreview,
  onNewChat,
  onSavesRestored,
  onModDeleted,
  busy,
  hasAi,
  availableModels,
  onConnect,
  multiChat,
  chatListRev,
  onSelectChat,
  onNewChatMulti,
  onArchiveChat,
  onUnarchiveChat,
}: {
  activeMod: WorkspaceMod | null;
  activeConvo: Conversation;
  panel: BuildPanel;
  onSelectPanel: (panel: BuildPanel) => void;
  onBack: () => void;
  onTest: () => void;
  onGeneratePreview: () => void;
  onNewChat: () => void;
  onSavesRestored: (result: RestoreResult) => void;
  onModDeleted?: (folder: string) => void;
  busy: boolean;
  hasAi: boolean;
  availableModels: ModelOption[];
  onConnect: () => void;
  multiChat: boolean;
  chatListRev: number;
  onSelectChat: (convo: Conversation) => void;
  onNewChatMulti: () => void;
  onArchiveChat: (id: string) => void;
  onUnarchiveChat: (id: string) => void;
}) {
  const [navigation,setNavigation]=useState(()=>localStorage.getItem('atlas.layout.navigation')!=='closed');
  const [chatWidth,setChatWidth]=useState(()=>Math.max(320,Math.min(700,Number(localStorage.getItem('atlas.layout.chatWidth'))||440)));
  const [chatVisible,setChatVisible]=useState(true);const workspace=useRef<HTMLDivElement>(null);
  useEffect(()=>{localStorage.setItem('atlas.layout.navigation',navigation?'open':'closed')},[navigation]);
  useEffect(()=>{localStorage.setItem('atlas.layout.chatWidth',String(chatWidth))},[chatWidth]);
  const resize=(x:number)=>{const box=workspace.current?.getBoundingClientRect();if(box)setChatWidth(Math.max(320,Math.min(700,box.right-x,box.width-420)))};
  // Pre-scaffold "new mod" chat: no mod yet, no Assets to browse.
  // Force panel='chat' and hide the Assets entry until a mod exists.
  const newModInProgress = !activeMod;

  // Per-game UI gating: the Assets (Textures/Sounds) and Deps (About.xml
  // dependencies) panels are RimWorld-specific. Gate them on the mod's game
  // capabilities so a Minecraft mod doesn't get RimWorld's content panels.
  const caps = activeMod
    ? getGame(resolveGameId(activeMod.prefs.game)).capabilities
    : null;
  const showAssetPanel = !newModInProgress && !!caps?.assetPanel;
  const showDepsPanel = !newModInProgress && !!caps?.depsPanel;
  // Publish target drives the row label (and hides the row for a game that
  // can't publish). RimWorld → Steam Workshop, Minecraft → Modrinth.
  const publishSubtitle =
    caps?.publish === 'modrinth'
      ? 'Send to Modrinth'
      : caps?.publish === 'steam-workshop'
        ? 'Send to Steam Workshop'
        : undefined;
  // Coerce an unavailable panel back to chat (e.g. a Minecraft mod whose stored
  // panel is a RimWorld-only one) so the content area never renders blank.
  const effectivePanel: BuildPanel =
    newModInProgress ||
    (panel === 'assets' && !showAssetPanel) ||
    (panel === 'deps' && !showDepsPanel)
      ? 'chat'
      : panel;

  return (
    <div className="atlas-workspace flex min-h-0 flex-1" ref={workspace}>
      <div className="atlas-navigation-toggle"><button className="atlas-icon-button" title={navigation?"Collapse navigation":"Expand navigation"} aria-label={navigation?"Collapse navigation":"Expand navigation"} onClick={()=>setNavigation(v=>!v)}>{navigation?"‹":"›"}</button></div>
      <div className={navigation?"atlas-navigation":"hidden"}>
      <ModBuildSidebar
        mod={activeMod}
        convo={activeConvo}
        panel={effectivePanel}
        onSelectPanel={onSelectPanel}
        onBack={onBack}
        showAssets={!newModInProgress}
        showAssetPanel={showAssetPanel}
        showDepsPanel={showDepsPanel}
        publishSubtitle={publishSubtitle}
        onNewChat={newModInProgress ? undefined : onNewChat}
        multiChat={multiChat}
        chatListRev={chatListRev}
        onSelectChat={onSelectChat}
        onNewChatMulti={onNewChatMulti}
        onArchiveChat={onArchiveChat}
        onUnarchiveChat={onUnarchiveChat}
      />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {activeMod && (
          <ModHeader
            mod={activeMod}
            conversationId={activeConvo.id}
            busy={busy}
            onTest={onTest}
            hasAi={hasAi}
          />
        )}
        <div className="atlas-workspace-toolbar"><span>{effectivePanel==='chat'?'Project workspace':effectivePanel==='files'?'File editor':effectivePanel[0].toUpperCase()+effectivePanel.slice(1)}</span><button className="atlas-button" disabled={!activeMod} onClick={()=>setChatVisible(v=>!v)}>{chatVisible?'Hide chat':'Show chat'}</button></div>
        <div className="atlas-workspace-body">
        <div className="atlas-center-pane">
        {activeMod&&<div className={effectivePanel==='files'||effectivePanel==='chat'?'flex flex-1 min-h-0 min-w-0':'hidden'}><FilesView mod={activeMod} busy={busy}/></div>}
        {effectivePanel === 'schematic' && activeMod && (
          <ModSchematicPanel mod={activeMod} />
        )}
        {effectivePanel === 'assets' && activeMod && (
          <AssetsView mod={activeMod} />
        )}
        {effectivePanel === 'deps' && activeMod && (
          <ModDepsPanel mod={activeMod} />
        )}
        {effectivePanel === 'saves' && activeMod && (
          <SavesView mod={activeMod} onRestored={onSavesRestored} />
        )}
        {effectivePanel === 'publish' && activeMod && (
          <ModPublishPanel
            mod={activeMod}
            hasAi={hasAi}
            onGeneratePreview={onGeneratePreview}
            onDeleted={
              onModDeleted ? () => onModDeleted(activeMod.folder) : undefined
            }
          />
        )}
        </div>
        {activeMod&&chatVisible&&<div role="separator" aria-label="Resize chat" aria-orientation="vertical" aria-valuenow={Math.round(chatWidth)} aria-valuemin={320} aria-valuemax={700} tabIndex={0} className="atlas-resize-handle" onKeyDown={e=>{if(e.key==='ArrowLeft'){e.preventDefault();setChatWidth(v=>Math.min(700,v+24))}if(e.key==='ArrowRight'){e.preventDefault();setChatWidth(v=>Math.max(320,v-24))}}} onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))resize(e.clientX)}} onPointerUp={e=>e.currentTarget.releasePointerCapture(e.pointerId)}/>}
        <div className={chatVisible||!activeMod?'atlas-chat-pane':'hidden'} style={activeMod?{width:chatWidth}:undefined}>
          <div className="atlas-pane-heading"><strong>Atlas assistant</strong><span>Steer while working</span></div>
          <ChatPanel
            key={activeConvo.id}
            conversation={activeConvo}
            activeMod={activeMod}
            hasAi={hasAi}
            availableModels={availableModels}
            onConnect={onConnect}
          />
        </div>
        </div>
      </div>
    </div>
  );
}
