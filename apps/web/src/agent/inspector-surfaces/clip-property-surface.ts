/**
 * Factory: turns a small declarative descriptor into a full
 * `InspectorSurface`. Used for the ~80% of Inspector sections that just
 * call a single `store.update*()` method with the agent's config (Blending,
 * Blend Opacity, Perspective, Crop, Transform, etc.).
 *
 * To add a new direct-property surface, add ONE row to the table in
 * clip-properties.ts. No App.tsx changes, no glob changes, no chat-tool
 * changes — the registry's import.meta.glob picks up the surface, the
 * generic apply-inspector-tool RPC routes to it, the chat agent
 * discovers it via list_inspector_tools.
 */

import type {
  InspectorSurface,
  InspectorSurfaceClip,
  ApplyContext,
  ApplyResult,
  ClipKind,
} from "./types";

export interface ClipPropertyDescriptor {
  /** Stable name (kebab-case). Part of the agent contract — never rename. */
  name: string;
  /** One-sentence summary for the agent's tool list. */
  description: string;
  /** Clip kinds the property applies to. */
  appliesTo: readonly ClipKind[];
  /**
   * Project-store method name to invoke. Resolved via
   * `useProjectStore.getState()[storeMethod]`. The first arg is always
   * `clipId`; remaining args come from `toStoreArgs(config, clip)`.
   */
  storeMethod: string;
  /** JSON Schema fragment for the agent's `config` arg. */
  schema: Record<string, unknown>;
  /**
   * Map agent config → args for the store method (after clipId).
   * Default: pass the whole config object as one argument.
   */
  toStoreArgs?: (config: any, clip: InspectorSurfaceClip) => unknown[];
  /**
   * Read the property back off the clip, in the shape `apply` accepts.
   *
   * Every direct-property surface CAN be read — the value it writes is a field
   * on the clip — so this is the cheap half of closing the write-only gap, one
   * line per row in the table. A row without one still works; it simply
   * reports itself as not readable rather than reporting a wrong value.
   */
  fromClip?: (clip: InspectorSurfaceClip, ctx: ApplyContext) => unknown;
}

export function makeClipPropertySurface(
  p: ClipPropertyDescriptor,
): InspectorSurface {
  return {
    name: p.name,
    description: p.description,
    appliesTo: p.appliesTo,
    schema: p.schema,
    apply: (clip, config, ctx: ApplyContext): ApplyResult => {
      const store = ctx.store as Record<string, unknown>;
      const fn = store[p.storeMethod];
      if (typeof fn !== "function") {
        return {
          ok: false,
          error: `store.${p.storeMethod} not callable on this clip kind (${clip.kind})`,
        };
      }
      const extra = p.toStoreArgs ? p.toStoreArgs(config, clip) : [config];
      try {
        const r = (fn as Function).call(store, clip.id, ...extra);
        // Most update* return boolean. truthy = ok; void = ok; false = no clip found.
        return { ok: r !== false, note: `${p.name} ✓` };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    ...(p.fromClip
      ? {
          read: (clip: InspectorSurfaceClip, ctx: ApplyContext) => {
            try {
              return p.fromClip!(clip, ctx);
            } catch {
              // A read that throws must not look like "not set" — say nothing
              // rather than something false.
              return null;
            }
          },
        }
      : {}),
  };
}
