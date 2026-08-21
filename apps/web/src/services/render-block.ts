/**
 * Render a HyperFrames block into a video file the timeline can hold.
 *
 * ── THE TWO MODES, AND THE ONE LINE THAT SEPARATES THEM ─────────────────────
 * `overlay` asks for **webm** — vp9 with a real alpha channel — because the
 * graphic is going ON TOP of a picture and the parts the designer left empty
 * have to stay empty. `bake` asks for **mp4** with the footage passed as the
 * block's `backdrop`, producing one opaque, self-contained clip with the
 * graphic already burnt in.
 *
 * Getting that backwards is not subtle in either direction: an overlay asked
 * for as mp4 comes back opaque and hides the film; a bake asked for as webm
 * comes back with a transparent hole where the footage should be.
 *
 * ── FILL MODE, WHICH IS A UX DECISION, NOT A TECHNICAL ONE ──────────────────
 * `preview` leaves the designer's own sample content in any slot nobody filled;
 * `render` draws nothing there. A drag from the library has no values yet, and
 * a block that renders to an empty rectangle reads as broken — so a drop asks
 * for `preview` and the user edits the words afterwards. A deliberate render of
 * filled slots asks for `render`, because in a finished video somebody else's
 * placeholder name is worse than an absent line.
 *
 * ── WHY THIS TALKS TO THE ENDPOINT DIRECTLY ─────────────────────────────────
 * The render runs on the user's own machine (the desktop app) and the route is
 * the bridge to it. The studio page has its own reattach-safe caller for the
 * long renders it starts; this is the editor's, and it exists because the
 * editor is opened standalone as often as it is embedded — a drag-and-drop that
 * only worked inside the iframe would fail in a way the user could not explain.
 */
import { useVoidspaceStore } from "../stores/voidspace-store";

/** Parent origin when embedded in the website iframe; else same origin. */
function apiBase(): string {
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) return window.parent.location.origin;
    } catch { /* cross-origin — fall through */ }
  }
  return "";
}

export interface RenderBlockArgs {
  block: string;
  /** key → value. Text, colour, or a URL for a media slot. */
  slots?: Record<string, string>;
  mode?: "overlay" | "bake";
  /**
   * How long to hold it. OMITTED WHEN 0, and that is deliberate: the route only
   * injects a hold when it is GIVEN a length, and a block with none plays the
   * way its designer drew it. Forcing `lt-clean-bar` from its natural 4.8s to a
   * 10s shot doubles the frames and appends five seconds of empty video after
   * the bar has animated out.
   */
  durationSec?: number;
  /** The picture to burn the graphic into. Bake only, and required for it. */
  backdropUrl?: string;
  /** Leave the designer's sample content in unfilled slots. Default false. */
  useSampleContent?: boolean;
  aspect?: string;
}

export interface RenderedBlock {
  url: string;
  durationSec: number;
}

/**
 * A stable key for identical work, so a repeated render is free.
 *
 * The same block with the same words at the same length IS the same file, and
 * these renders cost the user real time on their own machine. Falls back to no
 * key rather than failing when SubtleCrypto is unavailable (a non-secure
 * origin) — rendering twice is a much smaller problem than not rendering.
 */
async function renderKey(args: RenderBlockArgs): Promise<string> {
  const material = JSON.stringify([
    args.block,
    args.slots ?? {},
    args.mode ?? "overlay",
    Number(args.durationSec) || 0,
    args.backdropUrl ?? "",
    !!args.useSampleContent,
    args.aspect ?? "",
  ]);
  try {
    const bytes = new TextEncoder().encode(material);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  } catch {
    return "";
  }
}

export class RenderBlockError extends Error {}

export async function renderBlock(args: RenderBlockArgs): Promise<RenderedBlock> {
  const mode = args.mode ?? "overlay";
  const baked = mode === "bake";
  if (baked && !args.backdropUrl) {
    throw new RenderBlockError(
      "Baking needs a picture underneath — there is no clip below this one to burn into.",
    );
  }
  const token = await useVoidspaceStore.getState().getIdToken();
  if (!token) throw new RenderBlockError("Not signed in.");

  const key = await renderKey(args);
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/studio/render-hyperframes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": `gfx-${key}` } : {}),
      },
      body: JSON.stringify({
        block: args.block,
        slots: args.slots ?? {},
        ...(Number(args.durationSec) > 0 ? { durationSec: args.durationSec } : {}),
        fillMode: args.useSampleContent ? "preview" : "render",
        format: baked ? "mp4" : "webm",
        ...(baked ? { backdrop: args.backdropUrl } : {}),
        name: args.block.slice(0, 60),
      }),
    });
  } catch (e: any) {
    throw new RenderBlockError(String(e?.message ?? e).slice(0, 160));
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new RenderBlockError(
      String(json?.statusMessage || json?.error || `Render failed (${res.status})`).slice(0, 200),
    );
  }
  if (json?.deviceUnavailable) {
    throw new RenderBlockError(
      "The desktop app is not connected — graphics render on your computer.",
    );
  }
  if (!json?.url) {
    throw new RenderBlockError(String(json?.error || "Render produced no file").slice(0, 200));
  }
  return {
    url: String(json.url),
    // WHAT CAME BACK, not what was asked: the route prefers the device's own
    // measurement, and a graphic trimmed to a guessed length cuts its own
    // animation off.
    durationSec: Number(json.durationSec) || Number(args.durationSec) || 0,
  };
}
