import { useEffect, useState } from 'react';
import { Sparkles, X, Loader2, Upload } from 'lucide-react';
import { useUIStore } from '../../../stores/ui-store';
import { useSelectionStore } from '../../../stores/selection-store';
import { applyGenerativeFill } from '../../../services/apply-generative-fill';
import { FILL_MODELS, loadFillModels, type FillModelId, type FillModelOption, GenFillError, LocalFillError, fetchCreditSituation, uploadReferenceImage, uploadReferenceFromUrl } from '../../../services/generative-fill';
import { NotSignedInError } from '../../../services/voidspace-storage';

/**
 * Photoshop-style Generative Fill box. Opened from the selection right-click
 * menu (Canvas → ContextMenu). Type a prompt, pick a model, Generate — the
 * result lands on a new layer masked to the selection (non-destructive).
 */
export function GenerativeFillPanel() {
  const open = useUIStore((s) => s.generativeFillOpen);
  const setOpen = useUIStore((s) => s.setGenerativeFillOpen);
  const showNotification = useUIStore((s) => s.showNotification);
  const hasSelection = useSelectionStore((s) => !!s.active);

  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<FillModelId>(FILL_MODELS[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Out-of-credits popup (null = closed). `subscribed` tailors the call-to-action.
  const [credits, setCredits] = useState<{ available?: number; required?: number; subscribed: boolean } | null>(null);
  // Reference image (for ref-capable models like FLUX Kontext).
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const [referenceName, setReferenceName] = useState<string | null>(null);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  /**
   * The picker's list, INCLUDING anything on the user's own machine.
   *
   * Async because a local model exists only while their node is running, so the
   * list is a fact about right now rather than a constant. Seeded with the cloud
   * models so the panel is never briefly empty, and re-read whenever the panel
   * opens — a user who starts ComfyUI and comes straight back should see it
   * without reloading the editor.
   */
  const [models, setModels] = useState<FillModelOption[]>(() => FILL_MODELS.map((m) => ({ ...m })));
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadFillModels().then((list) => { if (live) setModels(list); });
    return () => { live = false; };
  }, [open]);

  // refMode: 'none' hides the upload UI; 'optional' shows it (kie editors);
  // 'required' also gates Generate (FLUX Kontext needs a reference).
  const selected = models.find((m) => m.id === model);
  const refMode = selected?.refMode ?? 'none';
  const showRef = refMode !== 'none';
  const refRequired = refMode === 'required';
  // A local model that is present but not set up yet is SELECTABLE and shows what
  // it needs — hiding it would make the setup undiscoverable — but Generate is
  // blocked, because pressing it could only ever fail.
  const notReady = selected?.engine === 'local' && selected.local?.ready === false;

  if (!open) return null;

  // Shared reference-attach: run the upload (file or URL), set the preview, and
  // surface a clean error (sign-in is the usual cause on a fresh localhost).
  const attachReference = async (upload: () => Promise<string>, name: string) => {
    setUploadingRef(true);
    setError(null);
    try {
      setReferenceUrl(await upload());
      setReferenceName(name);
    } catch (err) {
      if (err instanceof NotSignedInError) setError('Sign in to Voidspace (on this site) to add a reference image.');
      else setError('Could not add the reference image.');
    } finally {
      setUploadingRef(false);
    }
  };

  const onPickReference = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (file) void attachReference(() => uploadReferenceImage(file), file.name);
  };

  // Drag-and-drop a reference: an image FILE from the system, or an image
  // dragged from the web (a URL / <img>), like ChatGPT.
  const onDropReference = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!showRef) return;
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
    if (file) { void attachReference(() => uploadReferenceImage(file), file.name); return; }
    // Web image drag → resolve a URL from uri-list / html / plain text.
    const uri = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').trim().split(/\s+/)[0];
    const html = e.dataTransfer.getData('text/html');
    const fromHtml = html ? (html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? '') : '';
    const imageUrl = /^https?:\/\//i.test(uri) ? uri : fromHtml;
    if (imageUrl) void attachReference(() => uploadReferenceFromUrl(imageUrl), 'dropped image');
    else setError('Drop an image file or an image link.');
  };

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    if (refRequired && !referenceUrl) { setError('Upload a reference image for this model.'); return; }
    setBusy(true);
    setError(null);
    try {
      await applyGenerativeFill(prompt.trim(), model, referenceUrl ?? undefined);
      showNotification('success', 'Generative fill added on a new layer');
      setOpen(false);
      setPrompt('');
    } catch (e) {
      if (e instanceof NotSignedInError) {
        setError('Sign in to Voidspace to use Generative Fill.');
      } else if (e instanceof GenFillError && e.code === 402) {
        // The USER is out of credits → show the top-up / subscribe popup.
        const sit = await fetchCreditSituation();
        setCredits({ available: e.available, required: e.required, subscribed: sit.isSubscribed });
      } else if (e instanceof LocalFillError) {
        /**
         * A LOCAL failure says exactly what went wrong, and that is deliberate.
         *
         * The "never surface server details" rule below protects users from
         * provider internals — right for a cloud model, and precisely wrong
         * here. This ran on the user's own machine, in their own ComfyUI, and
         * the message names the missing weight file or the node that errored.
         * Collapsing it to "please try again" tells someone to retry a thing
         * that will fail identically every time.
         */
        setError(e.message);
      } else if (e instanceof GenFillError && (e.code === 503 || e.code === 429)) {
        setError('Generative Fill is busy right now — please try again in a moment.');
      } else {
        // Never surface server/provider details.
        setError("Couldn't generate. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <div
      className="relative border-b border-border bg-card shrink-0"
      onDragOver={(e) => { if (showRef) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDropReference}
    >
      {dragOver && showRef && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10 pointer-events-none">
          <span className="text-xs font-medium text-primary">Drop image to use as reference</span>
        </div>
      )}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Sparkles size={14} className="text-primary" /> Generative Fill
        </span>
        <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="p-3 space-y-2">
        {!hasSelection && (
          <p className="text-[10px] text-amber-500">
            Make a selection first (lasso or marquee), then describe what to generate there.
          </p>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Describe what to generate in the selected area…"
          className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-muted-foreground shrink-0">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as FillModelId)}
            className="flex-1 px-2 py-1 text-[11px] bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {/* Free is stated as a WORD, not as "0 cr". A zero next to every
                    other row's price reads as a missing number; "free" reads as
                    the point of having set the machine up. */}
                {m.label} — {m.engine === 'local' ? 'free' : `${m.credits} cr`}
              </option>
            ))}
          </select>
        </div>

        {/* What a local model is waiting for, in the panel where it was chosen.
            The alternative is finding out after pressing Generate. */}
        {notReady && (
          <p className="text-[10px] text-amber-500 leading-snug">
            Not ready on {selected?.local?.nodeName}. {selected?.local?.missing}
          </p>
        )}

        {/* Reference image — used by reference-guided models (FLUX Kontext, and
            optionally nano-banana / gpt-image) to fill with the uploaded object/style. */}
        {showRef && (
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">Reference image</label>
            {referenceUrl ? (
              <div className="flex items-center gap-2">
                <img src={referenceUrl} alt="" className="w-8 h-8 rounded object-cover border border-border" />
                <span className="flex-1 text-[10px] truncate">{referenceName}</span>
                <button onClick={() => { setReferenceUrl(null); setReferenceName(null); }} className="text-muted-foreground hover:text-destructive" title="Remove">
                  <X size={12} />
                </button>
              </div>
            ) : (
              <label className="flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] rounded-md border border-dashed border-input cursor-pointer hover:bg-accent transition-colors">
                {uploadingRef ? <><Loader2 size={12} className="animate-spin" /> Uploading…</> : <><Upload size={12} /> Upload reference</>}
                <input type="file" accept="image/*" className="hidden" onChange={onPickReference} disabled={uploadingRef} />
              </label>
            )}
          </div>
        )}

        {error && <p className="text-[10px] text-destructive">{error}</p>}
        <button
          onClick={generate}
          // `!prompt.trim()` is deliberately NOT required for a local workflow
          // that declares no prompt input — the pipeline self-test takes none,
          // and gating on a field it will ignore would make it unrunnable.
          disabled={
            busy || uploadingRef || !hasSelection || notReady
            || (refRequired && !referenceUrl)
            || (!prompt.trim() && selected?.engine !== 'local')
          }
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {busy ? (
            <><Loader2 size={14} className="animate-spin" /> Generating…</>
          ) : (
            <><Sparkles size={14} /> Generate</>
          )}
        </button>
      </div>
    </div>

    {/* Out-of-credits popup — tailored to whether the user is subscribed. */}
    {credits && (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => setCredits(null)}>
        <div className="w-[320px] rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={16} className="text-primary" />
            <span className="text-sm font-semibold">Out of credits</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {credits.subscribed
              ? "You've used up your credits. Top up to keep using Generative Fill."
              : 'Subscribe to a plan to use Generative Fill and the rest of Voidspace AI.'}
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
              {credits.subscribed ? 'Top up credits' : 'View plans'}
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
    </>
  );
}
