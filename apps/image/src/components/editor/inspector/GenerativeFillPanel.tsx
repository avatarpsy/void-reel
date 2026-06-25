import { useState } from 'react';
import { Sparkles, X, Loader2 } from 'lucide-react';
import { useUIStore } from '../../../stores/ui-store';
import { useSelectionStore } from '../../../stores/selection-store';
import { applyGenerativeFill } from '../../../services/apply-generative-fill';
import { FILL_MODELS, type FillModelId } from '../../../services/generative-fill';
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

  if (!open) return null;

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await applyGenerativeFill(prompt.trim(), model);
      showNotification('success', 'Generative fill added on a new layer');
      setOpen(false);
      setPrompt('');
    } catch (e) {
      if (e instanceof NotSignedInError) setError('Sign in on Voidspace to use Generative Fill.');
      else setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
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
        {error && <p className="text-[10px] text-destructive">{error}</p>}
        <button
          onClick={generate}
          disabled={busy || !prompt.trim() || !hasSelection}
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
  );
}
