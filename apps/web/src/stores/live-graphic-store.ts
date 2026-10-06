/**
 * THE LIVE GRAPHIC — one HyperFrames graphic clip drawn by its own composition,
 * live, instead of by its rendered file.
 *
 * A graphic clip plays from a render (VP9 with alpha) because that is what
 * plays smoothly and exports exactly. But a render takes seconds on the
 * desktop, and editing words you cannot see until the render lands is not
 * editing. So while a graphic clip is SELECTED and the editor is PAUSED, the
 * preview shows the composition itself, held at the playhead
 * (`LiveGraphicLayer`), with the values being typed applied as they are typed.
 *
 *   liveClipId — the clip the preview is currently drawing live. The canvas
 *                skips that clip's rendered frame, so the two are never both
 *                on screen. Set only once the live composition has painted,
 *                so there is never a blank frame in between.
 *   drafts     — values typed in the inspector that have not been rendered
 *                yet, per clip. The live layer shows these; the background
 *                re-render turns them into the clip's file.
 */
import { create } from "zustand";

interface LiveGraphicState {
  liveClipId: string | null;
  drafts: Record<string, Record<string, string>>;
  setLiveClip: (clipId: string | null) => void;
  setDraft: (clipId: string, values: Record<string, string>) => void;
  clearDraft: (clipId: string) => void;
}

export const useLiveGraphicStore = create<LiveGraphicState>((set) => ({
  liveClipId: null,
  drafts: {},
  setLiveClip: (clipId) => set((s) => (s.liveClipId === clipId ? s : { liveClipId: clipId })),
  setDraft: (clipId, values) => set((s) => ({ drafts: { ...s.drafts, [clipId]: values } })),
  clearDraft: (clipId) =>
    set((s) => {
      if (!(clipId in s.drafts)) return s;
      const next = { ...s.drafts };
      delete next[clipId];
      return { drafts: next };
    }),
}));
