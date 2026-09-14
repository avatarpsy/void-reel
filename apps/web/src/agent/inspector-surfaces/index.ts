/**
 * Auto-discovering registry of every Inspector surface the agent can drive.
 *
 * Two ways to add a surface — both auto-pick-up at build time:
 *
 *   1. SIMPLE (preferred for ~80% of sections): add ONE row to the
 *      ENTRIES array in `clip-properties.ts`. Maps a surface name to a
 *      project-store `update*` method + a JSON Schema for its args.
 *      No new file. No code in this index.
 *
 *   2. CUSTOM (for sections with non-trivial apply logic — transitions
 *      that generate keyframes, motion presets that build curves, AI
 *      pipelines): create a file in this directory exporting either
 *        export const surface: InspectorSurface = ...
 *      or
 *        export const surfaces: InspectorSurface[] = ...
 *      The vite glob below picks it up. No registration step.
 *
 * The agent reaches surfaces via three RPCs (App.tsx):
 *   voidspace:list-inspector-tools       → names + 1-line descriptions
 *   voidspace:get-inspector-tool-schema  → full schema for one surface
 *   voidspace:apply-inspector-tool       → run a surface against clip(s)
 *
 * The chat agent's three corresponding tools mirror this triplet so it
 * can discover-then-apply without preloading all surface schemas into
 * its prompt.
 */

import type { ClipKind, InspectorSurface, InspectorSurfaceClip } from "./types";
import type { Project } from "@openreel/core";

// Vite glob: collect every .ts in this folder except types/index/factories.
// `eager: true` inlines them so first-RPC latency is zero.
//
// TEST FILES ARE EXCLUDED AT THE GLOB, not by the filter below, and that
// distinction matters: `eager: true` means every match is a real import in the
// production bundle. A `*.test.ts` sitting in this directory would therefore
// pull `vitest` into the shipped app — it would never export a `surface`, so
// the filter would find nothing and the only symptom would be a bundle that
// imports a test runner. Keeping the negative pattern here means a surface can
// have its tests next to it, which is where they belong.
const modules = import.meta.glob<Record<string, unknown>>(
  ["./*.ts", "!./*.test.ts"],
  { eager: true },
);

export const SURFACES: Record<string, InspectorSurface> = {};

for (const [path, mod] of Object.entries(modules)) {
  if (
    path.endsWith("/index.ts") ||
    path.endsWith("/types.ts") ||
    path.endsWith("/clip-property-surface.ts")
  ) continue;
  const single = (mod as any).surface as InspectorSurface | undefined;
  const many = (mod as any).surfaces as InspectorSurface[] | undefined;
  const collected: InspectorSurface[] = [];
  if (single && typeof single.name === "string") collected.push(single);
  if (Array.isArray(many)) collected.push(...many.filter((s) => s && typeof s.name === "string"));
  for (const s of collected) {
    if (SURFACES[s.name]) {
      console.warn(`[inspector-surfaces] duplicate surface name "${s.name}" from ${path} — keeping first`);
      continue;
    }
    SURFACES[s.name] = s;
  }
}

export function getSurface(name: string): InspectorSurface | null {
  return SURFACES[name] ?? null;
}

export function listSurfaces(): Array<{
  name: string;
  description: string;
  appliesTo: readonly ClipKind[];
  readable: boolean;
}> {
  // Discovery payload — names + descriptions only. Schemas fetched
  // on-demand via get-inspector-tool-schema to keep agent context small.
  //
  // `readable` rides along because it changes what the agent should DO: a
  // readable surface can be inspected before it is changed (and its ids
  // recovered, which `video-effects` needs for update/remove/toggle), while an
  // unreadable one can only be set. One boolean per row, and it stops the
  // agent guessing at a read that would come back empty.
  return Object.values(SURFACES)
    .map((s) => ({
      name: s.name,
      description: s.description,
      appliesTo: s.appliesTo,
      readable: typeof s.read === "function",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve clips an agent operation should target, given the surface
 * (which declares appliesTo) and the selection args (clipIds | applyAll).
 * Walks timeline.tracks, project.textClips, and graphics arrays so a
 * single agent call can cover any clip type.
 */
export function resolveTargetClips(
  project: Project,
  surface: InspectorSurface,
  selection: { clipIds?: string[]; applyAll?: boolean },
): InspectorSurfaceClip[] {
  const matching = new Set<ClipKind>(surface.appliesTo);
  const wantId = selection.clipIds ? new Set(selection.clipIds) : null;
  const out: InspectorSurfaceClip[] = [];

  for (const tr of project.timeline?.tracks ?? []) {
    const trackKind = inferTrackKind(tr);
    for (const c of (tr as any).clips ?? []) {
      const kind = inferClipKind(c, trackKind);
      if (!matching.has(kind)) continue;
      if (wantId ? !wantId.has(c.id) : !selection.applyAll) continue;
      out.push({ id: c.id, kind, trackId: tr.id, raw: c });
    }
  }

  if (matching.has("text")) {
    for (const tc of (project as any).textClips ?? []) {
      if (wantId ? !wantId.has(tc.id) : !selection.applyAll) continue;
      out.push({
        id: tc.id, kind: "text",
        trackId: tc.trackId ?? "track-captions",
        raw: tc,
      });
    }
  }

  const proj = project as any;
  const graphicsKindMap: Record<string, ClipKind> = {
    shapeClips: "shape", svgClips: "svg", stickerClips: "sticker",
  };
  for (const [field, kind] of Object.entries(graphicsKindMap) as Array<[string, ClipKind]>) {
    if (!matching.has(kind) && !matching.has("graphics")) continue;
    for (const gc of proj[field] ?? []) {
      if (wantId ? !wantId.has(gc.id) : !selection.applyAll) continue;
      out.push({
        id: gc.id, kind,
        trackId: gc.trackId ?? "track-graphics",
        raw: gc,
      });
    }
  }

  return out;
}

function inferTrackKind(tr: any): ClipKind {
  const hay = `${String(tr?.id ?? "").toLowerCase()} ${String(tr?.type ?? tr?.kind ?? "").toLowerCase()}`;
  if (/captions?|subtitle|text/.test(hay)) return "text";
  if (/audio|narration|music|sfx|voice/.test(hay)) return "audio";
  if (/image|photo/.test(hay)) return "image";
  if (/graphics|shape|svg|sticker/.test(hay)) return "graphics";
  return "video";
}

function inferClipKind(c: any, trackKind: ClipKind): ClipKind {
  const t = String(c?.type ?? c?.kind ?? "").toLowerCase();
  if (t === "text") return "text";
  if (t === "image") return "image";
  if (t === "audio") return "audio";
  if (t === "shape") return "shape";
  if (t === "sticker") return "sticker";
  if (t === "svg") return "svg";
  return trackKind;
}
