/**
 * Inspector surface contract for the Voidspace agent.
 *
 * Each Inspector section in openreel (Transform, Blending, Entry/Exit
 * Transitions, Emphasis Animation, Video Effects, etc.) becomes one
 * `InspectorSurface` here. The agent then has a single uniform RPC
 * (`voidspace:apply-inspector-tool`) and a single discovery RPC
 * (`voidspace:list-inspector-tools`) to drive every section.
 *
 * Adding a new surface = creating one file in this directory that exports
 * an `InspectorSurface`, then registering it in `index.ts`. No changes to
 * App.tsx, no per-section RPC handlers, no parallel chat-agent tools. The
 * agent's `list_inspector_tools` call automatically surfaces it.
 *
 * Design rules:
 *  - apply() must wrap the SAME native code path the Inspector section's
 *    "Apply" button uses (import the section's exported helper, call the
 *    project-store update method). NEVER reimplement.
 *  - apply() must be idempotent — re-running with the same config produces
 *    the same result.
 *  - schema must be a JSON Schema fragment (Draft 2020-12). The agent
 *    side renders it directly as the chat tool's input schema, so any
 *    edit here flows to the chat tool docs without code regen.
 *  - appliesTo declares which clip kinds this surface accepts. The
 *    generic RPC handler filters target clips against this list before
 *    calling apply(), so each surface gets only valid inputs.
 */

import type { Project } from "@openreel/core";

export type ClipKind =
  | "video"
  | "audio"
  | "text"
  | "graphics"
  | "shape"
  | "sticker"
  | "svg"
  | "image";

export interface InspectorSurfaceClip {
  id: string;
  kind: ClipKind;
  trackId: string;
  // The full clip object — surface implementations cast as needed.
  raw: Record<string, unknown>;
}

export interface ApplyContext {
  project: Project;
  /**
   * The full Zustand project store (from `useProjectStore.getState()`).
   * Surfaces use this to call the same store methods the Inspector uses
   * (e.g. `updateClipKeyframes`, `updateTextClip`).
   */
  store: Record<string, unknown>;
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  /**
   * Optional summary the agent can echo back to the user. Keep short.
   */
  note?: string;
}

export interface InspectorSurface<TConfig = unknown> {
  /**
   * Stable identifier the agent uses to address this surface.
   * Lowercase, kebab-case. Never rename — it's part of the agent contract.
   */
  name: string;
  /**
   * One-sentence description for the agent's tool docs.
   * Should answer: "what does this Inspector section do?"
   */
  description: string;
  /**
   * Clip kinds this surface applies to. Used by the generic RPC handler
   * to filter target clips before invoking apply().
   */
  appliesTo: readonly ClipKind[];
  /**
   * JSON Schema fragment for the `config` arg of apply-inspector-tool.
   * Rendered directly as the chat tool's input schema.
   */
  schema: Record<string, unknown>;
  /**
   * Apply the config to a single clip. Wrap the native Inspector path
   * — never reimplement the underlying mutation.
   */
  apply: (
    clip: InspectorSurfaceClip,
    config: TConfig,
    ctx: ApplyContext,
  ) => ApplyResult | Promise<ApplyResult>;
}

/**
 * Manifest entry returned by voidspace:list-inspector-tools.
 * Must remain JSON-serializable (no functions).
 */
export interface InspectorSurfaceManifest {
  name: string;
  description: string;
  appliesTo: readonly ClipKind[];
  schema: Record<string, unknown>;
}

export function manifestOf(s: InspectorSurface): InspectorSurfaceManifest {
  return {
    name: s.name,
    description: s.description,
    appliesTo: s.appliesTo,
    schema: s.schema,
  };
}
