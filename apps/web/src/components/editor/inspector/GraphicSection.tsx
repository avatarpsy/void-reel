/**
 * The GRAPHIC section — a clip that is a rendered HyperFrames block.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Dragging a block onto the timeline renders it AS DESIGNED, with the
 * designer's own sample words in it, because a block rendered with nothing in
 * its slots is an empty rectangle. That is the right first frame and the wrong
 * final one: the user dropped a lower third to put THEIR name in it. Without
 * this panel the only way to change a word would be to delete the clip and ask
 * the agent, which is not an edit, it is starting over.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not edit the block. Slots are the contract the designer published —
 * `key → value` — and everything else about the composition stays theirs. A
 * block that needs different bones is a job for `compose_block`, on the board.
 *
 * ── RE-RENDER IS EXPLICIT ───────────────────────────────────────────────────
 * Every render runs on the user's own machine and takes real seconds, so typing
 * does not trigger one. The values are staged, the button says how many changed,
 * and nothing on the timeline moves until it is pressed. The re-render replaces
 * the clip's MEDIA in place, so its position, its trim and its blend all
 * survive — the user changed a word, not the edit.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Layers, Wand2, ImageIcon, X } from "lucide-react";
import { useProjectStore } from "../../../stores/project-store";
import { findBlock, type BlockInfo } from "../../../services/blocks";
import { useLiveGraphicStore } from "../../../stores/live-graphic-store";
import { renderBlock } from "../../../services/render-block";
import { fetchLibraryBlob } from "../../../services/library-drop";
import { saveMediaBlob } from "../../../services/media-storage";
import { useProcessingStore } from "../../../services/processing-manager";
import { valueSlots, mediaSlots, type BlockSlot } from "@openreel/asset-browser";
import { materializeProjectMedia } from "../../../services/materialize-media";

/**
 * ONE IMAGE OR VIDEO SLOT — what the block shows in its picture well.
 *
 * Filled from what this project already holds: pick an item from the list, or
 * drop one from the Media or Library panel. The slot needs a URL the desktop
 * renderer can fetch, so a browser-only item is saved to the user's cloud once
 * (`materializeProjectMedia`). The live preview shows the picture the moment
 * the URL is set, like any other field.
 */
