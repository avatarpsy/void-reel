import { useState } from 'react';
import { Layers, X, Loader2, Sparkles } from 'lucide-react';
import { useUIStore } from '../../../stores/ui-store';
import { separateArtboardIntoLayers } from '../../../services/layer-separation';
import { ImageGenError, fetchCreditSituation } from '../../../services/image-generation';
import { NotSignedInError } from '../../../services/voidspace-storage';
import { askHostForCredits } from '../../../services/out-of-credits';

/**
 * "Separate into layers" (Seedream 5.0 Pro). Flattens the current page and asks
 * the model to split it into background / subject / text / decorative layers,
 * importing each as an independent, stacked, editable layer.
 */
export function LayerSeparationModal() {
  const open = useUIStore((s) => s.layerSeparationOpen);
  const setOpen = useUIStore((s) => s.setLayerSeparationOpen);
  const showNotification = useUIStore((s) => s.showNotification);

  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState('2K');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState<{ available?: number; required?: number; subscribed: boolean; locked?: boolean } | null>(null);

  if (!open) return null;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const n = await separateArtboardIntoLayers({ prompt: prompt.trim() || undefined, resolution: quality });
      showNotification('success', `Separated into ${n} layer${n === 1 ? '' : 's'}`);
      setOpen(false);
      setPrompt('');
    } catch (e) {
      if (e instanceof NotSignedInError) setError('Sign in to Voidspace to separate layers.');
      else if (e instanceof ImageGenError && e.code === 402) {
        // Embedded: the host's shared upgrade sheet. Standalone: our popup.
        if (!askHostForCredits({ needed: e.required, balance: e.available })) {
          const sit = await fetchCreditSituation();
          setCredits({ available: e.available, required: e.required, subscribed: sit.isSubscribed });
        }
      } else if (e instanceof ImageGenError && (e.code === 403 || e.upgrade)) {
        if (!askHostForCredits({ reason: 'plan' })) setCredits({ subscribed: false, locked: true });
      } else if (e instanceof ImageGenError && (e.code === 503 || e.code === 429)) {
        setError('Seedream is busy right now — please try again in a moment.');
      } else {
        setError(e instanceof Error && /empty|add an image/i.test(e.message) ? e.message : "Couldn't separate layers. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[92] flex items-center justify-center bg-black/50 p-4" onClick={() => !busy && setOpen(false)}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Layers size={16} className="text-primary" /> Separate into layers
          </span>
          <button onClick={() => !busy && setOpen(false)} className="text-muted-foreground hover:text-foreground" title="Close"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-[11px] text-muted-foreground">
            Seedream 5.0 Pro splits this page into its parts — background, subject, text and decorations — and imports each as its own editable layer. The original stays (hidden).
          </p>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Guidance (optional)</label>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. separate the text, logo and background"
              className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Quality</label>
            <div className="flex gap-1 p-0.5 bg-secondary rounded-lg">
              {['1K', '2K'].map((r) => (
                <button
                  key={r}
                  onClick={() => setQuality(r)}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    quality === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {r}{r === '1K' ? ' · Basic' : ' · High'}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}

          <button
            onClick={run}
            disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {busy ? <><Loader2 size={15} className="animate-spin" /> Separating…</> : <><Sparkles size={15} /> Separate into layers</>}
          </button>
        </div>
      </div>

      {credits && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50" onClick={() => setCredits(null)}>
          <div className="w-[320px] rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={16} className="text-primary" />
              <span className="text-sm font-semibold">{credits.locked ? 'Voidspace Plus model' : 'Out of credits'}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {credits.locked
                ? 'This model needs a Voidspace Plus plan.'
                : credits.subscribed
                  ? "You've used up your credits. Top up to keep going."
                  : 'Subscribe to a plan to use Voidspace AI.'}
            </p>
            <div className="flex gap-2 mt-4">
              <button onClick={() => { window.open('/pricing', '_blank', 'noopener'); setCredits(null); }}
                className="flex-1 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors">
                {credits.subscribed && !credits.locked ? 'Top up credits' : 'View plans'}
              </button>
              <button onClick={() => setCredits(null)}
                className="px-3 py-1.5 text-xs rounded-md bg-secondary text-secondary-foreground hover:bg-accent transition-colors">
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
