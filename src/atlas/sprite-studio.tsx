import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelOption } from '../agent/models';
import type { ModelSelection } from '../agent/settings';
import { ModelPicker } from '../components/model-picker';
import { spriteAssetUrl, type SpriteArt, type SpriteCandidate, type SpriteDirection, type SpriteExportPlan, type SpriteProject, type SpriteProjectSummary, type SpriteRecipe, type SpriteStudioApi } from './sprite-studio-types';
import './sprite-studio.css';

type Mod = { folder: string; title?: string; name?: string; game?: string };
type StudioTask = { id: string; projectId?: string; kind?: string; status: string; phase: string };
const directions: SpriteDirection[] = ['south', 'east', 'north'];
const directionNames: Record<SpriteDirection, string> = { south: 'South · front', east: 'East · side', north: 'North · back' };
const initialRecipe: SpriteRecipe = { name: '', kind: 'bird', brief: '', palette: ['#f1e9d0', '#8c9d78', '#414c39', '#262923'], canvasSize: 256, frameCount: 8, ticksPerFrame: 2, drawSize: 1.5, groundedDrawSize: 0.7, textureName: 'NewBird' };
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
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newRecipe, setNewRecipe] = useState<SpriteRecipe>({ ...initialRecipe });
  const [recipe, setRecipe] = useState<SpriteRecipe>({ ...initialRecipe });
  const [palette, setPalette] = useState(initialRecipe.palette.join(', '));
  const [newPalette, setNewPalette] = useState(initialRecipe.palette.join(', '));
  const [selected, setSelected] = useState<SpriteDirection[]>([...directions]);
  const [candidateId, setCandidateId] = useState('');
  const [direction, setDirection] = useState<SpriteDirection>('south');
  const [tab, setTab] = useState<'directions' | 'animation' | 'compare'>('directions');
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
  projectRef.current = project;
  const task = tasks.find(item => item.status === 'running' && project && (item.projectId === project.id || item.id === 'sprite:' + project.id));
  const generating = pending === 'generation' || !!task;
  const busy = !!pending || !!task || loading;
  const candidate = project?.candidates.find(item => item.id === candidateId) ?? project?.candidates.at(-1);
  const hasArt = !!project?.candidates.some(item => Object.keys(item.directions).length);
  const dirty = !!project && (JSON.stringify(recipe) !== JSON.stringify(project.recipe) || palette !== project.recipe.palette.join(', '));
  const visible = families.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const rimworldMods = mods.filter(mod => !mod.game || mod.game === 'rimworld');
  const effectiveModel = useMemo(() => {
    const sorted = [...models].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
    const choice = sorted.find(item => item.provider === model?.provider && item.modelId === model.modelId) ?? sorted[0];
    return choice ? { provider: choice.provider, modelId: choice.modelId } : null;
  }, [models, model]);
  const selectedModel = effectiveModel ? models.find(item => item.provider === effectiveModel.provider && item.modelId === effectiveModel.modelId) : undefined;
  const visualReferenceUnavailable = selectedModel?.vision === false && !!project && (project.references.length > 0 || Object.keys(project.approved).length > 0);

  function accept(value: SpriteProject, selection?: string) {
    setProject(value); setRecipe({ ...value.recipe }); setPalette(value.recipe.palette.join(', ')); setPlan(null);
    setCandidateId(value.candidates.some(item => item.id === selection) ? selection! : value.candidates.at(-1)?.id ?? '');
    setFamilies(list => [{ id: value.id, name: value.recipe.name, kind: value.recipe.kind, updatedAt: value.updatedAt, approvedCount: Object.keys(value.approved).length, preview: getApproved(value, 'south')?.preview ?? value.candidates.at(-1)?.directions.south?.preview ?? null }, ...list.filter(item => item.id !== value.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
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
    try { const value = await api().spriteRead(id); if (alive.current && request === loadId.current) { accept(value); setSelected(['south']); setDirection('south'); setInstruction(''); } }
    catch (e) { if (alive.current && request === loadId.current) setError(message(e)); }
    finally { if (alive.current && request === loadId.current) setLoading(false); }
  }
  async function run(label: string, operation: () => Promise<SpriteProject | null>, success = '') {
    if (busy) return false;
    const request = ++actionId.current, id = project?.id;
    setPending(label); setError(''); setNotice(''); setPlan(null);
    try {
      const value = await operation();
      if (alive.current && request === actionId.current && (!id || projectRef.current?.id === id)) { if (value) accept(value, ['approve', 'save', 'reference'].includes(label) ? candidateId : undefined); if (value && success) setNotice(success); }
      return !!value;
    } catch (e) { if (alive.current && request === actionId.current) setError(message(e)); return false; }
    finally { if (alive.current && request === actionId.current) setPending(''); }
  }
  function parsedPalette(value: string): string[] {
    const colors = [...new Set(value.split(/[\s,]+/).filter(Boolean).map(color => color.toLowerCase()))];
    if (colors.length < 2 || colors.length > 16 || colors.some(color => !/^#[0-9a-f]{6}$/i.test(color))) throw new Error('Enter 2–16 colors as six-digit hex values, such as #8c9d78.');
    return colors;
  }
  async function createFamily(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    try { const value = { ...newRecipe, palette: parsedPalette(newPalette) }; const created = await run('create', () => api().spriteCreate(value), 'Family created. Import a reference or generate the shared directions.'); if (alive.current && created) { setCreating(false); setSelected([...directions]); } }
    catch (e) { setError(message(e)); }
  }
  async function saveRecipe() {
    if (!project) return;
    try { const value = { ...recipe, palette: parsedPalette(palette) }; await run('save', () => api().spriteSaveRecipe(project.id, value, project.version), 'Recipe saved.'); }
    catch (e) { setError(message(e)); }
  }
  async function previewExport() {
    if (!project || busy || !target) return;
    setPending('export-plan'); setError(''); setNotice('');
    try { const value = await api().spriteExportPlan(project.id, target, project.version); if (alive.current) { setPlan(value); setExporting(true); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setPending(''); }
  }
  async function applyExport() {
    if (!plan || busy) return;
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
  const toggleDirection = (value: SpriteDirection) => setSelected(list => list.includes(value) ? list.filter(item => item !== value) : directions.filter(item => item === value || list.includes(item)));

  return <main className="atlas-sprite-studio" data-atlas-sprite-studio>
    <header className="sprite-studio-heading"><div><h1>Sprite Studio</h1><p>One design. Consistent directions. Repeatable flight animation.</p></div><span className="sprite-mode-tag">RimWorld · Reference guided</span></header>
    {error && <div className="sprite-message sprite-error" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss Sprite Studio error" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="sprite-message" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss Sprite Studio notice" onClick={() => setNotice('')}>×</button></div>}
    <div className="sprite-studio-layout">
      <aside className="sprite-family-pane" aria-label="Sprite families"><div className="sprite-pane-heading"><h2>Sprite families</h2><button type="button" className="sprite-button sprite-primary" disabled={busy} onClick={() => { setCreating(true); setError(''); setNotice(''); setNewRecipe({ ...initialRecipe }); setNewPalette(initialRecipe.palette.join(', ')); }}>+ New</button></div>
        <input type="search" aria-label="Find sprite family" placeholder="Find a family…" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="sprite-family-list">{loading && !families.length ? <p className="sprite-muted" role="status">Loading families…</p> : visible.map(item => <button type="button" key={item.id} className={'sprite-family' + (project?.id === item.id && !creating ? ' selected' : '')} aria-pressed={project?.id === item.id && !creating} disabled={!!pending} onClick={() => void openFamily(item.id)}>
          <span className="sprite-family-thumb">{item.preview ? <img loading="lazy" src={spriteAssetUrl(item.id, item.preview)} alt="" /> : <SpriteGlyph bird={item.kind === 'bird'} />}</span><span><strong>{item.name}</strong><small>{item.kind === 'bird' ? 'Bird flight' : 'Directional sprite'} · {item.approvedCount}/3 approved</small></span></button>)}
          {!loading && !visible.length && <p className="sprite-muted">{families.length ? 'No matching families.' : 'Your saved designs will appear here.'}</p>}</div>
        <p className="sprite-storage-note">Recipes, references and revisions stay in your portable Atlas folder.</p>
      </aside>
      {creating ? <section className="sprite-new-family" aria-labelledby="sprite-new-title"><h2 id="sprite-new-title">Create a sprite family</h2><p className="sprite-muted">Define the shared identity first. Every direction and frame uses this recipe.</p><form onSubmit={event => void createFamily(event)}>
        <RecipeFields value={newRecipe} onChange={setNewRecipe} palette={newPalette} onPalette={setNewPalette} locked={busy} disabled={busy} prefix="sprite-new" />
        <div className="sprite-actions"><button type="button" className="sprite-button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button><button type="submit" className="sprite-button sprite-primary" disabled={busy || !newRecipe.name.trim() || !newRecipe.brief.trim()}>{pending === 'create' ? 'Creating…' : 'Create family'}</button></div>
      </form></section> : project ? <>
        <section className="sprite-workspace" aria-label="Sprite workspace"><header className="sprite-project-heading"><div><h2>{project.recipe.name}</h2><p>{loading ? 'Loading selected family…' : `${project.recipe.canvasSize} × ${project.recipe.canvasSize} · ${Object.keys(project.approved).length}/3 directions approved`}</p></div><button type="button" className="sprite-button" disabled={busy} onClick={() => void api().spriteReveal(project.id).catch(e => alive.current && setError(message(e)))}>Open folder</button></header>
          <div className="sprite-workspace-tabs" role="tablist" aria-label="Sprite workspace view">{(['directions', 'animation', 'compare'] as const).map(value => <button type="button" role="tab" key={value} id={'sprite-tab-' + value} aria-controls={'sprite-panel-' + value} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const all = ['directions', 'animation', 'compare'] as const, next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (all.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3; setTab(all[next]); document.getElementById('sprite-tab-' + all[next])?.focus(); }}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
          <div className="sprite-workspace-scroll"><div className="sprite-candidate-bar"><label htmlFor="sprite-revision">Revision</label><select id="sprite-revision" value={candidate?.id ?? ''} onChange={event => setCandidateId(event.target.value)} disabled={!project.candidates.length || busy}><option value="" disabled>No artwork yet</option>{[...project.candidates].reverse().map((item, index) => <option key={item.id} value={item.id}>{item.source === 'imported' ? 'Imported' : 'Generated'} · {stamp(item.createdAt)}{index === 0 ? ' · latest' : ''}</option>)}</select><span className="sprite-muted">{candidate?.model || 'Choose a direction to begin'}</span></div>
            <div className="sprite-display-tools"><label><input type="checkbox" checked={actualSize} onChange={event => setActualSize(event.target.checked)} /> Actual size</label><label><input type="checkbox" checked={guides} onChange={event => setGuides(event.target.checked)} /> Centre guides</label></div>
            <div role="tabpanel" id={'sprite-panel-' + tab} aria-labelledby={'sprite-tab-' + tab} tabIndex={0}>
              {tab === 'directions' && <div className="sprite-direction-grid">{directions.map(value => {
                const art = candidate?.directions[value], approved = project.approved[value] === candidate?.id && !!art;
                return <article key={value} className={'sprite-direction-card' + (direction === value ? ' selected' : '')}><button type="button" className="sprite-direction-select" aria-pressed={direction === value} onClick={() => setDirection(value)}><span>{directionNames[value]}</span><small className={approved ? 'sprite-approved' : ''}>{approved ? 'Approved' : art ? 'Candidate' : 'Missing'}</small><SpriteImage projectId={project.id} art={art} label={directionNames[value]} actualSize={actualSize} guides={guides} /></button><div className="sprite-card-actions"><button type="button" className="sprite-button" disabled={busy} onClick={() => void run('import', () => api().spriteImport(project.id, value, project.version), 'Imported image saved as a new revision.')}>Import PNG</button><button type="button" className="sprite-button" disabled={busy || !art || approved} onClick={() => candidate && void run('approve', () => api().spriteApprove(project.id, candidate.id, [value], project.version), `${directionNames[value].split(' · ')[0]} direction approved.`)}>{approved ? '✓ Approved' : 'Approve'}</button></div></article>;
              })}<article className="sprite-direction-card sprite-mirrored"><div className="sprite-direction-select"><span>West · mirrored east</span><small>Shared identity</small><SpriteImage projectId={project.id} art={candidate?.directions.east} label="West preview, mirrored from east" actualSize={actualSize} guides={guides} mirrored /></div><p>West uses the east artwork mirrored. No separate generation.</p></article></div>}
              {tab === 'animation' && <AnimationPanel project={project} candidate={candidate} direction={direction} onDirection={setDirection} actualSize={actualSize} guides={guides} />}
              {tab === 'compare' && <><div className="sprite-direction-pills">{directions.map(value => <button type="button" key={value} className="sprite-button" aria-pressed={direction === value} onClick={() => setDirection(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><div className="sprite-compare"><article><h3>Approved</h3><SpriteImage projectId={project.id} art={getApproved(project, direction)} label={'Approved ' + direction} actualSize={actualSize} guides={guides} /><p className="sprite-muted">The version used by export.</p></article><article><h3>Selected revision</h3><SpriteImage projectId={project.id} art={candidate?.directions[direction]} label={'Candidate ' + direction} actualSize={actualSize} guides={guides} /><button type="button" className="sprite-button sprite-primary" disabled={busy || !candidate?.directions[direction] || project.approved[direction] === candidate.id} onClick={() => candidate && void run('approve', () => api().spriteApprove(project.id, candidate.id, [direction], project.version), 'Approved this revision. Earlier revisions are preserved.')}>Use this revision</button></article></div></>}
            </div>
            {candidate && <div className="sprite-art-warnings">{[...new Set(Object.values(candidate.directions).flatMap(art => art?.warnings ?? []))].map(text => <p key={text}>{text}</p>)}</div>}
            <section className="sprite-generation" aria-labelledby="sprite-generation-title"><div className="sprite-section-heading"><h3 id="sprite-generation-title">Generate a revision</h3><span className="sprite-muted">Approved artwork stays locked</span></div><fieldset disabled={busy}><legend>Directions to generate</legend><div className="sprite-direction-checks">{directions.map(value => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={() => toggleDirection(value)} />{value[0].toUpperCase() + value.slice(1)}{project.approved[value] && <small>approved</small>}</label>)}</div></fieldset><label htmlFor="sprite-instruction">Changes for this revision <span className="sprite-muted">(optional)</span></label><textarea id="sprite-instruction" maxLength={4000} rows={2} value={instruction} disabled={busy} onChange={event => setInstruction(event.target.value)} placeholder="For example: longer tail, same feather markings and colors…" />
              {generating ? <div className="sprite-running" role="status"><div><span className="sprite-progress-dot" /><strong>{task?.phase || 'Creating a consistent revision…'}</strong><div className="sprite-generation-progress" role="progressbar" aria-label="Sprite generation progress" aria-valuetext={task?.phase || 'Creating a consistent revision'}><span /></div><p>Generation continues if you leave this tab. View progress in Activity.</p></div><button type="button" className="sprite-button" onClick={() => void api().spriteCancel(project.id).then(() => alive.current && setNotice('Stopping generation…')).catch(e => alive.current && setError(message(e)))}>Stop</button></div> : <div className="sprite-actions"><p className="sprite-muted">Uses your connected AI account to draw layered artwork. Revisions are saved for review.</p><button type="button" className="sprite-button sprite-primary" disabled={busy || !selected.length || !effectiveModel || dirty} onClick={() => void run('generation', () => api().spriteGenerate({ projectId: project.id, version: project.version, directions: selected, instruction, model: effectiveModel }), 'Revision ready. Compare it with approved artwork before exporting.')}>{pending === 'generation' ? 'Generating…' : 'Generate ' + selected.length + (selected.length === 1 ? ' direction' : ' directions')}</button></div>}
              {dirty && <p className="sprite-muted">Save your recipe before generating.</p>}
            </section>
            <section className="sprite-export" aria-labelledby="sprite-export-title"><h3 id="sprite-export-title">Export to a mod</h3><p className="sprite-muted">Only approved directions are exported. Review file replacements and XML first.</p><div className="sprite-export-target"><select aria-label="Target RimWorld mod" value={target} disabled={busy} onChange={event => { setTarget(event.target.value); setPlan(null); }}><option value="">Choose a RimWorld mod…</option>{rimworldMods.map(mod => <option value={mod.folder} key={mod.folder}>{mod.title || mod.name || mod.folder}</option>)}</select><button type="button" className="sprite-button" disabled={busy || !target || !Object.keys(project.approved).length} onClick={() => void previewExport()}>{pending === 'export-plan' ? 'Preparing…' : 'Preview export'}</button></div>{!rimworldMods.length && <p className="sprite-muted">Create or import a RimWorld mod from Home to export artwork into it.</p>}
              {exporting && plan && <div className="sprite-export-preview"><div className="sprite-section-heading"><h4>Review export</h4><button type="button" className="sprite-button" disabled={busy} onClick={() => { setExporting(false); setPlan(null); }}>Close preview</button></div><p className="sprite-muted">{plan.rows.length} PNG files · Existing files will be backed up.</p><div className="sprite-export-rows">{plan.rows.map(row => <div key={row.path}><code>{row.path}</code><span>{row.action === 'replace' ? 'Replace · backup' : 'Create'}</span></div>)}</div>{plan.warnings.map(text => <p className="sprite-export-warning" key={text}>{text}</p>)}<div className="sprite-xml-heading"><h4>XML reference</h4><button type="button" className="sprite-button" onClick={() => void copyXml()}>Copy XML</button></div><details><summary>View XML · paste into your def</summary><pre>{plan.xml}</pre></details><button type="button" className="sprite-button sprite-primary" disabled={busy || !plan.rows.length} onClick={() => void applyExport()}>{pending === 'export' ? 'Exporting…' : 'Export approved PNGs'}</button></div>}
            </section>
          </div>
        </section>
        <aside className="sprite-inspector" aria-label="Family recipe"><div className="sprite-pane-heading"><h2>Family recipe</h2>{hasArt && <span className="sprite-mode-tag">Recipe locked</span>}</div><p className="sprite-muted">{hasArt ? 'Canvas, palette and frame settings stay fixed after artwork is created. The name and brief can be refined.' : 'Shared settings guide every direction and frame.'}</p><RecipeFields value={recipe} onChange={setRecipe} palette={palette} onPalette={value => { setPalette(value); try { setRecipe(current => ({ ...current, palette: parsedPalette(value) })); } catch {} }} locked={hasArt || busy} disabled={busy} prefix="sprite-recipe" /><button type="button" className="sprite-button" disabled={busy || !dirty} onClick={() => void saveRecipe()}>{pending === 'save' ? 'Saving…' : 'Save recipe'}</button>
          <section className="sprite-references"><div className="sprite-section-heading"><h3>References</h3><button type="button" className="sprite-button" disabled={busy} onClick={() => void run('reference', () => api().spriteImport(project.id, 'reference', project.version), 'Reference copied into this family.')}>Add PNG</button></div><p className="sprite-muted">Approved directions and these references guide the shared appearance.</p><div className="sprite-reference-list">{project.references.map(reference => <figure key={reference.id}><img loading="lazy" src={spriteAssetUrl(project.id, reference.path)} alt={reference.name} /><figcaption title={reference.name}>{reference.name}</figcaption></figure>)}</div>{!project.references.length && <p className="sprite-muted">Add a design, silhouette or palette reference to guide your first revision.</p>}</section>
          <section className="sprite-model"><h3>Drawing model</h3><ModelPicker models={models} current={effectiveModel} onChange={setModel} onConnect={onConnect} /><p className="sprite-muted">Uses the selected connected model and its normal account usage. No separate image API is used. Consistency comes from the saved recipe, references and shared wing rig.</p>{visualReferenceUnavailable && <p className="sprite-model-warning" role="status">This model cannot view images. Your reference images and approved previews cannot visually guide it; choose a model with image input for closer consistency.</p>}</section>
        </aside>
      </> : <section className="sprite-welcome"><SpriteGlyph bird /><span className="sprite-mode-tag">Start with one approved design</span><h2>Keep every view in one family</h2><p>Keep colors and anatomy together across south, east and north views. For birds, layered wings animate around a fixed body so markings stay consistent.</p><div className="sprite-welcome-steps"><div><span>1</span><strong>Define the identity</strong><p>Add a brief, palette and reference.</p></div><div><span>2</span><strong>Review every direction</strong><p>Compare revisions and approve your favorites.</p></div><div><span>3</span><strong>Preview and export</strong><p>Check the flight loop and approve the exact files.</p></div></div><button type="button" className="sprite-button sprite-primary" onClick={() => setCreating(true)}>Create your first family</button><p className="sprite-welcome-note">This workspace draws SVG layers with your connected model. Imported flat PNGs stay static; generate a layered revision to create flight animation.</p></section>}
    </div>
  </main>;
}

function RecipeFields({ value, onChange, palette, onPalette, locked = false, disabled = false, prefix }: { value: SpriteRecipe; onChange: (value: SpriteRecipe) => void; palette: string; onPalette: (value: string) => void; locked?: boolean; disabled?: boolean; prefix: string }) {
  const patch = (field: keyof SpriteRecipe, next: SpriteRecipe[keyof SpriteRecipe]) => onChange({ ...value, [field]: next });
  return <div className="sprite-recipe-fields">
    <label htmlFor={prefix + '-name'}>Family name<input id={prefix + '-name'} value={value.name} maxLength={80} required disabled={disabled} onChange={event => patch('name', event.target.value)} placeholder="Silver marsh bird" /></label>
    <label htmlFor={prefix + '-kind'}>Asset type<select id={prefix + '-kind'} value={value.kind} disabled={locked} onChange={event => onChange({ ...value, kind: event.target.value as SpriteRecipe['kind'], frameCount: event.target.value === 'bird' ? 8 : 1, groundedDrawSize: event.target.value === 'bird' ? 0.7 : 1 })}><option value="bird">Bird · directional flight</option><option value="sprite">Sprite · pawn directional artwork</option></select></label>
    <label htmlFor={prefix + '-brief'}>Design brief<textarea id={prefix + '-brief'} value={value.brief} maxLength={4000} required rows={3} disabled={disabled} onChange={event => patch('brief', event.target.value)} placeholder="Describe its shape, markings and overall appearance…" /></label>
    <label htmlFor={prefix + '-palette'}>Shared palette<input id={prefix + '-palette'} value={palette} disabled={locked} onChange={event => onPalette(event.target.value)} placeholder="#f1e9d0, #8c9d78" /><small>Six-digit hex colors, separated by commas.</small></label>
    <div className="sprite-palette-swatches">{palette.split(/[\s,]+/).filter(color => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 16).map((color, index) => <span key={color + index} style={{ backgroundColor: color }} title={color} />)}</div>
    <div className="sprite-field-pair"><label htmlFor={prefix + '-canvas'}>Canvas<select id={prefix + '-canvas'} value={value.canvasSize} disabled={locked} onChange={event => patch('canvasSize', Number(event.target.value) as SpriteRecipe['canvasSize'])}>{[128, 256, 512].map(size => <option key={size} value={size}>{size} × {size}</option>)}</select></label><label htmlFor={prefix + '-size'}>{value.kind === 'bird' ? 'Flight draw size' : 'Draw size'}<input id={prefix + '-size'} type="number" min="0.1" max="10" step="0.1" value={value.drawSize} disabled={locked} onChange={event => patch('drawSize', Number(event.target.value))} /></label></div>
    {value.kind === 'bird' && <label htmlFor={prefix + '-grounded-size'}>Grounded draw size<input id={prefix + '-grounded-size'} type="number" min="0.1" max="10" step="0.1" value={value.groundedDrawSize ?? 0.7} disabled={locked} onChange={event => patch('groundedDrawSize', Number(event.target.value))} /><small>Independent size for the bird while standing.</small></label>}
    <label htmlFor={prefix + '-texture'}>Texture name<input id={prefix + '-texture'} value={value.textureName} required maxLength={64} pattern="[A-Za-z][A-Za-z0-9_]*" disabled={locked} onChange={event => patch('textureName', event.target.value)} placeholder="SilverMarshBird" /><small>Letters, numbers and underscores; begins with a letter.</small></label>
    {value.kind === 'bird' && <div className="sprite-field-pair"><label htmlFor={prefix + '-frames'}>Flight frames<select id={prefix + '-frames'} value={8} disabled aria-describedby={prefix + '-frame-note'}><option value={8}>8 · RimWorld bird</option></select><small id={prefix + '-frame-note'}>Matches Odyssey bird flight.</small></label><label htmlFor={prefix + '-timing'}>Ticks per frame<input id={prefix + '-timing'} type="number" min="1" max="30" value={value.ticksPerFrame} disabled={locked} onChange={event => patch('ticksPerFrame', Number(event.target.value))} /></label></div>}
  </div>;
}

function SpriteImage({ projectId, art, label, actualSize, guides, mirrored = false, frame, onion }: { projectId: string; art?: SpriteArt; label: string; actualSize: boolean; guides: boolean; mirrored?: boolean; frame?: number; onion?: boolean }) {
  const path = typeof frame === 'number' && art?.frames.length ? art.frames[Math.min(frame, art.frames.length - 1)] : art?.preview;
  const [failed, setFailed] = useState<string | null>(null);
  return <div className={'sprite-image-stage' + (actualSize ? ' sprite-actual-size' : '') + (guides ? ' sprite-guides' : '')}>{path && failed !== path ? <>{onion && art && art.frames.length > 1 && typeof frame === 'number' && <img className="sprite-onion" loading="lazy" draggable={false} src={spriteAssetUrl(projectId, art.frames[(frame + art.frames.length - 1) % art.frames.length])} alt="" aria-hidden style={mirrored ? { transform: 'scaleX(-1)' } : undefined} />}<img className="sprite-art" loading="lazy" draggable={false} onError={() => setFailed(path)} src={spriteAssetUrl(projectId, path)} alt={label} style={mirrored ? { transform: 'scaleX(-1)' } : undefined} /></> : <div className="sprite-empty-slot"><SpriteGlyph /><span>{path ? 'Artwork file unavailable' : 'No artwork yet'}</span></div>}</div>;
}

function AnimationPanel({ project, candidate, direction, onDirection, actualSize, guides }: { project: SpriteProject; candidate?: SpriteCandidate; direction: SpriteDirection; onDirection: (value: SpriteDirection) => void; actualSize: boolean; guides: boolean }) {
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
  return <section className="sprite-animation"><div className="sprite-animation-toolbar"><div className="sprite-direction-pills">{directions.map(value => <button type="button" className="sprite-button" key={value} aria-pressed={direction === value} onClick={() => onDirection(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><label><input type="checkbox" checked={allViews} onChange={event => { setAllViews(event.target.checked); setPlaying(false); setFrame(0); }} /> All directions</label><label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /> Approved artwork</label></div>
    {allViews ? <div className="sprite-flight-grid">{directions.map(view => <article key={view}><h3>{directionNames[view]}</h3><SpriteImage projectId={project.id} art={artFor(view)} label={view + ' flight frame ' + (frame + 1)} actualSize={actualSize} guides={guides} frame={frame} onion={onion} /></article>)}<article><h3>West · mirrored east</h3><SpriteImage projectId={project.id} art={artFor('east')} label={'West mirrored flight frame ' + (frame + 1)} actualSize={actualSize} guides={guides} frame={frame} onion={onion} mirrored /></article></div> : <SpriteImage projectId={project.id} art={art} label={direction + ' flight frame ' + (frame + 1)} actualSize={actualSize} guides={guides} frame={frame} onion={onion} />}
    <div className="sprite-playback"><button type="button" className="sprite-button sprite-primary" disabled={count < 2} aria-label={playing ? 'Pause flight preview' : 'Play flight preview'} onClick={() => setPlaying(value => !value)}>{playing ? 'Ⅱ Pause' : '▶ Play'}</button><button type="button" className="sprite-button" disabled={!count} aria-label="Previous flight frame" onClick={() => { setPlaying(false); setFrame(value => (value + count - 1) % count); }}>‹</button><button type="button" className="sprite-button" disabled={!count} aria-label="Next flight frame" onClick={() => { setPlaying(false); setFrame(value => (value + 1) % count); }}>›</button><span>{count ? frame + 1 : 0} / {count} frames</span><label>Preview speed<select aria-label="Flight preview speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label><label><input type="checkbox" checked={onion} onChange={event => setOnion(event.target.checked)} /> Onion skin</label></div>
    <input type="range" aria-label="Flight frame" min={0} max={Math.max(0, count - 1)} value={Math.min(frame, Math.max(0, count - 1))} disabled={!count} onChange={event => { setPlaying(false); setFrame(Number(event.target.value)); }} />
    <p className="sprite-muted">{count > 1 ? `${count} frames · ${tpf} ticks per frame · ${((count + 1) * tpf / 60).toFixed(2)}s loop at game speed. All views share the same flight phase. The final frame is held for one extra interval to match RimWorld timing.` : project.recipe.kind === 'bird' ? 'A flat PNG has no movable wing layers. Generate a layered bird revision to preview flight.' : 'This family is a static sprite. Choose a bird family to create flight animation.'}</p>
  </section>;
}

function SpriteGlyph({ bird = false }: { bird?: boolean }) {
  return <svg aria-hidden viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{bird ? <><path d="M9 30c4-3 7-9 13-9 4 0 6 3 8 3l7-3-2 6c-3 3-6 5-12 5H9Z" /><path d="M22 25c-7-4-9-11-7-15 9 4 12 9 12 15M35 25l6 2-7 2M16 31l-7 7 13-6" /><circle cx="31" cy="25" r=".8" fill="currentColor" /></> : <><path d="M10 13h28v24H10zM16 23l8-8 8 8v8H16zM10 8h28M6 13v24" /><path d="M20 31v-7h8v7" /></>}</svg>;
}
