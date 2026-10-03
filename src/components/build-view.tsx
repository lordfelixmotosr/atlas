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
  const [chatWidth,setChatWidth]=useState(()=>Math.max(320,Number(localStorage.getItem('atlas.layout.chatWidth'))||440));
  const [chatVisible,setChatVisible]=useState(true);
  const [editorVisible,setEditorVisible]=useState(()=>localStorage.getItem('atlas.layout.editor')!=='closed');
  const [filesVisible,setFilesVisible]=useState(()=>localStorage.getItem('atlas.layout.files')!=='closed');
  const workspace=useRef<HTMLDivElement>(null),body=useRef<HTMLDivElement>(null);
  const [bodyWidth,setBodyWidth]=useState(1000);
  useEffect(()=>{localStorage.setItem('atlas.layout.navigation',navigation?'open':'closed')},[navigation]);
  useEffect(()=>{const timer=setTimeout(()=>localStorage.setItem('atlas.layout.chatWidth',String(chatWidth)),200);return()=>clearTimeout(timer)},[chatWidth]);
  useEffect(()=>{localStorage.setItem('atlas.layout.editor',editorVisible?'open':'closed')},[editorVisible]);
  useEffect(()=>{localStorage.setItem('atlas.layout.files',filesVisible?'open':'closed')},[filesVisible]);
  useEffect(()=>{const element=body.current;if(!element)return;const observer=new ResizeObserver(()=>setBodyWidth(element.clientWidth));observer.observe(element);setBodyWidth(element.clientWidth);return()=>observer.disconnect()},[]);
  const maxChatWidth=Math.max(320,bodyWidth-266),visibleChatWidth=Math.min(chatWidth,maxChatWidth);
  const resize=(x:number)=>{const box=body.current?.getBoundingClientRect();if(box)setChatWidth(Math.max(320,Math.min(maxChatWidth,box.right-x)))};
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
  const filesPanel=effectivePanel==='files'||effectivePanel==='chat';
  const showCenter=!!activeMod&&(!filesPanel||editorVisible||!chatVisible);
  const compactEditor=()=>{setEditorVisible(true);setChatVisible(true);setFilesVisible(false);setChatWidth(Math.max(320,bodyWidth-326))};

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
        <div className="atlas-workspace-toolbar"><span>{effectivePanel==='chat'?'Project workspace':effectivePanel==='files'?'File editor':effectivePanel[0].toUpperCase()+effectivePanel.slice(1)}</span><div className="atlas-actions">{activeMod&&filesPanel&&<><button className="atlas-button" onClick={compactEditor} title="Narrow the editor and give the assistant more room">Compact editor</button><button className="atlas-button" onClick={()=>{setEditorVisible(!showCenter);if(showCenter)setChatVisible(true)}}>{showCenter?'Hide editor':'Show editor'}</button></>}<button className="atlas-button" disabled={!activeMod} onClick={()=>{setChatVisible(v=>!v);if(chatVisible)setEditorVisible(true)}}>{chatVisible?'Hide chat':'Show chat'}</button></div></div>
        <div className="atlas-workspace-body" ref={body} data-center-hidden={!showCenter}>
        <div className={showCenter?'atlas-center-pane':'hidden'}>
        {activeMod&&<div className={filesPanel?'flex flex-1 min-h-0 min-w-0':'hidden'}><FilesView key={activeMod.folder} mod={activeMod} busy={busy} active={showCenter&&filesPanel} filesVisible={filesVisible} onToggleFiles={()=>setFilesVisible(v=>!v)}/></div>}
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
        {showCenter&&chatVisible&&<div role="separator" aria-label="Resize editor and chat" aria-orientation="vertical" aria-valuenow={Math.round(visibleChatWidth)} aria-valuemin={320} aria-valuemax={maxChatWidth} tabIndex={0} className="atlas-resize-handle" title="Drag to resize. Arrow keys resize; double-click resets."
          onDoubleClick={()=>setChatWidth(440)}
          onKeyDown={e=>{if(e.key==='ArrowLeft'){e.preventDefault();setChatWidth(Math.min(maxChatWidth,visibleChatWidth+24))}if(e.key==='ArrowRight'){e.preventDefault();setChatWidth(Math.max(320,visibleChatWidth-24))}}}
          onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId)}}
          onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))resize(e.clientX)}}
          onPointerUp={e=>e.currentTarget.releasePointerCapture(e.pointerId)}/>}
        <div className={chatVisible||!activeMod?'atlas-chat-pane':'hidden'} style={activeMod?{width:visibleChatWidth}:undefined}>
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
