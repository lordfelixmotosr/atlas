import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelOption } from '../agent/models';
import type { ModelSelection } from '../agent/settings';
import { ModelPicker } from '../components/model-picker';
import { appConfirm } from '../components/app-dialog';
import { spriteAssetUrl, type SpriteArt, type SpriteBodyType, type SpriteCandidate, type SpriteDirection, type SpriteExportPlan, type SpriteGenerationProgress, type SpriteProject, type SpriteProjectSummary, type SpriteRecipe, type SpriteStudioApi } from './sprite-studio-types';
import { getMirroredSpriteSlot, getSpriteCandidateSnapshot, getSpriteCandidateView, getSpriteGalleryEntries, getSpriteGuide, getSpriteKindLabel, getSpriteSlotLabel, getSpriteSlots, getVisibleSpriteSlots, isSpriteArtApproved, spriteBodyGuideScales, spriteBodyTypes, spriteCompassDirections, spriteGuideBounds, spriteKindOptions, spriteRecipeForKind, spriteTextureDefaults, spriteTextureNameForFamily } from './sprite-profiles';
import './sprite-studio.css';

type Mod = { folder: string; title?: string; name?: string; game?: string };
type StudioTask = { id: string; projectId?: string; kind?: string; status: string; phase: string; startedAt?: number; endedAt?: number; fraction?: number | null; spriteProgress?: SpriteGenerationProgress };
const directions = spriteCompassDirections;
const initialRecipe: SpriteRecipe = { name: '', kind: 'bird', brief: '', palette: [], canvasSize: 256, frameCount: 8, ticksPerFrame: 2, drawSize: 1.5, groundedDrawSize: 0.7, textureName: 'NewBird' };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const stamp = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const api = () => window.modmixer as typeof window.modmixer & SpriteStudioApi;
function getApproved(project: SpriteProject, direction: SpriteDirection): SpriteArt | undefined {
  return project.candidates.find(candidate => candidate.id === project.approved[direction])?.directions[direction];
}

