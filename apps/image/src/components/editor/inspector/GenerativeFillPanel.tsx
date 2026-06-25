import { useState } from 'react';
import { Sparkles, X, Loader2, Upload } from 'lucide-react';
import { useUIStore } from '../../../stores/ui-store';
import { useSelectionStore } from '../../../stores/selection-store';
import { applyGenerativeFill } from '../../../services/apply-generative-fill';
import { FILL_MODELS, type FillModelId, GenFillError, fetchCreditSituation, uploadReferenceImage } from '../../../services/generative-fill';
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

  const needsRef = FILL_MODELS.find((m) => m.id === model)?.ref === true;

  if (!open) return null;

  const onPickReference = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setUploadingRef(true);
    setError(null);
    try {
      const url = await uploadReferenceImage(file);
      setReferenceUrl(url);
      setReferenceName(file.name);
    } catch {
      setError('Could not upload the reference image.');
    } finally {
      setUploadingRef(false);
    }
  };

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    if (needsRef && !referenceUrl) { setError('Upload a reference image for this model.'); return; }
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
    <div className="border-b border-border bg-card shrink-0">
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
            {FILL_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label} — {m.credits} cr</option>
            ))}
          </select>
        </div>

        {/* Reference image — used by reference-guided models (e.g. FLUX Kontext)
            to fill the selection with the uploaded object/style. */}
        {needsRef && (
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
          disabled={busy || uploadingRef || !prompt.trim() || !hasSelection || (needsRef && !referenceUrl)}
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
