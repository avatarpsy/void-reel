import { useState, useEffect, useMemo } from 'react';
import { Sparkles, X, Loader2, Upload, Plus, Library, FolderOpen, Layers, Copy, UserCircle2 } from 'lucide-react';
import { useUIStore } from '../../../stores/ui-store';
import { useProjectStore } from '../../../stores/project-store';
import {
  fetchImageModels, generateStudioImage, fetchCreditSituation,
  uploadReferenceFromDataUrl, uploadReferenceFromLibraryItem, fetchAvatarContext,
  sizeToAspectRatio, aspectRatioToSize, ASPECT_LABELS,
  ImageGenError, type ImageModel, type AvatarContext,
} from '../../../services/image-generation';
import { uploadReferenceImage, uploadReferenceFromUrl } from '../../../services/generative-fill';
import {
  fetchVoidspaceLibrary, withMediaToken, NotSignedInError,
  type VoidspaceLibraryItem,
} from '../../../services/voidspace-storage';
import type { MediaAsset } from '../../../types/project';

interface ContextRef {
  id: string;
  previewUrl: string;
  publicUrl: string;
  name: string;
}

type RefSource = 'none' | 'project' | 'library' | 'avatar';
type Placement = 'layer' | 'page';

// Route a remote image through the same-origin CORS proxy for <img> previews.
function proxied(url: string): string {
  if (/^https?:\/\//i.test(url) && !url.startsWith(window.location.origin)) {
    return `/api/studio/media-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

// Load an image's natural dimensions from a data/blob URL.
function imageDims(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

/**
 * "Generate Image" popup — text-to-image via the Studio's gen-frame endpoint.
 * Opened from the "+" beside the Layers header (and PagesBar). Aspect ratio
 * defaults to the current artboard's shape. Context images can be pulled from
 * the project, the shared Library, or an upload. The result lands on a new
 * layer, or as a new page (carousel slide).
 */
export function GenerateImagePanel() {
  const open = useUIStore((s) => s.generateImageOpen);
  const asPage = useUIStore((s) => s.generateImageAsPage);
  const setOpen = useUIStore((s) => s.setGenerateImageOpen);
  const showNotification = useUIStore((s) => s.showNotification);
  const { project, selectedArtboardId, addAsset, addImageLayer, addArtboard, selectArtboard } = useProjectStore();

  const currentArtboard = project?.artboards.find((a) => a.id === selectedArtboardId) ?? project?.artboards[0];

  const [prompt, setPrompt] = useState('');
  const [catalog, setCatalog] = useState<{ models: ImageModel[]; defaultModelId: string; subscribed: boolean } | null>(null);
  const [modelId, setModelId] = useState('');
  const [aspect, setAspect] = useState('1:1');
  const [quality, setQuality] = useState('1K');
  const [placement, setPlacement] = useState<Placement>('layer');
  const [refs, setRefs] = useState<ContextRef[]>([]);
  const [refSource, setRefSource] = useState<RefSource>('none');
  const [addingRef, setAddingRef] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState<{ available?: number; required?: number; subscribed: boolean; locked?: boolean } | null>(null);

  const model = useMemo(() => catalog?.models.find((m) => m.id === modelId), [catalog, modelId]);
  const supportedAspects = model?.aspectRatios?.filter((a) => /^\d+:\d+$/.test(a)) ?? ['1:1', '9:16', '16:9', '4:5', '4:3', '3:4'];
  const maxRefs = model?.maxRefs ?? 0;
  const resolutions = model?.resolutions ?? [];
  // Some models (Seedream 5 Pro) offer a quality tier. 2K isn't supported on
  // 16:9 / 9:16, so effective quality clamps down there.
  const twoKBlocked = aspect === '16:9' || aspect === '9:16';
  const effectiveQuality = quality === '2K' && twoKBlocked ? '1K' : quality;
  const perRef = model?.perRefImageCredits ?? 0;

  // Load model catalog + set defaults when the popup opens.
  useEffect(() => {
    if (!open) return;
    setPlacement(asPage ? 'page' : 'layer');
    setError(null);
    let cancelled = false;
    fetchImageModels().then((cat) => {
      if (cancelled) return;
      setCatalog(cat);
      setModelId((prev) => prev || cat.defaultModelId || cat.models[0]?.id || '');
    });
    return () => { cancelled = true; };
  }, [open, asPage]);

  // Default the aspect to the current artboard's shape, constrained to the
  // selected model's supported ratios. Re-runs when the model changes (its
  // supported set may differ), which also guarantees the pick stays valid.
  useEffect(() => {
    if (!open || !currentArtboard) return;
    setAspect(sizeToAspectRatio(currentArtboard.size.width, currentArtboard.size.height, supportedAspects));
    // Reset quality to the model's first tier when the model changes.
    setQuality((model?.resolutions?.[0]) ?? '1K');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modelId, currentArtboard?.id]);

  if (!open) return null;

  const closeAll = () => { setOpen(false); setRefSource('none'); };

  const attachRef = async (upload: () => Promise<string>, previewUrl: string, name: string) => {
    if (refs.length >= maxRefs) return;
    setAddingRef(true);
    setError(null);
    try {
      const publicUrl = await upload();
      setRefs((r) => [...r, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, previewUrl, publicUrl, name }]);
      setRefSource('none');
    } catch (err) {
      if (err instanceof NotSignedInError) setError('Sign in to Voidspace to add a context image.');
      else setError('Could not add that context image.');
    } finally {
      setAddingRef(false);
    }
  };

  const onUploadRef = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const preview = URL.createObjectURL(file);
    void attachRef(() => uploadReferenceImage(file), preview, file.name);
  };

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await generateStudioImage({
        prompt: prompt.trim(),
        aspectRatio: aspect,
        model: modelId,
        resolution: effectiveQuality,
        referenceUrls: refs.map((r) => r.publicUrl),
      });
      const { width, height } = await imageDims(dataUrl);
      const asset: MediaAsset = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: prompt.trim().slice(0, 40) || 'Generated image',
        type: 'image',
        mimeType: 'image/png',
        size: dataUrl.length,
        width: width || 1024,
        height: height || 1024,
        thumbnailUrl: dataUrl,
        dataUrl,
      };
      addAsset(asset);

      if (placement === 'page') {
        const size = aspectRatioToSize(aspect);
        const pageName = `Page ${(project?.artboards.length ?? 0) + 1}`;
        const newId = addArtboard(pageName, size);
        selectArtboard(newId);
        // Full-bleed onto the new page.
        addImageLayer(asset.id, { x: 0, y: 0, width: size.width, height: size.height });
      } else if (currentArtboard) {
        // Fit inside the current artboard, centered.
        const s = Math.min(currentArtboard.size.width / asset.width, currentArtboard.size.height / asset.height, 1);
        const w = Math.round(asset.width * s);
        const h = Math.round(asset.height * s);
        addImageLayer(asset.id, {
          x: Math.round((currentArtboard.size.width - w) / 2),
          y: Math.round((currentArtboard.size.height - h) / 2),
          width: w,
          height: h,
        });
      } else {
        addImageLayer(asset.id);
      }

      showNotification('success', placement === 'page' ? 'Generated image added as a new page' : 'Generated image added on a new layer');
      setPrompt('');
      closeAll();
    } catch (e) {
      if (e instanceof NotSignedInError) {
        setError('Sign in to Voidspace to generate images.');
      } else if (e instanceof ImageGenError && e.code === 402) {
        const sit = await fetchCreditSituation();
        setCredits({ available: e.available, required: e.required, subscribed: sit.isSubscribed });
      } else if (e instanceof ImageGenError && (e.code === 403 || e.upgrade)) {
        setCredits({ subscribed: catalog?.subscribed ?? false, locked: true });
      } else if (e instanceof ImageGenError && (e.code === 503 || e.code === 429)) {
        setError('Image generation is busy right now — please try again in a moment.');
      } else {
        setError("Couldn't generate. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onClick={closeAll}>
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-card z-10">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={16} className="text-primary" /> Generate Image
          </span>
          <button onClick={closeAll} className="text-muted-foreground hover:text-foreground" title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Prompt */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Describe your image</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              autoFocus
              placeholder="A serene mountain lake at golden hour, cinematic wide shot…"
              className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Aspect ratio */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Aspect ratio</label>
            <div className="flex flex-wrap gap-1.5">
              {supportedAspects.map((a) => (
                <button
                  key={a}
                  onClick={() => setAspect(a)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                    aspect === a
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-input text-muted-foreground hover:text-foreground hover:border-muted-foreground'
                  }`}
                  title={a}
                >
                  {ASPECT_LABELS[a] ? `${ASPECT_LABELS[a]} · ${a}` : a}
                </button>
              ))}
            </div>
          </div>

          {/* Model */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Model</label>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="w-full px-2.5 py-2 text-xs bg-background border border-input rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {(catalog?.models ?? []).map((m) => (
                <option key={m.id} value={m.id} disabled={m.locked}>
                  {m.label}{typeof m.defaultCallCredits === 'number' ? ` — ${m.defaultCallCredits} cr` : ''}{m.locked ? ' · Plus' : ''}
                </option>
              ))}
            </select>
            {model?.description && <p className="text-[10px] text-muted-foreground">{model.description}</p>}
          </div>

          {/* Quality tier — only for models that offer more than one. */}
          {resolutions.length > 1 && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">Quality</label>
              <div className="flex gap-1 p-0.5 bg-secondary rounded-lg">
                {resolutions.map((r) => (
                  <button
                    key={r}
                    onClick={() => setQuality(r)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      quality === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {r}{r === '1K' ? ' · Basic' : r === '2K' ? ' · High' : ''}
                  </button>
                ))}
              </div>
              {quality === '2K' && twoKBlocked && (
                <p className="text-[10px] text-amber-500">2K isn't supported for {aspect} — this will render at 1K.</p>
              )}
            </div>
          )}

          {/* Context images */}
          {maxRefs > 0 && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">
                Context images <span className="text-muted-foreground/60">({refs.length}/{maxRefs})</span>
                {perRef > 0 && <span className="text-muted-foreground/60"> · +{perRef} cr per extra image</span>}
              </label>
              <div className="flex flex-wrap gap-2">
                {refs.map((r) => (
                  <div key={r.id} className="relative w-14 h-14 rounded-lg overflow-hidden border border-border group">
                    <img src={r.previewUrl} alt={r.name} className="w-full h-full object-cover" />
                    <button
                      onClick={() => setRefs((prev) => prev.filter((x) => x.id !== r.id))}
                      className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remove"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
                {refs.length < maxRefs && (
                  <button
                    onClick={() => setRefSource(refSource === 'none' ? 'project' : 'none')}
                    disabled={addingRef}
                    className="w-14 h-14 flex flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-input text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
                    title="Add context image"
                  >
                    {addingRef ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                    <span className="text-[9px]">Add</span>
                  </button>
                )}
              </div>

              {refSource !== 'none' && (
                <ContextSourcePicker
                  source={refSource}
                  setSource={setRefSource}
                  onPickProject={(asset) => {
                    const src = asset.dataUrl || asset.thumbnailUrl;
                    void attachRef(() => uploadReferenceFromDataUrl(src, asset.name), asset.thumbnailUrl, asset.name);
                  }}
                  onPickLibrary={(item, token) =>
                    void attachRef(() => uploadReferenceFromLibraryItem(item, token), withMediaToken(item.thumbnailUrl || item.url, token), item.label)
                  }
                  onPickAvatar={(url, name) =>
                    void attachRef(() => uploadReferenceFromUrl(url), proxied(url), name)
                  }
                  onUpload={onUploadRef}
                  busy={addingRef}
                />
              )}
            </div>
          )}

          {/* Placement */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Add as</label>
            <div className="flex gap-1 p-0.5 bg-secondary rounded-lg">
              {([['layer', 'New layer', Layers], ['page', 'New page', Copy]] as const).map(([val, label, Icon]) => (
                <button
                  key={val}
                  onClick={() => setPlacement(val)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    placement === val ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>
            {placement === 'page' && (
              <p className="text-[10px] text-muted-foreground">Adds a new page (carousel slide) sized {aspect}. Build a carousel by generating several pages, then Publish.</p>
            )}
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}

          <button
            onClick={generate}
            disabled={busy || addingRef || !prompt.trim() || !modelId}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {busy ? <><Loader2 size={15} className="animate-spin" /> Generating…</> : <><Sparkles size={15} /> Generate</>}
          </button>
        </div>
      </div>

      {/* Out-of-credits / upgrade popup. */}
      {credits && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50" onClick={() => setCredits(null)}>
          <div className="w-[320px] rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={16} className="text-primary" />
              <span className="text-sm font-semibold">{credits.locked ? 'Voidspace Plus model' : 'Out of credits'}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {credits.locked
                ? 'This model needs a Voidspace Plus plan. Upgrade, or pick a free-tier model.'
                : credits.subscribed
                  ? "You've used up your credits. Top up to keep generating."
                  : 'Subscribe to a plan to generate images with Voidspace AI.'}
            </p>
            {typeof credits.available === 'number' && (
              <p className="text-[10px] text-muted-foreground mt-1">
                You have {credits.available} credit{credits.available === 1 ? '' : 's'}
                {typeof credits.required === 'number' ? ` · this needs ${credits.required}` : ''}.
              </p>
            )}
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => { window.open('/pricing', '_blank', 'noopener'); setCredits(null); }}
                className="flex-1 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
              >
                {credits.subscribed && !credits.locked ? 'Top up credits' : 'View plans'}
              </button>
              <button
                onClick={() => setCredits(null)}
                className="px-3 py-1.5 text-xs rounded-md bg-secondary text-secondary-foreground hover:bg-accent transition-colors"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Context-image source picker (This project / Library / Avatars / Upload) ──
function ContextSourcePicker({
  source, setSource, onPickProject, onPickLibrary, onPickAvatar, onUpload, busy,
}: {
  source: RefSource;
  setSource: (s: RefSource) => void;
  onPickProject: (asset: MediaAsset) => void;
  onPickLibrary: (item: VoidspaceLibraryItem, token: string | null) => void;
  onPickAvatar: (url: string, name: string) => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  busy: boolean;
}) {
  const project = useProjectStore((s) => s.project);
  const assets = project ? Object.values(project.assets).filter((a) => !/-edited$/i.test(a.name) && !/^filled-/i.test(a.name)) : [];

  const [libItems, setLibItems] = useState<VoidspaceLibraryItem[]>([]);
  const [libToken, setLibToken] = useState<string | null>(null);
  const [libLoading, setLibLoading] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);

  const [avatars, setAvatars] = useState<AvatarContext[]>([]);
  const [avLoading, setAvLoading] = useState(false);
  const [avError, setAvError] = useState<string | null>(null);

  useEffect(() => {
    if (source !== 'library') return;
    let cancelled = false;
    setLibLoading(true);
    setLibError(null);
    fetchVoidspaceLibrary({ type: 'image' })
      .then((r) => { if (cancelled) return; setLibItems(r.items); setLibToken(r.token); if (!r.token) setLibError('Sign in on Voidspace to see your library.'); })
      .catch(() => { if (!cancelled) setLibError('Failed to load library.'); })
      .finally(() => { if (!cancelled) setLibLoading(false); });
    return () => { cancelled = true; };
  }, [source]);

  useEffect(() => {
    if (source !== 'avatar') return;
    let cancelled = false;
    setAvLoading(true);
    setAvError(null);
    fetchAvatarContext()
      .then((a) => { if (cancelled) return; setAvatars(a); if (!a.length) setAvError('No avatar reference images found.'); })
      .catch(() => { if (!cancelled) setAvError('Failed to load avatars.'); })
      .finally(() => { if (!cancelled) setAvLoading(false); });
    return () => { cancelled = true; };
  }, [source]);

  return (
    <div className="mt-1 rounded-lg border border-border bg-background p-2">
      <div className="flex gap-1 mb-2">
        {([['project', 'Project', FolderOpen], ['library', 'Library', Library], ['avatar', 'Avatars', UserCircle2], ['upload', 'Upload', Upload]] as const).map(([val, label, Icon]) => (
          val === 'upload' ? (
            <label key={val} className="flex-1 flex items-center justify-center gap-1 py-1 rounded-md text-[10px] font-medium bg-secondary text-secondary-foreground hover:bg-accent cursor-pointer transition-colors">
              <Icon size={11} /> {label}
              <input type="file" accept="image/*" className="hidden" onChange={onUpload} disabled={busy} />
            </label>
          ) : (
            <button
              key={val}
              onClick={() => setSource(val)}
              className={`flex-1 flex items-center justify-center gap-1 py-1 rounded-md text-[10px] font-medium transition-colors ${
                source === val ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'
              }`}
            >
              <Icon size={11} /> {label}
            </button>
          )
        ))}
      </div>

      <div className="max-h-40 overflow-y-auto">
        {source === 'project' ? (
          assets.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-4">No images in this project yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-1.5">
              {assets.map((a) => (
                <button key={a.id} onClick={() => onPickProject(a)} disabled={busy}
                  className="aspect-square rounded-md overflow-hidden border border-border hover:ring-2 hover:ring-primary transition-all disabled:opacity-50">
                  <img src={a.thumbnailUrl} alt={a.name} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )
        ) : libLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground gap-2 text-[10px]"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : source === 'avatar' ? (
          avLoading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground gap-2 text-[10px]"><Loader2 size={14} className="animate-spin" /> Loading…</div>
          ) : avError ? (
            <p className="text-[10px] text-muted-foreground text-center py-4 px-2">{avError}</p>
          ) : (
            <div className="space-y-2">
              {avatars.map((av) => (
                <div key={av.id}>
                  <div className="text-[10px] font-medium text-muted-foreground mb-1 truncate">{av.name}</div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {av.images.map((img, i) => (
                      <button key={img.url + i} onClick={() => onPickAvatar(img.url, img.name || av.name)} disabled={busy}
                        title={img.description || img.name || av.name}
                        className="aspect-square rounded-md overflow-hidden border border-border hover:ring-2 hover:ring-primary transition-all disabled:opacity-50">
                        <img src={proxied(img.url)} alt={img.name || av.name} loading="lazy" className="w-full h-full object-cover"
                          onError={(e) => { (e.currentTarget.style.display = 'none'); }} />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : libError ? (
          <p className="text-[10px] text-muted-foreground text-center py-4 px-2">{libError}</p>
        ) : libItems.length === 0 ? (
          <p className="text-[10px] text-muted-foreground text-center py-4">No images in your library yet.</p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {libItems.map((item) => (
              <button key={item.id} onClick={() => onPickLibrary(item, libToken)} disabled={busy}
                className="aspect-square rounded-md overflow-hidden border border-border hover:ring-2 hover:ring-primary transition-all disabled:opacity-50">
                <img src={withMediaToken(item.thumbnailUrl || item.url, libToken)} alt={item.label} loading="lazy" className="w-full h-full object-cover"
                  onError={(e) => { (e.currentTarget.style.display = 'none'); }} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
