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
import { Loader2, RefreshCw, Layers, Wand2 } from "lucide-react";
import { useProjectStore } from "../../../stores/project-store";
import { findBlock, type BlockInfo } from "../../../services/blocks";
import { renderBlock } from "../../../services/render-block";
import { fetchLibraryBlob } from "../../../services/library-drop";
import { saveMediaBlob } from "../../../services/media-storage";
import { useProcessingStore } from "../../../services/processing-manager";
import { valueSlots, mediaSlots } from "@openreel/asset-browser";

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
    void findBlock(graphic.block).then((b) => { if (live) setBlock(b); });
    return () => { live = false; };
  }, [graphic?.block]);

  /** Restage whenever the clip changes — selecting another graphic must not
   *  carry the previous one's half-typed values across. */
  useEffect(() => {
    setDraft({ ...(graphic?.slots ?? {}) });
    setError("");
  }, [clipId, graphic?.slots]);

  const fields = useMemo(() => valueSlots(block), [block]);
  const mediaFields = useMemo(() => mediaSlots(block), [block]);

  const changed = useMemo(() => {
    const was = graphic?.slots ?? {};
    const keys = new Set([...Object.keys(was), ...Object.keys(draft)]);
    return [...keys].filter((k) => (was[k] ?? "") !== (draft[k] ?? ""));
  }, [draft, graphic?.slots]);

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

      const nextGraphic = { ...graphic, slots };
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
      proc.completeTask(taskId);
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 200);
      setError(message);
      proc.failTask(taskId, message);
    } finally {
      setBusy(false);
    }
  }, [clip, clipId, draft, graphic]);

  if (!graphic) return null;

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
      ) : fields.length === 0 ? (
        <p className="text-[11px] text-text-muted leading-relaxed">
          {block.fill === "adapt"
            ? "This block bakes its content in — there is nothing to fill. Adapt it on the board to change what it says."
            : "This block has no values to fill."}
        </p>
      ) : (
        <>
          {fields.map((f) => (
            <label key={f.key} className="block">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">{f.key}</span>
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

          {mediaFields.length > 0 && (
            <p className="text-[10px] text-text-muted leading-relaxed">
              Wants {mediaFields.map((m) => `${m.key} (${m.kind})`).join(", ")} — fill media slots
              on the board, where you can drop assets onto the shot.
            </p>
          )}

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
              ? "Rendering on your computer…"
              : changed.length
                ? `Re-render with ${changed.length} change${changed.length === 1 ? "" : "s"}`
                : "No changes to render"}
          </button>
          <p className="text-[10px] text-text-muted leading-relaxed flex items-start gap-1">
            <Wand2 size={10} className="mt-0.5 shrink-0 opacity-60" />
            Renders on your computer and swaps this clip's picture. Its position, trim and blend
            stay exactly as they are.
          </p>
        </>
      )}

      {error && <p className="text-[10px] text-error leading-relaxed">{error}</p>}
    </div>
  );
};
