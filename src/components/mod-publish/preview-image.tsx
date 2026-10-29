import { useEffect, useState, type DragEvent } from 'react';
import { useAsyncAction } from '@/lib/use-async-action';
import { ErrorBanner, Field } from './ui';
import type { PreviewCandidate } from '@/agent/assets/preview-protection';

/**
 * Workshop GIF/static preview viewer + browse/regenerate buttons. Loads the
 * selected preview through the scoped preview API
 * and re-fetches when the asset watcher fires.
 *
 * Also exposes a "Background" drop zone for an optional user-supplied image
 * (typically a game screenshot) that the agent will use as the BG layer when
 * regenerating. The source is stored in a workspace sidecar dir
 * (`.atlas/preview-bg/<folder>/source.png`) so it doesn't ship with the
 * published mod, only with the rendered preview.
 */
export function PreviewImage({
  modFolder,
  hasAi,
  onGeneratePreview,
}: {
  modFolder: string;
  hasAi: boolean;
  onGeneratePreview: () => void;
}) {
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [previewReadError, setPreviewReadError] = useState<string | null>(null);
  const [bgDataUrl, setBgDataUrl] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<PreviewCandidate | null>(null);
  const [candidateReadError, setCandidateReadError] = useState<string | null>(null);
  const candidateAction = useAsyncAction(async (action: 'apply' | 'discard') => {
    if (!candidate) return;
    if (action === 'apply') await window.modmixer.applyPreviewCandidate(modFolder, candidate.id);
    else await window.modmixer.discardPreviewCandidate(modFolder, candidate.id);
    setCandidate(await window.modmixer.getPreviewCandidate(modFolder));
    setPreviewDataUrl(await window.modmixer.readPreviewImage(modFolder));
    setCandidateReadError(null);
  });

  const browse = useAsyncAction(async () => {
    const sourceAbs = await window.modmixer.pickPreviewImage();
    if (!sourceAbs) return;
    // Run through setPreviewImage (not addAsset) so the file is normalized
    // to fit Steam's 1 MiB preview cap before it lands on disk.
    await window.modmixer.setPreviewImage(modFolder, sourceAbs);
    const url = await window.modmixer.readPreviewImage(modFolder);
    setPreviewDataUrl(url);
    setPreviewReadError(null);
  });

  const refreshBg = async () => {
    const bg = await window.modmixer.getPreviewBg(modFolder);
    setBgDataUrl(bg ? bg.dataUrl : null);
  };

  const setBgFromPath = async (sourceAbs: string) => {
    await window.modmixer.setPreviewBg(modFolder, sourceAbs);
    await refreshBg();
  };

  const browseBg = useAsyncAction(async () => {
    const sourceAbs = await window.modmixer.pickPreviewBg();
    if (!sourceAbs) return;
    await setBgFromPath(sourceAbs);
  });

  const dropBg = useAsyncAction(async (file: File) => {
    const sourceAbs = window.modmixer.getPathForFile(file);
    if (!sourceAbs) {
      throw new Error('Could not resolve dropped file path. Try Browse instead.');
    }
    await setBgFromPath(sourceAbs);
  });

  const clearBg = useAsyncAction(async () => {
    await window.modmixer.clearPreviewBg(modFolder);
    await refreshBg();
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const url = await window.modmixer.readPreviewImage(modFolder);
        if (!cancelled) { setPreviewDataUrl(url); setPreviewReadError(null); }
      } catch (error) { if (!cancelled) setPreviewReadError(error instanceof Error ? error.message : String(error)); }
      try {
        const next = await window.modmixer.getPreviewCandidate(modFolder);
        if (!cancelled) { setCandidate(next); setCandidateReadError(null); }
      } catch (error) { if (!cancelled) setCandidateReadError(error instanceof Error ? error.message : String(error)); }
    };
    void refresh();
    void refreshBg();
    // scanAssets primes the watcher so onAssetsChanged fires for this folder.
    void window.modmixer.scanAssets(modFolder).catch(() => undefined);
    const offAssets = window.modmixer.onAssetsChanged(({ folder }) => {
      if (folder === modFolder) void refresh();
    });
    const offMod = window.modmixer.onModChanged(({folder}) => { if (folder === modFolder) void refresh(); });
    return () => {
      cancelled = true;
      offAssets();
      offMod();
    };
    // refreshBg is intentionally omitted — it captures modFolder via closure
    // and we want it re-bound on folder change, which the dep array handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modFolder]);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.items).some((i) => i.kind === 'file')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    void dropBg.run(file);
  };

  const bgError = browseBg.error || dropBg.error || clearBg.error;

  return (
    <>
      <Field
        label="Preview image"
        hint="PNG, JPEG or animated GIF. GIFs must fit Steam’s 1 MiB limit; RimWorld uses a static first frame. 1280×720 recommended."
      >
        <div className="flex flex-wrap items-start gap-3">
          <div data-atlas-workshop-preview className="aspect-video w-40 shrink-0 overflow-hidden rounded-md border border-line bg-surface/60">
            {previewDataUrl ? (
              <img src={previewDataUrl} alt="Preview" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-[0.18em] text-muted">
                no image
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-1 basis-40 flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void browse.run()}
                disabled={browse.busy || candidateAction.busy}
                className="rounded-md border border-line bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {browse.busy ? 'Copying…' : previewDataUrl ? 'Replace…' : 'Browse…'}
              </button>
              <button
                onClick={onGeneratePreview}
                disabled={!hasAi || browse.busy || candidateAction.busy}
                title={!hasAi ? 'Connect an AI provider in Settings to generate.' : undefined}
                className="rounded-md bg-accent px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                {previewDataUrl ? 'Design replacement' : 'Generate'}
              </button>
            </div>
            {previewDataUrl?.startsWith('data:image/gif;') && <p className="text-xs text-muted">GIF preserved for Workshop. The in-game browser shows its first frame.</p>}
            {(browse.error || previewReadError) && <ErrorBanner>{browse.error || previewReadError}</ErrorBanner>}
          </div>
        </div>
      </Field>
      {(candidate || candidateReadError) && <div className="rounded-md border border-line bg-surface/40 p-3" data-atlas-preview-candidate>
        <p className="text-sm font-medium">Proposed preview</p>
        <p className="mt-1 text-xs text-muted">Your current preview stays unchanged until you choose Use this preview. Atlas keeps a backup when applying it.</p>
        {candidate && <div className="mt-3 flex flex-wrap items-start gap-3">
          <img src={candidate.dataUrl} alt="Proposed Workshop preview" className="aspect-video w-64 max-w-full rounded border border-line object-contain" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {candidate.warning && <p className="text-xs text-muted">{candidate.warning}</p>}
            <div className="flex flex-wrap gap-2">
              <button className="rounded-md bg-accent px-3 py-1.5 text-xs text-accent-foreground disabled:opacity-40" disabled={candidateAction.busy || browse.busy} onClick={() => void candidateAction.run('apply')}>{candidateAction.busy ? 'Working…' : 'Use this preview'}</button>
              <button className="rounded-md border border-line px-3 py-1.5 text-xs disabled:opacity-40" disabled={candidateAction.busy || browse.busy} onClick={() => void candidateAction.run('discard')}>Discard proposal</button>
            </div>
          </div>
        </div>}
        {(candidateReadError || candidateAction.error) && <ErrorBanner>{candidateReadError || candidateAction.error}</ErrorBanner>}
      </div>}

      <Field
        label="Background image (optional)"
        hint="Drop a screenshot here (PNG/JPG) and the agent will use it as the background when you Generate. Otherwise it picks a color or gradient."
        action={
          bgDataUrl ? (
            <button
              onClick={() => void clearBg.run()}
              disabled={clearBg.busy}
              className="text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              remove
            </button>
          ) : null
        }
      >
        <div className="flex items-start gap-3">
          <div
            onDragOver={onDragOver}
            onDrop={onDrop}
            className={`aspect-video w-40 shrink-0 overflow-hidden rounded-md border border-dashed bg-surface/60 transition-colors ${
              dropBg.busy
                ? 'border-accent/60'
                : 'border-line hover:border-ink/40'
            }`}
          >
            {bgDataUrl ? (
              <img
                src={bgDataUrl}
                alt="Background"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] uppercase tracking-[0.18em] text-muted">
                drop image here
              </div>
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void browseBg.run()}
                disabled={browseBg.busy || dropBg.busy}
                className="rounded-md border border-line bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {browseBg.busy || dropBg.busy
                  ? 'Copying…'
                  : bgDataUrl
                  ? 'Replace…'
                  : 'Browse…'}
              </button>
            </div>
            {bgError && <ErrorBanner>{bgError}</ErrorBanner>}
          </div>
        </div>
      </Field>
    </>
  );
}