const MediaSlotField: React.FC<{
  slot: BlockSlot;
  value: string;
  onChange: (url: string) => void;
}> = ({ slot, value, onChange }) => {
  const items = useProjectStore((st) => st.project.mediaLibrary?.items ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const usable = useMemo(
    () => items.filter((m: any) => (slot.kind === "image" ? m.type === "image" : m.type === "video")),
    [items, slot.kind],
  );
  const choose = async (mediaId: string) => {
    setErr("");
    setBusy(true);
    try {
      onChange((await materializeProjectMedia(mediaId)).url);
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    try {
      const data = JSON.parse(e.dataTransfer.getData("application/json") || "{}");
      if (typeof data.mediaId === "string") void choose(data.mediaId);
      else if (typeof data.libraryItem?.url === "string" && /^(https?:|\/)/.test(data.libraryItem.url)) {
        onChange(data.libraryItem.url);
      }
    } catch { /* not a media drag */ }
  };
  const label = slot.key.replace(/^[#.]/, "").replace(/[-_]+/g, " ");
  return (
    <div className="block">
      <span className="text-[10px] uppercase tracking-wide text-text-muted">{label} · {slot.kind}</span>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`mt-1 flex items-center gap-2 p-1.5 rounded border transition-colors ${
          over ? "border-primary/60 bg-primary/10" : "border-border bg-background-tertiary"
        }`}
      >
        <div className="w-10 h-10 shrink-0 rounded bg-black/40 overflow-hidden flex items-center justify-center">
          {value ? (
            slot.kind === "image"
              ? <img src={value} alt="" className="w-full h-full object-cover" />
              : <video src={value} muted className="w-full h-full object-cover" />
          ) : busy ? <Loader2 size={12} className="animate-spin text-text-muted" />
            : <ImageIcon size={12} className="text-text-muted/60" />}
        </div>
        <select
          value=""
          disabled={busy}
          onChange={(e) => { if (e.target.value) void choose(e.target.value); }}
          className="flex-1 min-w-0 px-1.5 py-1 text-[11px] bg-background-tertiary border border-border
                     rounded text-text-primary focus:border-primary/60 focus:outline-none"
        >
          <option value="">
            {usable.length ? `Choose ${slot.kind === "image" ? "an image" : "a video"}…` : `No ${slot.kind}s in this project — drop one here`}
          </option>
          {usable.map((m: any) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
        </select>
        {value && (
          <button
            type="button"
            title="Clear"
            onClick={() => onChange("")}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-background-elevated"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {err && <p className="mt-1 text-[10px] text-error">{err}</p>}
    </div>
  );
};

interface GraphicSectionProps {
  clipId: string;
}

export const GraphicSection: React.FC<GraphicSectionProps> = ({ clipId }) => {
  const { getClip, getMediaItem, project } = useProjectStore();

  const clip = useMemo(() => getClip(clipId), [clipId, getClip, project.modifiedAt]);
  const media = useMemo(
    () => (clip ? getMediaItem(clip.mediaId) : null),
    [clip, getMediaItem, project.modifiedAt],
  );
  /** The clip's own copy wins — it is what this instance was made with. */
  const graphic = clip?.metadata?.graphic ?? media?.metadata?.graphic ?? null;

  const [block, setBlock] = useState<BlockInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!graphic?.block) return;
    let live = true;
    void findBlock(graphic.block, graphic.source).then((b) => { if (live) setBlock(b); });
    return () => { live = false; };
  }, [graphic?.block, graphic?.source]);

  /** Restage whenever the clip changes — selecting another graphic must not
   *  carry the previous one's half-typed values across. */
  useEffect(() => {
    setDraft({ ...(graphic?.slots ?? {}) });
    setError("");
  }, [clipId, graphic?.slots]);

  const fields = useMemo(() => valueSlots(block), [block]);
  const mediaFields = useMemo(() => mediaSlots(block), [block]);

  /**
   * PER-LAYER TIMING. The live layer reports the composition's animated
   * layers; a delay or speed set here is applied by the same script in the
   * live preview and in the render (GraphicRef.timing), and counts as a change
   * like any typed value: shown at once, re-rendered a moment later.
   */
  const layers = useLiveGraphicStore((st) => st.layers[clipId]);
  const timingDraft = useLiveGraphicStore((st) => st.timingDrafts[clipId]);
  const savedTiming = (graphic?.timing ?? {}) as Record<string, { delay?: number; speed?: number }>;
  const timing = timingDraft ?? savedTiming;
  const timingChanged = JSON.stringify(timing) !== JSON.stringify(savedTiming);
  const setLayerTiming = (sel: string, patch: { delay?: number; speed?: number }) => {
    const next = { ...timing, [sel]: { ...timing[sel], ...patch } };
    const e = next[sel];
    if (!e.delay) delete e.delay;
    if (!e.speed || e.speed === 1) delete e.speed;
    if (!Object.keys(e).length) delete next[sel];
    useLiveGraphicStore.getState().setTimingDraft(clipId, next);
  };

  const changed = useMemo(() => {
    const was = graphic?.slots ?? {};
    const keys = new Set([...Object.keys(was), ...Object.keys(draft)]);
    const list = [...keys].filter((k) => (was[k] ?? "") !== (draft[k] ?? ""));
    return timingChanged ? [...list, "timing"] : list;
  }, [draft, graphic?.slots, timingChanged]);

  /**
   * Re-render with the staged values and swap the clip's media.
   *
   * `replaceClipMedia`-shaped, but done locally: import the new file, point the
   * clip's `mediaId` at it, and leave everything else about the clip alone.
   */
  const rerender = useCallback(async () => {
    if (!clip || !graphic) return;
    setBusy(true);
    setError("");
    const proc = useProcessingStore.getState();
    const taskId = proc.addTask(clipId, "graphic-render");
    proc.updateTaskProgress(taskId, 10, `Rendering ${graphic.block} on your computer…`);
    try {
      const slots = Object.fromEntries(
        Object.entries(draft).filter(([, v]) => String(v ?? "").trim() !== ""),
      );
      const rendered = await renderBlock({
        block: graphic.block,
        slots,
        mode: graphic.mode ?? "overlay",
        aspect: graphic.aspect,
        source: graphic.source,
        timing,
        // The user has now said what it should say. Anything still empty draws
        // nothing rather than the designer's sample — in a finished video
        // somebody else's placeholder name is worse than an absent line.
        useSampleContent: Object.keys(slots).length === 0,
      });
      proc.updateTaskProgress(taskId, 70, "Importing…");

      const blob = await fetchLibraryBlob(rendered.url);
      if (!blob) throw new Error("Rendered, but the file could not be read back.");
      const safe = graphic.block.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48) || "graphic";
      const file = new File([blob], `${safe}.webm`, { type: blob.type || "video/webm" });
      const store = useProjectStore.getState();
      const before = new Set(store.project.mediaLibrary.items.map((m: any) => m.id));
      const result = await store.importMedia(file);
      if (!result.success) throw new Error("Rendered, but could not be imported.");
      const fresh = useProjectStore.getState().project.mediaLibrary.items.find(
        (m: any) => !before.has(m.id),
      );
      if (!fresh) throw new Error("Imported, but the media item could not be found.");

      // An overlay render now decodes WITH its alpha (see GraphicRef.alpha).
      const overlay = (graphic.mode ?? "overlay") === "overlay";
      const nextGraphic = {
        ...graphic,
        slots,
        ...(overlay ? { alpha: true } : {}),
        ...(Object.keys(timing).length ? { timing } : { timing: undefined }),
      };
      // The `screen` this clip got automatically was a stand-in for that alpha;
      // with real transparency it would only wash the design out. A blend the
      // user chose (anything but the old automatic one) is left alone.
      const dropAutoScreen = overlay && !graphic.alpha;
      useProjectStore.setState((s: any) => ({
        project: {
          ...s.project,
          mediaLibrary: {
            ...s.project.mediaLibrary,
            items: s.project.mediaLibrary.items.map((m: any) =>
              m.id === fresh.id
                ? {
                    ...m,
                    originalUrl: m.originalUrl ?? rendered.url,
                    category: m.category ?? "Graphics",
                    metadata: { ...m.metadata, graphic: nextGraphic },
                  }
                : m,
            ),
          },
          timeline: {
            ...s.project.timeline,
            tracks: s.project.timeline.tracks.map((t: any) => ({
              ...t,
              clips: t.clips.map((c: any) =>
                c.id === clipId
                  ? {
                      ...c,
                      mediaId: fresh.id,
                      ...(dropAutoScreen && c.blendMode === "screen" ? { blendMode: undefined } : {}),
                      metadata: { ...(c.metadata ?? {}), graphic: nextGraphic },
                    }
                  : c,
              ),
            })),
          },
          modifiedAt: Date.now(),
        },
      }));
      saveMediaBlob(
        useProjectStore.getState().project.id,
        fresh.id,
        blob,
        (fresh as any).metadata ?? {},
      ).catch(() => {});
      useLiveGraphicStore.getState().setTimingDraft(clipId, null);
      proc.completeTask(taskId);
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 200);
      setError(message);
      proc.failTask(taskId, message);
    } finally {
      setBusy(false);
    }
  }, [clip, clipId, draft, graphic, timing]);

  /**
   * TYPE, SEE IT, KEEP IT.
   *
   * What is typed goes straight to the preview's live layer (the composition
   * itself, held at the playhead), so a change is visible on the frame the
   * moment it is made. A moment after typing stops, the clip re-renders on the
   * desktop in the background — that file is what plays and exports — and the
   * live layer keeps showing the values meanwhile, so nothing flickers back.
   */
  useEffect(() => {
    const store = useLiveGraphicStore.getState();
    if (changed.length) store.setDraft(clipId, draft);
    else store.clearDraft(clipId);
  }, [clipId, draft, changed.length]);

  useEffect(() => {
    if (!changed.length || busy) return;
    const t = window.setTimeout(() => { void rerender(); }, 1200);
    return () => window.clearTimeout(t);
  }, [draft, changed.length, busy, rerender, timing]);

  if (!graphic) return null;

  /** "#lt-name" (a catalog block's hard-coded word) reads as "name". */
  function fieldLabel(key: string): string {
    return key.replace(/^[#.]/, "").replace(/^[a-z]{1,3}-(?=[a-z])/, "").replace(/[-_]+/g, " ");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
        <Layers size={12} className="text-primary/70" />
        <span className="font-medium text-text-primary truncate">{graphic.block}</span>
        <span className="text-text-muted">
          · {(graphic.mode ?? "overlay") === "bake" ? "baked in" : "over the picture"}
        </span>
      </div>

      {!block ? (
        <p className="text-[11px] text-text-muted leading-relaxed">
          This clip is a rendered graphic. Its block is not in the library on this machine, so
          its values cannot be edited here — the clip itself still trims, moves and exports
          normally.
        </p>
      ) : fields.length === 0 && mediaFields.length === 0 ? (
        <p className="text-[11px] text-text-muted leading-relaxed">
          {block.fill === "adapt"
            ? "This block bakes its content in — there is nothing to fill. Adapt it on the board to change what it says."
            : "This block has no values to fill."}
        </p>
      ) : (
        <>
          {fields.map((f) => (
            <label key={f.key} className="block">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">{fieldLabel(f.key)}</span>
              {f.kind === "color" ? (
                <input
                  type="color"
                  value={draft[f.key] || "#ffffff"}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  className="mt-1 w-full h-7 bg-background-tertiary border border-border rounded cursor-pointer"
                />
              ) : (
                <input
                  type="text"
                  value={draft[f.key] ?? ""}
                  /* The designer's own value as the placeholder: it shows both the
                     shape and the tone expected, which an empty box does not. */
                  placeholder={f.sample || ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  className="mt-1 w-full px-2 py-1 text-[11px] bg-background-tertiary border border-border
                             rounded text-text-primary placeholder:text-text-muted/60
                             focus:border-primary/60 focus:outline-none"
                />
              )}
            </label>
          ))}

          {mediaFields.map((f) => (
            <MediaSlotField
              key={f.key}
              slot={f}
              value={draft[f.key] ?? ""}
              onChange={(url) => setDraft((d) => ({ ...d, [f.key]: url }))}
            />
          ))}

          <button
            type="button"
            disabled={busy || changed.length === 0}
            onClick={() => void rerender()}
            className="w-full py-1.5 text-[11px] font-medium rounded-md border transition-colors
                       flex items-center justify-center gap-1.5
                       disabled:opacity-40 disabled:cursor-not-allowed
                       border-border text-text-secondary enabled:hover:text-text-primary
                       enabled:hover:border-primary/60"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {busy
              ? "Updating the render on your computer…"
              : changed.length
                ? "Render now"
                : "Up to date"}
          </button>
          <p className="text-[10px] text-text-muted leading-relaxed flex items-start gap-1">
            <Wand2 size={10} className="mt-0.5 shrink-0 opacity-60" />
            Changes show in the preview as you type. A moment after you stop, the clip re-renders
            on your computer for playback and export — position, trim and blend stay as they are.
          </p>
        </>
      )}

      {block && (
        <div className="space-y-1.5 pt-1">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">Layers</span>
          {!layers?.length ? (
            <p className="text-[10px] text-text-muted leading-relaxed">
              Pause with the playhead on this clip to list its animated layers.
            </p>
          ) : (
            layers.map((L) => {
              const t = timing[L.sel] ?? {};
              return (
                <div key={L.sel} className="flex items-center gap-1.5">
                  <span className="flex-1 min-w-0 truncate text-[11px] text-text-primary" title={L.sel}>
                    {fieldLabel(L.sel)}
                    <span className="ml-1 text-[10px] text-text-muted">{L.start.toFixed(1)}–{L.end.toFixed(1)}s</span>
                  </span>
                  <input
                    type="number"
                    step={0.1}
                    title="Delay (seconds)"
                    value={t.delay ?? 0}
                    onChange={(e) => setLayerTiming(L.sel, { delay: Number(e.target.value) || 0 })}
                    className="w-14 px-1.5 py-0.5 text-[11px] bg-background-tertiary border border-border rounded
                               text-text-primary focus:border-primary/60 focus:outline-none"
                  />
                  <select
                    title="Speed"
                    value={String(t.speed ?? 1)}
                    onChange={(e) => setLayerTiming(L.sel, { speed: Number(e.target.value) })}
                    className="w-16 px-1 py-0.5 text-[11px] bg-background-tertiary border border-border rounded
                               text-text-primary focus:border-primary/60 focus:outline-none"
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => <option key={v} value={v}>{v}×</option>)}
                  </select>
                </div>
              );
            })
          )}
        </div>
      )}

      {error && <p className="text-[10px] text-error leading-relaxed">{error}</p>}
    </div>
  );
};