export function SpriteStudio({ mods, models, onConnect }: { mods: Mod[]; models: ModelOption[]; onConnect: () => void }) {
  const [families, setFamilies] = useState<SpriteProjectSummary[]>([]);
  const [project, setProject] = useState<SpriteProject | null>(null);
  const [search, setSearch] = useState('');
  const [familyFilter, setFamilyFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newRecipe, setNewRecipe] = useState<SpriteRecipe>({ ...initialRecipe });
  const [recipe, setRecipe] = useState<SpriteRecipe>({ ...initialRecipe });
  const [masterMode, setMasterMode] = useState<'reference' | 'slot'>('reference');
  const [masterSlot, setMasterSlot] = useState<SpriteDirection>('south');
  const [importingMaster, setImportingMaster] = useState(false);
  const [bodyType, setBodyType] = useState<SpriteBodyType>('Male');
  const [fitGuide, setFitGuide] = useState(true);
  const [selected, setSelected] = useState<SpriteDirection[]>([...directions]);
  const [candidateId, setCandidateId] = useState('');
  const [direction, setDirection] = useState<SpriteDirection>('south');
  const [tab, setTab] = useState<'directions' | 'animation' | 'gallery' | 'compare'>('directions');
  const [instruction, setInstruction] = useState('');
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [pending, setPending] = useState('');
  const [tasks, setTasks] = useState<StudioTask[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState('');
  const [plan, setPlan] = useState<SpriteExportPlan | null>(null);
  const [exporting, setExporting] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [guides, setGuides] = useState(true);
  const alive = useRef(true);
  const loadId = useRef(0);
  const actionId = useRef(0);
  const projectRef = useRef(project);
  const newForm = useRef<HTMLFormElement>(null);
  projectRef.current = project;
  const latestTask = tasks.find(item => project && (item.projectId === project.id || item.id === 'sprite:' + project.id));
  const task = latestTask?.status === 'running' ? latestTask : undefined;
  const generating = pending === 'generation' || !!task;
  const busy = !!pending || !!task || loading;
  const readOnly = busy || !!project?.archivedAt;
  const selectedCandidate = project?.candidates.find(item => item.id === candidateId) ?? project?.candidates.at(-1);
  const candidate = project ? getSpriteCandidateSnapshot(project, selectedCandidate) : undefined;
  const comparisonView = project ? getSpriteCandidateView(project, selectedCandidate, direction) : null;
  const hasArt = !!project?.candidates.some(item => Object.keys(item.directions).length);
  const dirty = !!project && JSON.stringify(recipe) !== JSON.stringify(project.recipe);
  const visible = families.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (familyFilter === 'all' || (familyFilter === 'archived' ? !!item.archivedAt : !item.archivedAt)));
  const rimworldMods = mods.filter(mod => !mod.game || mod.game === 'rimworld');
  const effectiveModel = useMemo(() => {
    const sorted = [...models].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
    const choice = sorted.find(item => item.provider === model?.provider && item.modelId === model.modelId) ?? sorted[0];
    return choice ? { provider: choice.provider, modelId: choice.modelId } : null;
  }, [models, model]);
  const selectedModel = effectiveModel ? models.find(item => item.provider === effectiveModel.provider && item.modelId === effectiveModel.modelId) : undefined;
  const hasSavedArtwork = !!project?.candidates.some(item => Object.keys(item.directions).length > 0);
  const visualReferenceUnavailable = selectedModel?.vision === false && !!project && (project.references.length > 0 || Object.keys(project.approved).length > 0 || hasSavedArtwork);
  const slots = project ? getSpriteSlots(project.recipe) : directions;
  const visibleSlots = project ? getVisibleSpriteSlots(project.recipe, bodyType) : directions;
  const mirrorSlot = project ? getMirroredSpriteSlot(project.recipe, bodyType) : 'east';
  const newSlots = getSpriteSlots(newRecipe);
  const effectiveMasterSlot = newSlots.includes(masterSlot) ? masterSlot : newSlots[0];
  const workspaceTabs: ('directions' | 'animation' | 'gallery' | 'compare')[] = project?.recipe.kind === 'bird' ? ['directions', 'animation', 'gallery', 'compare'] : ['directions', 'gallery', 'compare'];
  const selectedSlots = slots.filter(slot => selected.includes(slot));
  const designReason = project?.archivedAt ? 'Restore this family to start designing.' : dirty ? 'Save your brief or recipe changes first.' : !effectiveModel ? 'Connect or choose a drawing model first.' : visualReferenceUnavailable ? 'Choose a model with image input to use this family’s artwork.' : !selectedSlots.length ? 'Choose at least one direction or slot to design.' : busy ? task?.phase || 'Finish the current operation first.' : '';
  const designDisabled = readOnly || dirty || !effectiveModel || visualReferenceUnavailable || !selectedSlots.length;

  function accept(value: SpriteProject, selection?: string) {
    setProject(value); setRecipe({ ...value.recipe }); setPlan(null);
    setCandidateId(value.candidates.some(item => item.id === selection) ? selection! : value.candidates.at(-1)?.id ?? '');
    if (value.recipe.kind !== 'bird' && tab === 'animation') setTab('directions');
    const required = getSpriteSlots(value.recipe);
    setDirection(current => required.includes(current) ? current : required[0]);
    setSelected(current => current.some(slot => required.includes(slot)) ? current.filter(slot => required.includes(slot)) : required);
    setFamilies(list => [{ id: value.id, name: value.recipe.name, kind: value.recipe.kind, updatedAt: value.updatedAt, archivedAt: value.archivedAt, approvedCount: Object.keys(value.approved).length, requiredCount: getSpriteSlots(value.recipe).length, preview: getSpriteSlots(value.recipe).map(slot => getApproved(value, slot)?.preview ?? value.candidates.at(-1)?.directions[slot]?.preview).find(Boolean) ?? null }, ...list.filter(item => item.id !== value.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  useEffect(() => {
    alive.current = true;
    const request = ++loadId.current;
    api().spriteList().then(value => { if (alive.current && request === loadId.current) setFamilies(value); }).catch(e => alive.current && request === loadId.current && setError(message(e))).finally(() => alive.current && request === loadId.current && setLoading(false));
    api().atlasTasksStatus().then(value => { if (alive.current) setTasks(value); }).catch(() => {});
    const off = api().onAtlasTasksState((value: StudioTask[]) => { if (alive.current) setTasks(value); });
    return () => { alive.current = false; loadId.current++; actionId.current++; off(); };
  }, []);
  // Generation runs in the main process and survives navigation. Refresh a
  // mounted family when a task finishes, including a task started elsewhere.
  const priorTask = useRef<string | null>(null);
  useEffect(() => {
    if (task) { priorTask.current = task.id; return; }
    if (!priorTask.current || !project || pending === 'generation') return;
    priorTask.current = null;
    const id = project.id, request = ++loadId.current;
    api().spriteRead(id).then(value => { if (alive.current && request === loadId.current && projectRef.current?.id === id) accept(value); }).catch(e => alive.current && setError(message(e)));
  }, [task, project?.id, pending]);

  async function openFamily(id: string) {
    const request = ++loadId.current;
    setError(''); setNotice(''); setCreating(false); setLoading(true); setPlan(null);
    try { const value = await api().spriteRead(id); if (alive.current && request === loadId.current) { accept(value); const views = getSpriteSlots(value.recipe); setSelected([views[0]]); setDirection(views[0]); setBodyType('Male'); setInstruction(''); setTab('directions'); } }
    catch (e) { if (alive.current && request === loadId.current) setError(message(e)); }
    finally { if (alive.current && request === loadId.current) setLoading(false); }
  }
  async function run(label: string, operation: () => Promise<SpriteProject | null>, success = '') {
    if (busy || project?.archivedAt && !['archive', 'create', 'master-import'].includes(label)) return false;
    const request = ++actionId.current, id = project?.id;
    setPending(label); setError(''); setNotice(''); setPlan(null);
    try {
      const value = await operation();
      if (alive.current && request === actionId.current && (!id || projectRef.current?.id === id)) { if (value) accept(value, ['approve', 'save', 'reference'].includes(label) ? candidateId : undefined); if (value && success) setNotice(success); }
      return !!value;
    } catch (e) { if (alive.current && request === actionId.current) setError(message(e)); return false; }
    finally { if (alive.current && request === actionId.current) setPending(''); }
  }
  async function createFamily(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    try { const value = { ...newRecipe }; const created = await run('create', () => api().spriteCreate(value), 'Family created. Import a reference or generate the shared views.'); if (alive.current && created) { setCreating(false); setSelected(getSpriteSlots(value)); setDirection(getSpriteSlots(value)[0]); setTab('directions'); } }
    catch (e) { setError(message(e)); }
  }
  async function saveRecipe() {
    if (!project) return;
    try { await run('save', () => api().spriteSaveRecipe(project.id, recipe, project.version), 'Recipe saved.'); }
    catch (e) { setError(message(e)); }
  }
  function beginFamily(withMaster = false) {
    setCreating(true); setImportingMaster(withMaster); setMasterMode('reference'); setMasterSlot('south'); setError(''); setNotice(''); setNewRecipe({ ...initialRecipe });
  }
  async function createFromMaster() {
    if (busy || !newForm.current?.reportValidity()) return;
    try {
      const value = { ...newRecipe };
      const created = await run('master-import', () => api().spriteCreateFromMaster(value, masterMode, masterMode === 'slot' ? effectiveMasterSlot : undefined), masterMode === 'reference' ? 'Master artwork copied as a family reference.' : 'Master artwork imported as a candidate. Approve it before exporting.');
      if (alive.current && created) { setCreating(false); setSelected(getSpriteSlots(value)); setDirection(masterMode === 'slot' ? effectiveMasterSlot : getSpriteSlots(value)[0]); setBodyType('Male'); setTab('directions'); }
    } catch (e) { setError(message(e)); }
  }
  async function previewExport() {
    if (!project || readOnly || !target) return;
    setPending('export-plan'); setError(''); setNotice('');
    try { const value = await api().spriteExportPlan(project.id, target, project.version); if (alive.current) { setPlan(value); setExporting(true); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setPending(''); }
  }
  async function applyExport() {
    if (!plan || readOnly) return;
    setPending('export'); setError('');
    try { const value = await api().spriteExportApply(plan.token); if (alive.current) { setNotice(`Exported ${value.files} approved PNG files.${value.backup ? ' Existing files backed up at ' + value.backup + '.' : ''}`); setExporting(false); setPlan(null); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setPending(''); }
  }
  async function copyXml() {
    if (!plan) return;
    try { await navigator.clipboard.writeText(plan.xml); if (alive.current) setNotice('XML copied. Paste it into the matching def in your mod.'); }
    catch { if (alive.current) setError('Clipboard access is unavailable. Expand the XML reference and copy its text manually.'); }
  }
  async function designViews() {
    if (!project || designDisabled || !effectiveModel) return;
    const views = [...selectedSlots];
    if (project.recipe.kind === 'bird') setTab('animation');
    const done = await run('generation', () => api().spriteGenerate({ projectId: project.id, version: project.version, directions: views, instruction, model: effectiveModel }), 'Selected artwork ready. Review the revision before approving or exporting.');
    if (alive.current && done) setTab('gallery');
  }
  async function stopDesigning() {
    if (!project) return;
    try { await api().spriteCancel(project.id); if (alive.current) setNotice('Stopping generation…'); }
    catch (e) { if (alive.current) setError(message(e)); }
  }
  async function archiveFamily() {
    if (!project || busy || dirty) return;
    const restoring = !!project.archivedAt;
    const saved = await run('archive', () => api().spriteArchive(project.id, !restoring, project.version), restoring ? 'Family restored.' : 'Family archived. Restore it from the Archived list to continue editing.');
    if (alive.current && saved) setFamilyFilter(restoring ? 'active' : 'archived');
  }
  async function deleteFamily() {
    if (!project || busy || dirty) return;
    const deleting = project;
    setPending('delete-confirm');
    try {
      const confirmed = await appConfirm(`Permanently delete “${deleting.recipe.name}” and its recipe, references and revision history? PNGs already exported to mods are preserved.`, { title: 'Delete sprite family', okLabel: 'Delete family', tone: 'danger' });
      if (!confirmed || !alive.current) return;
      loadId.current++; actionId.current++;
      setPending('delete');
      await api().spriteDelete(deleting.id, deleting.version);
      if (alive.current) { setFamilies(list => list.filter(item => item.id !== deleting.id)); setProject(null); setCandidateId(''); setPlan(null); setExporting(false); setCreating(false); setError(''); setNotice('Sprite family deleted. Exported mod assets are preserved.'); }
    } catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setPending(''); }
  }
  const toggleDirection = (value: SpriteDirection) => setSelected(list => list.includes(value) ? list.filter(item => item !== value) : slots.filter(item => item === value || list.includes(item)));

  return <main className="atlas-sprite-studio" data-atlas-sprite-studio>
    <header className="sprite-studio-heading"><div><h1>Sprite Studio</h1><p>Consistent sprites, clothing, furniture and bird flight.</p></div><span className="sprite-mode-tag">RimWorld · Reference guided</span></header>
    {error && <div className="sprite-message sprite-error" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss Sprite Studio error" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="sprite-message" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss Sprite Studio notice" onClick={() => setNotice('')}>×</button></div>}
    <div className="sprite-studio-layout">
      <aside className="sprite-family-pane" aria-label="Sprite families"><div className="sprite-pane-heading"><h2>Sprite families</h2><button type="button" className="sprite-button sprite-primary" disabled={busy} onClick={() => beginFamily()}>+ New</button></div><button type="button" className="sprite-button sprite-import-master" disabled={busy} onClick={() => beginFamily(true)}>Import master art</button>
        <input type="search" aria-label="Find sprite family" placeholder="Find a family…" value={search} onChange={event => setSearch(event.target.value)} />
        <select aria-label="Sprite family list" value={familyFilter} onChange={event => setFamilyFilter(event.target.value as typeof familyFilter)}><option value="active">Active families</option><option value="archived">Archived families</option><option value="all">All families</option></select>
        <div className="sprite-family-list">{loading && !families.length ? <p className="sprite-muted" role="status">Loading families…</p> : visible.map(item => <button type="button" key={item.id} className={'sprite-family' + (project?.id === item.id && !creating ? ' selected' : '')} aria-pressed={project?.id === item.id && !creating} disabled={!!pending} onClick={() => void openFamily(item.id)}>
          <span className="sprite-family-thumb">{item.preview ? <img loading="lazy" src={spriteAssetUrl(item.id, item.preview)} alt="" /> : <SpriteGlyph bird={item.kind === 'bird'} />}</span><span><strong>{item.name}</strong><small>{getSpriteKindLabel(item.kind)} · {item.approvedCount}/{item.requiredCount ?? getSpriteSlots({ kind: item.kind }).length} approved</small></span></button>)}
          {!loading && !visible.length && <p className="sprite-muted">{families.length ? 'No matching families.' : 'Your saved designs will appear here.'}</p>}</div>
        <p className="sprite-storage-note">Recipes, references and revisions stay in your portable Atlas folder.</p>
      </aside>
      {creating ? <section className="sprite-new-family" aria-labelledby="sprite-new-title"><h2 id="sprite-new-title">{importingMaster ? 'Import your master artwork' : 'Create a sprite family'}</h2><p className="sprite-muted">Choose an asset profile and shared identity. Your artwork is copied into Atlas; the original stays available.</p><form ref={newForm} onSubmit={event => { if (importingMaster) { event.preventDefault(); void createFromMaster(); } else void createFamily(event); }}>
        <RecipeFields value={newRecipe} onChange={setNewRecipe} locked={busy} disabled={busy} prefix="sprite-new" />
        <section className="sprite-master-import"><div className="sprite-section-heading"><h3>Start from existing artwork</h3><label><input type="checkbox" checked={importingMaster} disabled={busy} onChange={event => setImportingMaster(event.target.checked)} /> Import a master PNG</label></div>{importingMaster && <><label htmlFor="sprite-master-mode">Use the PNG as<select id="sprite-master-mode" disabled={busy} value={masterMode} onChange={event => setMasterMode(event.target.value as typeof masterMode)}><option value="reference">Reference · guide new artwork</option><option value="slot">Finished artwork · a reviewable slot</option></select></label>{masterMode === 'slot' && <label htmlFor="sprite-master-slot">Import into<select id="sprite-master-slot" disabled={busy} value={effectiveMasterSlot} onChange={event => setMasterSlot(event.target.value as SpriteDirection)}>{newSlots.map(slot => <option key={slot} value={slot}>{getSpriteSlotLabel(slot, newRecipe)}</option>)}</select></label>}<p className="sprite-muted">Choose PNG opens your file picker. Cancelling leaves this form intact and creates no empty family.</p></>}</section>
        <div className="sprite-actions"><button type="button" className="sprite-button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button><button type="submit" className="sprite-button sprite-primary" disabled={busy || !newRecipe.name.trim() || !newRecipe.brief.trim()}>{pending === 'create' ? 'Creating…' : pending === 'master-import' ? 'Importing…' : importingMaster ? 'Choose PNG and create family' : 'Create family'}</button></div>
      </form></section> : project ? <>
        <section className="sprite-workspace" aria-label="Sprite workspace"><header className="sprite-project-heading"><div><h2>{project.recipe.name}</h2><p>{loading ? 'Loading selected family…' : `${getSpriteKindLabel(project.recipe.kind)} · ${project.recipe.canvasSize} × ${project.recipe.canvasSize} · ${Object.keys(project.approved).length}/${slots.length} slots approved`}</p></div><div className="sprite-project-actions"><button type="button" className="sprite-button" disabled={busy} onClick={() => void api().spriteReveal(project.id).catch(e => alive.current && setError(message(e)))}>Open folder</button><details className="sprite-family-more"><summary className="sprite-button">More ▾</summary><div><button type="button" className="sprite-button" disabled={busy || dirty} title={dirty ? 'Save recipe changes first' : undefined} onClick={() => void archiveFamily()}>{project.archivedAt ? 'Restore family' : 'Archive family'}</button><button type="button" className="sprite-button sprite-danger" disabled={busy || dirty} title={dirty ? 'Save recipe changes first' : undefined} onClick={() => void deleteFamily()}>Delete family…</button></div></details></div></header>
          {project.archivedAt && <div className="sprite-archived-banner" role="status"><p>This family is archived. Restore it to generate, approve or export artwork.</p><button type="button" className="sprite-button" disabled={busy} onClick={() => void archiveFamily()}>Restore family</button></div>}
          <div className="sprite-workspace-tabs" role="tablist" aria-label="Sprite workspace view">{workspaceTabs.map(value => <button type="button" role="tab" key={value} id={'sprite-tab-' + value} aria-controls={'sprite-panel-' + value} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? workspaceTabs.length - 1 : (workspaceTabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : workspaceTabs.length - 1)) % workspaceTabs.length; setTab(workspaceTabs[next]); document.getElementById('sprite-tab-' + workspaceTabs[next])?.focus(); }}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
          <div className="sprite-design-toolbar" data-sprite-design-toolbar>
            <div><strong>{generating ? task?.phase || 'Designing a new revision…' : designReason ? 'Prepare this family for designing' : project.recipe.kind === 'bird' ? 'Ready to design the flight poses' : 'Ready to design the selected views'}</strong>
              <p>{generating ? 'Your approved artwork stays preserved.' : project.recipe.kind === 'bird' ? `${selectedSlots.length} ${selectedSlots.length === 1 ? 'direction' : 'directions'} · 8 frames each · uses this family’s artwork and brief` : `${selectedSlots.length} ${selectedSlots.length === 1 ? 'view' : 'views'} · ${Math.ceil(selectedSlots.length / 4)} model ${selectedSlots.length > 4 ? 'requests' : 'request'} · normal account usage`}</p>
              {generating && <DesignProgress task={task} />}
              {!generating && <fieldset className="sprite-top-selection" disabled={readOnly}><legend>{slots.length > 4 ? 'Slots to design' : 'Directions to design'} · {selectedSlots.length} selected</legend>{slots.length > 4 ? <details><summary>Choose slots</summary><div>{slots.map(slot => <label key={slot}><input type="checkbox" data-sprite-design-direction value={slot} checked={selected.includes(slot)} onChange={() => toggleDirection(slot)} />{getSpriteSlotLabel(slot, project.recipe)}</label>)}</div></details> : <div>{slots.map(slot => <label key={slot}><input type="checkbox" data-sprite-design-direction value={slot} checked={selected.includes(slot)} onChange={() => toggleDirection(slot)} />{getSpriteSlotLabel(slot, project.recipe).split(' · ')[0]}</label>)}</div>}</fieldset>}
              {!generating && designReason && <p className="sprite-design-reason" id="sprite-design-reason">{designReason}</p>}
              {visualReferenceUnavailable && <p className="sprite-model-warning" role="status">{selectedModel?.label || 'This model'} cannot view your saved or reference images. Choose an image-capable model to use the master artwork.</p>}
            </div>
            <div className="sprite-design-action"><div className="sprite-design-model"><ModelPicker models={models} current={effectiveModel} onChange={setModel} onConnect={onConnect} /></div>{generating ? <button type="button" className="sprite-button" data-sprite-stop-design onClick={() => void stopDesigning()}>Stop</button> : <button type="button" className="sprite-button sprite-primary" data-sprite-design-primary disabled={designDisabled} aria-describedby={designReason ? 'sprite-design-reason' : undefined} onClick={() => void designViews()}>{project.recipe.kind === 'bird' ? 'Design flight frames' : 'Design views'}</button>}</div>
          </div>
          {!generating && latestTask && ['completed', 'failed', 'cancelled'].includes(latestTask.status) && <div className={'sprite-design-outcome sprite-design-' + latestTask.status} data-sprite-design-outcome role="status"><strong>{latestTask.status === 'completed' ? 'Design ready' : latestTask.status === 'cancelled' ? 'Design stopped' : 'Design needs attention'}</strong><span>{latestTask.phase}</span><DesignProgress task={latestTask} /></div>}
          <div className="sprite-workspace-scroll"><div className="sprite-candidate-bar"><label htmlFor="sprite-revision">Revision</label><select id="sprite-revision" value={candidate?.id ?? ''} onChange={event => setCandidateId(event.target.value)} disabled={!project.candidates.length || busy}><option value="" disabled>No artwork yet</option>{[...project.candidates].reverse().map((item, index) => <option key={item.id} value={item.id}>{item.source === 'imported' ? 'Imported' : 'Generated'} · {stamp(item.createdAt)}{index === 0 ? ' · latest' : ''}</option>)}</select><span className="sprite-muted">{candidate?.model || 'Choose a direction to begin'}</span></div>
            {candidate && <p className="sprite-revision-context">Working views through the selected revision. Earlier views stay visible until replaced.</p>}
            <div className="sprite-display-tools">{project.recipe.kind === 'apparel' && <label htmlFor="sprite-body-type">Adult body type<select id="sprite-body-type" value={bodyType} onChange={event => { const next = event.target.value as SpriteBodyType; setBodyType(next); if (direction.includes('_')) setDirection((next + '_' + direction.split('_')[1]) as SpriteDirection); }}>{spriteBodyTypes.map(body => <option key={body} value={body}>{body}</option>)}</select></label>}{['apparel', 'hat', 'building', 'furniture'].includes(project.recipe.kind) && <label><input type="checkbox" checked={fitGuide} onChange={event => setFitGuide(event.target.checked)} /> Schematic fit guide</label>}<label><input type="checkbox" checked={actualSize} onChange={event => setActualSize(event.target.checked)} /> Actual size</label><label><input type="checkbox" checked={guides} onChange={event => setGuides(event.target.checked)} /> Centre guides</label></div>
            <div role="tabpanel" id={'sprite-panel-' + tab} aria-labelledby={'sprite-tab-' + tab} tabIndex={0}>
              {tab === 'directions' && <><div className="sprite-direction-grid">{visibleSlots.map(value => {
                const view = getSpriteCandidateView(project, selectedCandidate, value), art = view?.art, approved = isSpriteArtApproved(project, value, art);
                const label = getSpriteSlotLabel(value, project.recipe);
                return <article key={value} data-sprite-slot={value} className={'sprite-direction-card' + (direction === value ? ' selected' : '')}><button type="button" className="sprite-direction-select" aria-pressed={direction === value} onClick={() => setDirection(value)}><span>{label}</span><small className={approved ? 'sprite-approved' : ''}>{approved ? 'Approved' : art ? 'Candidate' : project.approved[value] ? 'In another revision' : 'Missing'}</small><SpriteImage projectId={project.id} art={art} label={label} actualSize={actualSize} guides={guides} recipe={project.recipe} slot={value} fitGuide={fitGuide} /></button><div className="sprite-card-actions"><button type="button" className="sprite-button" disabled={readOnly} onClick={() => void run('import', () => api().spriteImport(project.id, value, project.version), 'Imported image saved as a new revision.')}>Import PNG</button><button type="button" className="sprite-button" disabled={readOnly || !view || approved} onClick={() => view && void run('approve', () => api().spriteApprove(project.id, view.candidateId, [value], project.version), `${label} approved.`)}>{approved ? '✓ Approved' : 'Approve'}</button></div></article>;
              })}{mirrorSlot && <article className="sprite-direction-card sprite-mirrored"><div className="sprite-direction-select"><span>West · mirrored east</span><small>Shared artwork</small><SpriteImage projectId={project.id} art={candidate?.directions[mirrorSlot]} label="West preview, mirrored from east" actualSize={actualSize} guides={guides} mirrored recipe={project.recipe} slot={mirrorSlot} fitGuide={fitGuide} /></div><p>West uses the matching east artwork mirrored.</p></article>}</div>{project.recipe.kind === 'apparel' && <p className="sprite-fit-note">Neutral adult {bodyType.toLowerCase()} mannequin · schematic guide only. Worn textures contain clothing, while the inventory icon is separate. Child and baby body types are not included.</p>}{project.recipe.kind === 'hat' && <p className="sprite-fit-note">Neutral head silhouette · schematic guide only. Worn views contain the hat, with a separate inventory icon.</p>}{['building', 'furniture'].includes(project.recipe.kind) && <p className="sprite-fit-note">Tile footprint and sprite draw extent are independent. The footprint swaps width and depth for east/west views. Confirm placement and fit in RimWorld.</p>}</>}
              {tab === 'animation' && <AnimationPanel project={project} candidate={candidate} direction={direction} onDirection={setDirection} actualSize={actualSize} guides={guides} onDesignFrames={() => void designViews()} designDisabled={designDisabled} designReason={designReason} generating={generating} />}
              {tab === 'gallery' && <GalleryPanel key={project.id} project={project} candidate={selectedCandidate} />}
              {tab === 'compare' && <><div className="sprite-direction-pills">{visibleSlots.map(value => <button type="button" key={value} className="sprite-button" aria-pressed={direction === value} onClick={() => setDirection(value)}>{getSpriteSlotLabel(value, project.recipe)}</button>)}</div><div className="sprite-compare"><article><h3>Approved</h3><SpriteImage projectId={project.id} art={getApproved(project, direction)} label={'Approved ' + getSpriteSlotLabel(direction, project.recipe)} actualSize={actualSize} guides={guides} recipe={project.recipe} slot={direction} fitGuide={fitGuide} /><p className="sprite-muted">The version used by export.</p></article><article><h3>Selected revision</h3><SpriteImage projectId={project.id} art={candidate?.directions[direction]} label={'Candidate ' + getSpriteSlotLabel(direction, project.recipe)} actualSize={actualSize} guides={guides} recipe={project.recipe} slot={direction} fitGuide={fitGuide} /><button type="button" className="sprite-button sprite-primary" disabled={readOnly || !comparisonView || isSpriteArtApproved(project, direction, comparisonView.art)} onClick={() => comparisonView && void run('approve', () => api().spriteApprove(project.id, comparisonView.candidateId, [direction], project.version), 'Approved this revision. Earlier revisions are preserved.')}>Use this revision</button></article></div></>}
            </div>
            {candidate && <div className="sprite-art-warnings">{[...new Set(Object.values(candidate.directions).flatMap(art => art?.warnings ?? []))].map(text => <p key={text}>{text}</p>)}</div>}
            <section className="sprite-generation" aria-labelledby="sprite-generation-title"><div className="sprite-section-heading"><h3 id="sprite-generation-title">Generate a revision</h3><span className="sprite-muted">Approved artwork stays locked</span></div>{slots.length > 4 && <div className="sprite-selection-actions"><button type="button" className="sprite-button" disabled={readOnly} onClick={() => setSelected([...visibleSlots])}>Select visible</button><button type="button" className="sprite-button" disabled={readOnly} onClick={() => setSelected(slots.filter(slot => !project.approved[slot]))}>Select unapproved</button><button type="button" className="sprite-button" disabled={readOnly} onClick={() => setSelected([])}>Clear</button></div>}<fieldset disabled={readOnly}><legend>{project.recipe.kind === 'bird' || project.recipe.kind === 'sprite' ? 'Directions to generate' : 'Slots to generate'}</legend><div className={'sprite-direction-checks' + (slots.length > 4 ? ' sprite-many-slots' : '')}>{slots.map(value => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={() => toggleDirection(value)} />{getSpriteSlotLabel(value, project.recipe).replace(' · front', '').replace(' · side', '').replace(' · back', '')}{project.approved[value] && <small>approved</small>}</label>)}</div></fieldset><label htmlFor="sprite-instruction">Changes for this revision <span className="sprite-muted">(optional)</span></label><textarea id="sprite-instruction" maxLength={4000} rows={2} value={instruction} disabled={readOnly} onChange={event => setInstruction(event.target.value)} placeholder={project.recipe.kind === 'bird' ? 'For example: longer tail, same feather markings and colors…' : 'Describe the changes while keeping the shared design consistent…'} />
              {generating ? <div className="sprite-running" role="status"><div><span className="sprite-progress-dot" /><strong>{task?.phase || 'Creating a consistent revision…'}</strong><DesignProgress task={task} /><p>Generation continues if you leave this tab. View progress in Activity.</p></div><button type="button" className="sprite-button" onClick={() => void stopDesigning()}>Stop</button></div> : <div className="sprite-actions"><p className="sprite-muted">{selectedSlots.length > 4 ? `${selectedSlots.length} views across ${Math.ceil(selectedSlots.length / 4)} model requests, using normal account usage. Saved together as one revision.` : 'Uses your connected AI account to draw artwork. Revisions are saved for review.'}</p><button type="button" className="sprite-button sprite-primary" disabled={designDisabled} onClick={() => void designViews()}>{pending === 'generation' ? 'Generating…' : 'Generate ' + selectedSlots.length + (project.recipe.kind === 'bird' || project.recipe.kind === 'sprite' ? selectedSlots.length === 1 ? ' direction' : ' directions' : selectedSlots.length === 1 ? ' view' : ' views')}</button></div>}
              {dirty && <p className="sprite-muted">Save your recipe before generating.</p>}
            </section>
            <section className="sprite-export" aria-labelledby="sprite-export-title"><h3 id="sprite-export-title">Export to a mod</h3><p className="sprite-muted">Only approved artwork is exported. Review file replacements and XML first.</p><div className="sprite-export-target"><select aria-label="Target RimWorld mod" value={target} disabled={readOnly} onChange={event => { setTarget(event.target.value); setPlan(null); }}><option value="">Choose a RimWorld mod…</option>{rimworldMods.map(mod => <option value={mod.folder} key={mod.folder}>{mod.title || mod.name || mod.folder}</option>)}</select><button type="button" className="sprite-button" disabled={readOnly || !target || !Object.keys(project.approved).length} onClick={() => void previewExport()}>{pending === 'export-plan' ? 'Preparing…' : 'Preview export'}</button></div>{!rimworldMods.length && <p className="sprite-muted">Create or import a RimWorld mod from Home to export artwork into it.</p>}
              {exporting && plan && <div className="sprite-export-preview"><div className="sprite-section-heading"><h4>Review export</h4><button type="button" className="sprite-button" disabled={busy} onClick={() => { setExporting(false); setPlan(null); }}>Close preview</button></div><p className="sprite-muted">{plan.rows.length} PNG files · Existing files will be backed up.</p><div className="sprite-export-rows">{plan.rows.map(row => <div key={row.path}><code>{row.path}</code><span>{row.action === 'replace' ? 'Replace · backup' : 'Create'}</span></div>)}</div>{plan.warnings.map(text => <p className="sprite-export-warning" key={text}>{text}</p>)}<div className="sprite-xml-heading"><h4>XML reference</h4><button type="button" className="sprite-button" onClick={() => void copyXml()}>Copy XML</button></div><details><summary>View XML · paste into your def</summary><pre>{plan.xml}</pre></details><button type="button" className="sprite-button sprite-primary" disabled={readOnly || !plan.rows.length} onClick={() => void applyExport()}>{pending === 'export' ? 'Exporting…' : 'Export approved PNGs'}</button></div>}
            </section>
          </div>
        </section>
        <aside className="sprite-inspector" aria-label="Family recipe"><div className="sprite-pane-heading"><h2>Family recipe</h2>{hasArt && <span className="sprite-mode-tag">Recipe locked</span>}</div><p className="sprite-muted">{hasArt ? 'Canvas, frame and asset profile settings stay fixed after artwork is created. The name and brief can be refined.' : 'Your design brief and references guide every view.'}</p><RecipeFields value={recipe} onChange={setRecipe} locked={hasArt || readOnly} disabled={readOnly} prefix="sprite-recipe" /><button type="button" className="sprite-button" disabled={readOnly || !dirty} onClick={() => void saveRecipe()}>{pending === 'save' ? 'Saving…' : 'Save recipe'}</button>
          <section className="sprite-references"><div className="sprite-section-heading"><h3>References</h3><button type="button" className="sprite-button" disabled={readOnly} onClick={() => void run('reference', () => api().spriteImport(project.id, 'reference', project.version), 'Reference copied into this family.')}>Add PNG</button></div><p className="sprite-muted">Master artwork, approved views and your design brief guide the colors and appearance. Imported PNG colors are preserved.</p><div className="sprite-reference-list">{project.references.map(reference => <figure key={reference.id}><img loading="lazy" src={spriteAssetUrl(project.id, reference.path)} alt={reference.name} /><figcaption title={reference.name}>{reference.name}</figcaption></figure>)}</div>{!project.references.length && <p className="sprite-muted">Add a design or silhouette reference to guide your first revision.</p>}</section>
          <section className="sprite-model"><h3>Drawing model</h3><ModelPicker models={models} current={effectiveModel} onChange={setModel} onConnect={onConnect} /><p className="sprite-muted">Uses the selected connected model and its normal account usage. No separate image API is used. Consistency comes from the saved recipe, references and shared wing rig.</p>{visualReferenceUnavailable && <p className="sprite-model-warning" role="status">This model cannot view images. Your reference images and approved previews cannot visually guide it; choose a model with image input for closer consistency.</p>}</section>
        </aside>
      </> : <section className="sprite-welcome"><SpriteGlyph bird /><span className="sprite-mode-tag">Start with one approved design</span><h2>Keep every view in one family</h2><p>Create birds, pawn sprites, adult apparel, hats, buildings and furniture with a shared design. Import your own master PNG or describe the artwork you want.</p><div className="sprite-welcome-steps"><div><span>1</span><strong>Name and describe it</strong><p>Choose a profile and add your design brief.</p></div><div><span>2</span><strong>Create and generate</strong><p>Import a reference or generate your first views.</p></div><div><span>3</span><strong>Review and export</strong><p>Approve the exact artwork for your mod.</p></div></div><div className="sprite-welcome-actions"><button type="button" className="sprite-button sprite-primary" disabled={busy} onClick={() => beginFamily()}>Create your first family</button><button type="button" className="sprite-button" disabled={busy} onClick={() => beginFamily(true)}>Import master art</button></div><p className="sprite-welcome-note">This workspace draws SVG layers with your connected model. Imported flat PNGs stay static; generate a layered bird revision for flight animation.</p></section>}
    </div>
  </main>;
}

function RecipeFields({ value, onChange, locked = false, disabled = false, prefix }: { value: SpriteRecipe; onChange: (value: SpriteRecipe) => void; locked?: boolean; disabled?: boolean; prefix: string }) {
  const patch = (field: keyof SpriteRecipe, next: SpriteRecipe[keyof SpriteRecipe]) => onChange({ ...value, [field]: next });
  const examples: Record<SpriteRecipe['kind'], string> = {
    bird: 'A small marsh bird with cream feathers, green wings and a short curved beak. Keep the markings consistent in every view.',
    sprite: 'A compact woodland creature with a brown coat, cream belly and rounded ears. Use clean shapes that read well in game.',
    apparel: 'A dark red winter coat with a cream collar and brass buttons. Keep the same trim and stitching across adult body types.',
    hat: 'A forest green ranger hat with a narrow brown band. Preserve its brim and band across worn views.',
    building: 'A stone watchtower with a wooden door and a red roof. Keep the same materials and details in every rotation.',
    furniture: 'A compact oak writing desk with a green cloth top and two drawers. Match the front, sides and back.',
  };
  return <div className="sprite-recipe-fields">
    <label htmlFor={prefix + '-name'}>Family name<input id={prefix + '-name'} value={value.name} maxLength={80} required disabled={disabled} onChange={event => { const auto = prefix === 'sprite-new' && (value.textureName === spriteTextureNameForFamily(value.name, value.kind) || value.textureName === spriteTextureDefaults[value.kind]); onChange({ ...value, name: event.target.value, textureName: auto ? spriteTextureNameForFamily(event.target.value, value.kind) : value.textureName }); }} placeholder="Silver marsh bird" /></label>
    <label htmlFor={prefix + '-kind'}>Asset type<select id={prefix + '-kind'} value={value.kind} disabled={locked} onChange={event => { const kind = event.target.value as SpriteRecipe['kind']; const next = spriteRecipeForKind(value, kind); if (prefix === 'sprite-new' && (value.textureName === spriteTextureDefaults[value.kind] || value.textureName === spriteTextureNameForFamily(value.name, value.kind))) next.textureName = spriteTextureNameForFamily(value.name, kind); onChange(next); }}>{spriteKindOptions.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label>
    <label htmlFor={prefix + '-brief'}>Design brief<textarea id={prefix + '-brief'} value={value.brief} maxLength={4000} required rows={3} disabled={disabled} onChange={event => patch('brief', event.target.value)} placeholder={examples[value.kind]} /><small>Describe the shape, colors and details, or which parts of your master artwork to preserve.</small></label>
    <div className="sprite-field-pair"><label htmlFor={prefix + '-canvas'}>Canvas<select id={prefix + '-canvas'} value={value.canvasSize} disabled={locked} onChange={event => patch('canvasSize', Number(event.target.value) as SpriteRecipe['canvasSize'])}>{[128, 256, 512].map(size => <option key={size} value={size}>{size} × {size}</option>)}</select></label>{!['building', 'furniture'].includes(value.kind) && <label htmlFor={prefix + '-size'}>{value.kind === 'bird' ? 'Flight draw size' : value.kind === 'apparel' || value.kind === 'hat' ? 'Inventory draw size' : 'Draw size'}<input id={prefix + '-size'} type="number" min="0.1" max="10" step="0.1" value={value.drawSize} disabled={locked} onChange={event => patch('drawSize', Number(event.target.value))} /></label>}</div>
    {value.kind === 'bird' && <label htmlFor={prefix + '-grounded-size'}>Grounded draw size<input id={prefix + '-grounded-size'} type="number" min="0.1" max="10" step="0.1" value={value.groundedDrawSize ?? 0.7} disabled={locked} onChange={event => patch('groundedDrawSize', Number(event.target.value))} /><small>Independent size for the bird while standing.</small></label>}
    <label htmlFor={prefix + '-texture'}>Texture name<input id={prefix + '-texture'} value={value.textureName} required maxLength={64} pattern="[A-Za-z][A-Za-z0-9_]*" disabled={locked} onChange={event => patch('textureName', event.target.value)} placeholder="SilverMarshBird" /><small>Unique filename prefix for this family. Letters, numbers and underscores; begins with a letter.</small></label>
    {value.kind === 'bird' && <div className="sprite-field-pair"><label htmlFor={prefix + '-frames'}>Flight frames<select id={prefix + '-frames'} value={8} disabled aria-describedby={prefix + '-frame-note'}><option value={8}>8 · RimWorld bird</option></select><small id={prefix + '-frame-note'}>Matches Odyssey bird flight.</small></label><label htmlFor={prefix + '-timing'}>Ticks per frame<input id={prefix + '-timing'} type="number" min="1" max="30" value={value.ticksPerFrame} disabled={locked} onChange={event => patch('ticksPerFrame', Number(event.target.value))} /></label></div>}
    {value.kind === 'apparel' && <><div className="sprite-field-pair"><label htmlFor={prefix + '-layer'}>Worn layer<select id={prefix + '-layer'} value={value.apparelLayer ?? 'OnSkin'} disabled={locked} onChange={event => patch('apparelLayer', event.target.value as SpriteRecipe['apparelLayer'])}><option value="OnSkin">On skin · shirt</option><option value="Middle">Middle · vest</option><option value="Shell">Shell · coat</option></select></label><label htmlFor={prefix + '-coverage'}>Coverage<select id={prefix + '-coverage'} value={value.apparelCoverage ?? 'upper'} disabled={locked} onChange={event => patch('apparelCoverage', event.target.value as SpriteRecipe['apparelCoverage'])}><option value="upper">Upper body</option><option value="lower">Legs</option><option value="full">Full body</option></select></label></div><p className="sprite-profile-note">Adult apparel: inventory icon + south, east and north for Male, Female, Thin, Fat and Hulk. Child and baby fits require separate artwork.</p></>}
    {value.kind === 'hat' && <label htmlFor={prefix + '-hat-coverage'}>Head coverage<select id={prefix + '-hat-coverage'} value={value.hatCoverage ?? 'upper'} disabled={locked} onChange={event => patch('hatCoverage', event.target.value as SpriteRecipe['hatCoverage'])}><option value="upper">Upper head · hat</option><option value="full">Full head · helmet</option></select><small>Overhead layer · inventory icon and three worn views.</small></label>}
    {['building', 'furniture'].includes(value.kind) && <>
      <label htmlFor={prefix + '-graphic'}>World views<select id={prefix + '-graphic'} value={value.graphicMode ?? 'multi'} disabled={locked} onChange={event => onChange({ ...value, graphicMode: event.target.value as SpriteRecipe['graphicMode'], rotatable: event.target.value === 'multi' })}><option value="multi">Four rotations · separate west</option><option value="single">Single view · no rotation</option></select></label>
      <div className="sprite-field-pair"><label htmlFor={prefix + '-footprint-x'}>Footprint width<input id={prefix + '-footprint-x'} type="number" min={1} max={10} step={1} value={value.footprintX ?? 1} disabled={locked} onChange={event => patch('footprintX', Number(event.target.value))} /><small>Occupied tiles</small></label><label htmlFor={prefix + '-footprint-z'}>Footprint depth<input id={prefix + '-footprint-z'} type="number" min={1} max={10} step={1} value={value.footprintZ ?? 1} disabled={locked} onChange={event => patch('footprintZ', Number(event.target.value))} /><small>Occupied tiles</small></label></div>
      <div className="sprite-field-pair"><label htmlFor={prefix + '-draw-width'}>Sprite draw width<input id={prefix + '-draw-width'} type="number" min={0.1} max={20} step={0.1} value={value.drawWidth ?? 1} disabled={locked} onChange={event => patch('drawWidth', Number(event.target.value))} /></label><label htmlFor={prefix + '-draw-height'}>Sprite draw height<input id={prefix + '-draw-height'} type="number" min={0.1} max={20} step={0.1} value={value.drawHeight ?? 1} disabled={locked} onChange={event => patch('drawHeight', Number(event.target.value))} /></label></div>
      <label className="sprite-inline-check"><input type="checkbox" checked={value.graphicMode !== 'single' && (value.rotatable ?? true)} disabled={locked || value.graphicMode === 'single'} onChange={event => patch('rotatable', event.target.checked)} /> Rotatable in game</label>
      <p className="sprite-profile-note">Footprint controls occupied tiles; draw size controls the image extent. Multi-view west is authored separately.</p>
    </>}
  </div>;
}

function SpriteImage({ projectId, art, label, actualSize, guides, mirrored = false, frame, onion, recipe, slot, fitGuide = false }: { projectId: string; art?: SpriteArt; label: string; actualSize: boolean; guides: boolean; mirrored?: boolean; frame?: number; onion?: boolean; recipe?: SpriteRecipe; slot?: SpriteDirection; fitGuide?: boolean }) {
  const path = typeof frame === 'number' && art?.frames.length ? art.frames[Math.min(frame, art.frames.length - 1)] : art?.preview;
  const [failed, setFailed] = useState<string | null>(null);
  return <div className={'sprite-image-stage' + (actualSize ? ' sprite-actual-size' : '') + (guides ? ' sprite-guides' : '')}>{fitGuide && recipe && slot && <SchematicGuide recipe={recipe} slot={slot} actualSize={actualSize} />}{path && failed !== path ? <>{onion && art && art.frames.length > 1 && typeof frame === 'number' && <img className="sprite-onion" loading="lazy" draggable={false} src={spriteAssetUrl(projectId, art.frames[(frame + art.frames.length - 1) % art.frames.length])} alt="" aria-hidden style={mirrored ? { transform: 'scaleX(-1)' } : undefined} />}<img className="sprite-art" loading="lazy" draggable={false} onError={() => setFailed(path)} src={spriteAssetUrl(projectId, path)} alt={label} style={mirrored ? { transform: 'scaleX(-1)' } : undefined} /></> : <div className="sprite-empty-slot"><SpriteGlyph /><span>{path ? 'Artwork file unavailable' : 'No artwork yet'}</span></div>}</div>;
}

function DesignProgress({ task }: { task?: StudioTask }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (task?.status !== 'running' || !task.startedAt) return;
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [task?.status, task?.startedAt]);
  const fraction = typeof task?.fraction === 'number' && Number.isFinite(task.fraction) ? Math.max(0, Math.min(1, task.fraction)) : null;
  const progress = task?.spriteProgress;
  const elapsed = task?.startedAt ? Math.max(0, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000)) : null;
  const elapsedText = elapsed === null ? '' : (elapsed >= 60 ? Math.floor(elapsed / 60) + 'm ' + elapsed % 60 + 's' : elapsed + 's') + ' elapsed';
  const count = progress && progress.total > 0 ? progress.stage === 'designing' ? `${progress.completed}/${progress.total} model requests completed` : progress.stage === 'rendering' ? `${progress.completed}/${progress.total} PNGs rendered` : progress.stage === 'complete' ? `${progress.completed} PNGs ready` : progress.stage === 'saving' ? 'Saving the revision' : 'Preparing references' : task?.status === 'running' ? 'Waiting for the drawing model' : '';
  const running = !task || task.status === 'running';
  return <div className="sprite-progress-report" data-sprite-progress data-progress-stage={progress?.stage ?? 'waiting'}>
    {running && <div className={'sprite-generation-progress' + (fraction === null ? '' : ' sprite-progress-determinate')} role="progressbar" aria-label={progress?.stage === 'rendering' ? 'PNG rendering progress' : 'Design progress'} aria-valuemin={fraction === null ? undefined : 0} aria-valuemax={fraction === null ? undefined : 100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)} aria-valuetext={task?.phase || 'Waiting for the drawing model'}><span style={fraction === null ? undefined : { width: fraction * 100 + '%' }} /></div>}
    <small>{[count, progress?.stage === 'rendering' && fraction !== null ? Math.round(fraction * 100) + '% PNG rendering' : '', elapsedText].filter(Boolean).join(' · ')}</small>
  </div>;
}

function GalleryPanel({ project, candidate }: { project: SpriteProject; candidate?: SpriteCandidate }) {
  const [revision, setRevision] = useState('selected'), [slot, setSlot] = useState<SpriteDirection | 'all'>('all'), [source, setSource] = useState<'all' | 'generated' | 'imported'>('all'), [images, setImages] = useState<'all' | 'previews' | 'frames'>('all'), [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<ReturnType<typeof getSpriteGalleryEntries>[number] | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const selected = revision === 'selected' ? candidate : project.candidates.find(item => item.id === revision);
  const entries = useMemo(() => getSpriteGalleryEntries(project, selected, revision === 'all'), [project, selected, revision]);
  const filtered = entries.filter(entry => (slot === 'all' || entry.slot === slot) && (source === 'all' || entry.source === source) && (images === 'all' || (images === 'frames' ? entry.kind === 'frame' : entry.kind === 'preview')));
  const pages = Math.max(1, Math.ceil(filtered.length / 36)), current = Math.min(page, pages - 1), visible = filtered.slice(current * 36, (current + 1) * 36);
  useEffect(() => { setPage(0); }, [revision, slot, source, images, candidate?.id, project.id]);
  useEffect(() => { if (expanded) modal.current?.showModal(); else modal.current?.close(); }, [expanded]);
  const art = (path: string): SpriteArt => ({ preview: path, frames: [], hasWingRig: false, warnings: [] });
  const label = (entry: ReturnType<typeof getSpriteGalleryEntries>[number]) => getSpriteSlotLabel(entry.slot, project.recipe) + ' · ' + (entry.kind === 'frame' ? 'Frame ' + entry.frame : project.recipe.kind === 'bird' ? 'Standing' : 'Preview');
  return <section className="sprite-gallery" data-sprite-gallery aria-label="Sprite gallery">
    <div className="sprite-gallery-heading"><div><h3>Every sprite and frame</h3><p>Browse PNGs individually. Imported artwork and earlier working views stay available.</p></div><span>{filtered.length} {filtered.length === 1 ? 'image' : 'images'}</span></div>
    <div className="sprite-gallery-filters">
      <label>Revisions<select aria-label="Gallery revisions" value={revision} onChange={event => setRevision(event.target.value)}><option value="selected">Working selected revision</option><option value="all">All revisions · unique artwork</option>{[...project.candidates].reverse().map(item => <option key={item.id} value={item.id}>Revision {project.candidates.indexOf(item) + 1} · {stamp(item.createdAt)}</option>)}</select></label>
      <label>Direction<select aria-label="Gallery direction" value={slot} onChange={event => setSlot(event.target.value as typeof slot)}><option value="all">All directions and slots</option>{getSpriteSlots(project.recipe).map(value => <option key={value} value={value}>{getSpriteSlotLabel(value, project.recipe)}</option>)}</select></label>
      <label>Artwork<select aria-label="Gallery artwork" value={source} onChange={event => setSource(event.target.value as typeof source)}><option value="all">Generated and imported</option><option value="generated">Generated artwork</option><option value="imported">Imported PNGs</option></select></label>
      <label>Images<select aria-label="Gallery images" value={images} onChange={event => setImages(event.target.value as typeof images)}><option value="all">Previews and frames</option><option value="previews">Previews / standing only</option><option value="frames">Flight frames only</option></select></label>
    </div>
    <div className="sprite-gallery-grid">{visible.map(entry => <button type="button" key={entry.id} className="sprite-gallery-card" data-sprite-gallery-card data-gallery-slot={entry.slot} data-gallery-source={entry.source} data-gallery-kind={entry.kind} data-gallery-frame={entry.frame} data-gallery-revision={entry.originRevisionId} aria-label={'Open ' + label(entry) + ', revision ' + entry.originIndex} onClick={() => setExpanded(entry)}>
      <SpriteImage projectId={project.id} art={art(entry.path)} label={label(entry)} actualSize={false} guides={false} />
      <strong>{getSpriteSlotLabel(entry.slot, project.recipe).replace(' · front', '').replace(' · side', '').replace(' · back', '')}</strong><span>{entry.kind === 'frame' ? 'Frame ' + entry.frame : project.recipe.kind === 'bird' ? 'Standing' : 'Preview'}</span><small>{entry.source === 'imported' ? 'Imported PNG' : 'Generated'} · Revision {entry.originIndex}{revision !== 'all' && entry.carried ? ' · earlier view' : ''}</small>
    </button>)}</div>
    {!visible.length && <div className="sprite-gallery-empty"><h3>{project.candidates.length ? 'No images match these filters' : 'Your artwork will appear here'}</h3><p>{project.candidates.length ? 'Try another direction, artwork type or revision.' : 'Choose your directions above, then design views or flight frames.'}</p></div>}
    {filtered.length > 0 && <nav className="sprite-gallery-pagination" aria-label="Gallery pages"><button type="button" className="sprite-button" disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><span>Page {current + 1} of {pages} · {current * 36 + 1}–{Math.min((current + 1) * 36, filtered.length)} of {filtered.length}</span><button type="button" className="sprite-button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next</button></nav>}
    <dialog ref={modal} className="sprite-gallery-dialog" data-sprite-gallery-preview onCancel={event => { event.preventDefault(); setExpanded(null); }} onClose={() => setExpanded(null)}>{expanded && <><header><div><h3>{label(expanded)}</h3><p>{expanded.source === 'imported' ? 'Imported PNG' : 'Generated artwork'} · Revision {expanded.originIndex} · {stamp(expanded.createdAt)}</p></div><button type="button" className="sprite-button" aria-label="Close sprite preview" onClick={() => setExpanded(null)}>Close</button></header><SpriteImage projectId={project.id} art={art(expanded.path)} label={label(expanded)} actualSize={false} guides={false} /><p className="sprite-muted">{expanded.model}</p></>}</dialog>
  </section>;
}

function SchematicGuide({ recipe, slot, actualSize }: { recipe: SpriteRecipe; slot: SpriteDirection; actualSize: boolean }) {
  const kind = getSpriteGuide(slot, recipe);
  if (!kind) return null;
  const view = slot.split('_').at(-1), body = slot.includes('_') ? slot.split('_')[0] as SpriteBodyType : 'Male';
  const [sx, sy] = spriteBodyGuideScales[body] ?? spriteBodyGuideScales.Male;
  const east = view === 'east' || view === 'west';
  const footprintX = Math.max(1, Math.min(10, east ? recipe.footprintZ ?? 1 : recipe.footprintX ?? 1));
  const footprintZ = Math.max(1, Math.min(10, east ? recipe.footprintX ?? 1 : recipe.footprintZ ?? 1));
  const tile = Math.min(38, 180 / Math.max(footprintX, footprintZ)), left = (256 - footprintX * tile) / 2, top = (256 - footprintZ * tile) / 2;
  return <svg className={'sprite-fit-svg sprite-guide-' + kind} data-sprite-guide={kind} viewBox="0 0 256 256" aria-hidden style={actualSize ? { width: recipe.canvasSize, height: recipe.canvasSize } : undefined}>
    {kind === 'body' && <g transform={`translate(128 140) scale(${sx * (east ? spriteGuideBounds.eastWidthScale : 1)} ${sy}) translate(-128 -140)`} fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.5"><ellipse cx="128" cy="43" rx="24" ry="27" /><path d="M109 70h38l27 12 15 72-15 5-15-56v63l-5 58h-21l-5-55-5 55h-21l-5-58v-63l-15 56-15-5 15-72z" /><path d="M98 156h60M128 169v-38" fill="none" /></g>}
    {kind === 'head' && <g fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.5"><ellipse cx={spriteGuideBounds.headCenter[0]} cy={spriteGuideBounds.headCenter[1]} rx={spriteGuideBounds.headRadius[0] * (east ? .78 : 1)} ry={spriteGuideBounds.headRadius[1]} /><path d="M108 188v19h40v-19M86 107h84" fill="none" />{view === 'south' && <path d="M107 133h5m33 0h5M121 162h14" fill="none" />}</g>}
    {kind === 'footprint' && <g fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="1"><rect x={left} y={top} width={footprintX * tile} height={footprintZ * tile} fill="currentColor" fillOpacity=".035" />{Array.from({ length: footprintX - 1 }, (_, index) => <path key={'x' + index} d={`M${left + (index + 1) * tile} ${top}v${footprintZ * tile}`} />)}{Array.from({ length: footprintZ - 1 }, (_, index) => <path key={'z' + index} d={`M${left} ${top + (index + 1) * tile}h${footprintX * tile}`} />)}<text x="128" y="242" textAnchor="middle" fill="currentColor" fillOpacity=".65" stroke="none" fontSize="11">{footprintX} × {footprintZ} tile footprint</text></g>}
  </svg>;
}

function AnimationPanel({ project, candidate, direction, onDirection, actualSize, guides, onDesignFrames, designDisabled, designReason, generating }: { project: SpriteProject; candidate?: SpriteCandidate; direction: SpriteDirection; onDirection: (value: SpriteDirection) => void; actualSize: boolean; guides: boolean; onDesignFrames: () => void; designDisabled: boolean; designReason: string; generating: boolean }) {
  const [approved, setApproved] = useState(false), [playing, setPlaying] = useState(false), [onion, setOnion] = useState(false), [frame, setFrame] = useState(0), [speed, setSpeed] = useState(1), [allViews, setAllViews] = useState(true);
  const artFor = (view: SpriteDirection) => approved ? getApproved(project, view) : candidate?.directions[view];
  const art = approved ? getApproved(project, direction) : candidate?.directions[direction];
  const count = allViews ? Math.max(0, ...directions.map(view => artFor(view)?.frames.length ?? 0)) : art?.frames.length ?? 0, tpf = project.recipe.ticksPerFrame;
  useEffect(() => { setPlaying(false); setFrame(0); }, [direction, candidate?.id, approved, project.id]);
  useEffect(() => {
    if (!playing || count < 2) return;
    const start = performance.now(), loopTicks = (count + 1) * tpf;
    const timer = window.setInterval(() => { const tick = Math.floor((performance.now() - start) * 60 / 1000 * speed); setFrame(Math.min(count - 1, Math.floor((tick % loopTicks) / tpf))); }, 16);
    return () => window.clearInterval(timer);
  }, [playing, count, tpf, speed]);
  return <section className="sprite-animation">{count < 2 && <div className="sprite-flight-start" data-sprite-flight-start><div><h3>Design flight frames from this artwork</h3><p>Your existing family is ready. The model redraws the design as SVG layers, then animates the wings in south, east and north views. The imported PNG is preserved.</p><small>Review the generated revision for a match to your master artwork before approving it.</small></div><button type="button" className="sprite-button sprite-primary" disabled={designDisabled} onClick={onDesignFrames}>{generating ? 'Designing…' : 'Design flight frames'}</button>{designReason && <p className="sprite-design-reason">{designReason}</p>}</div>}<div className="sprite-animation-toolbar"><div className="sprite-direction-pills">{directions.map(value => <button type="button" className="sprite-button" key={value} aria-pressed={direction === value} onClick={() => onDirection(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><label><input type="checkbox" checked={allViews} onChange={event => { setAllViews(event.target.checked); setPlaying(false); setFrame(0); }} /> All directions</label><label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /> Approved artwork</label></div>
    {allViews ? <div className="sprite-flight-grid">{directions.map(view => <article key={view}><h3>{getSpriteSlotLabel(view)}</h3><SpriteImage projectId={project.id} art={artFor(view)} label={view + ' flight frame ' + (frame + 1)} actualSize={actualSize} guides={guides} frame={frame} onion={onion} /></article>)}<article><h3>West · mirrored east</h3><SpriteImage projectId={project.id} art={artFor('east')} label={'West mirrored flight frame ' + (frame + 1)} actualSize={actualSize} guides={guides} frame={frame} onion={onion} mirrored /></article></div> : <SpriteImage projectId={project.id} art={art} label={direction + ' flight frame ' + (frame + 1)} actualSize={actualSize} guides={guides} frame={frame} onion={onion} />}
    {count > 1 && <><div className="sprite-playback"><button type="button" className="sprite-button sprite-primary" aria-label={playing ? 'Pause flight preview' : 'Play flight preview'} onClick={() => setPlaying(value => !value)}>{playing ? 'Ⅱ Pause' : '▶ Play'}</button><button type="button" className="sprite-button" aria-label="Previous flight frame" onClick={() => { setPlaying(false); setFrame(value => (value + count - 1) % count); }}>‹</button><button type="button" className="sprite-button" aria-label="Next flight frame" onClick={() => { setPlaying(false); setFrame(value => (value + 1) % count); }}>›</button><span>{frame + 1} / {count} frames</span><label>Preview speed<select aria-label="Flight preview speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label><label><input type="checkbox" checked={onion} onChange={event => setOnion(event.target.checked)} /> Onion skin</label></div>
    <input type="range" aria-label="Flight frame" min={0} max={count - 1} value={Math.min(frame, count - 1)} onChange={event => { setPlaying(false); setFrame(Number(event.target.value)); }} /></>}
    <p className="sprite-muted">{count > 1 ? `${count} frames · ${tpf} ticks per frame · ${((count + 1) * tpf / 60).toFixed(2)}s loop at game speed. All views share the same flight phase. The final frame is held for one extra interval to match RimWorld timing.` : project.recipe.kind === 'bird' ? 'A flat PNG has no movable wing layers. Generate a layered bird revision to preview flight.' : 'This family is a static sprite. Choose a bird family to create flight animation.'}</p>
  </section>;
}

function SpriteGlyph({ bird = false }: { bird?: boolean }) {
  return <svg aria-hidden viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{bird ? <><path d="M9 30c4-3 7-9 13-9 4 0 6 3 8 3l7-3-2 6c-3 3-6 5-12 5H9Z" /><path d="M22 25c-7-4-9-11-7-15 9 4 12 9 12 15M35 25l6 2-7 2M16 31l-7 7 13-6" /><circle cx="31" cy="25" r=".8" fill="currentColor" /></> : <><path d="M10 13h28v24H10zM16 23l8-8 8 8v8H16zM10 8h28M6 13v24" /><path d="M20 31v-7h8v7" /></>}</svg>;
}
