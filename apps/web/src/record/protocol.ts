/**
 * The shot recorder's conversation with the board that opened it.
 *
 * The board page opens `/studio/record.html?shotId=..&boardId=..&aspect=..` in
 * a full-screen iframe. Messages (all same-origin, all through window.parent):
 *
 *   recorder → board  { type: 'voidspace:recorder-ready',  shotId }
 *   board → recorder  { type: 'voidspace:recorder-init',   shotId, title, script, aspect }
 *   recorder → board  { type: 'voidspace:recorder-script', shotId, script }        (debounced edits)
 *   recorder → board  { type: 'voidspace:recorder-take',   shotId, url, durationSec, label, keepOpen: true }
 *   board → recorder  { type: 'voidspace:recorder-take-result', shotId, ok, message? }
 *   recorder → board  { type: 'voidspace:recorder-close' }
 *
 * Only messages from our own origin AND from the parent window are read. A take
 * is "on the shot" only once the board answers ok; the board keeps at most
 * MAX_SCRIPT characters of a script.
 */
import { WEBCAM_ASPECTS, type WebcamAspect } from "../services/screen-recorder";

export const MAX_SCRIPT = 4000;

export interface RecordParams {
  shotId: string;
  boardId: string;
  aspect: string;
}

export interface RecorderInit {
  shotId: string;
  title: string;
  script: string;
  aspect: string;
}

export type RecorderOutMessage =
  | { type: "voidspace:recorder-ready"; shotId: string }
  | { type: "voidspace:recorder-script"; shotId: string; script: string }
  | {
      type: "voidspace:recorder-take";
      shotId: string;
      url: string;
      durationSec: number;
      label: string;
      keepOpen: true;
    }
  | { type: "voidspace:recorder-close" };

export function readParams(search: string): RecordParams {
  const q = new URLSearchParams(search);
  return {
    shotId: (q.get("shotId") ?? "").trim(),
    boardId: (q.get("boardId") ?? "").trim(),
    aspect: (q.get("aspect") ?? "").trim(),
  };
}

/** A message we may act on: same origin, sent by the window that embeds us. */
export function isFromParent(
  event: Pick<MessageEvent, "origin" | "source">,
  win: Pick<Window, "parent" | "location"> = window,
): boolean {
  return event.source != null && event.origin === win.location.origin && event.source === win.parent;
}

/** The board's init message for this shot, or null when it is anything else. */
export function readInit(data: unknown, shotId: string): RecorderInit | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "voidspace:recorder-init") return null;
  const id = typeof d.shotId === "string" ? d.shotId : "";
  if (shotId && id !== shotId) return null;
  return {
    shotId: id,
    title: typeof d.title === "string" ? d.title.slice(0, 200) : "",
    script: typeof d.script === "string" ? d.script.slice(0, MAX_SCRIPT) : "",
    aspect: typeof d.aspect === "string" ? d.aspect : typeof d.aspect === "number" ? String(d.aspect) : "",
  };
}

export interface TakeResult {
  ok: boolean;
  message?: string;
}

/** The board's answer to a take we sent, or null when it is anything else. */
export function readTakeResult(data: unknown, shotId: string): TakeResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "voidspace:recorder-take-result") return null;
  if (shotId && d.shotId !== shotId) return null;
  return {
    ok: d.ok === true,
    ...(typeof d.message === "string" && d.message.trim() ? { message: d.message.slice(0, 300) } : {}),
  };
}

/**
 * Turn the shot's aspect ("9:16", "16:9", "1.78", …) into recorder options.
 * A ratio the recorder knows by name is chosen by name; any other valid ratio
 * is passed as the target; nothing usable means the camera's own shape (the
 * recorder's "match" rule with no target).
 */
export function aspectToRecorder(aspect: string): {
  aspect: WebcamAspect;
  targetAspect?: number;
  ratio: number | null;
} {
  const ratio = parseRatio(aspect);
  if (!ratio) return { aspect: "project", ratio: null };
  const named = WEBCAM_ASPECTS.find(
    (a) => a.ratio !== null && Math.abs(a.ratio - ratio) <= 0.01 * a.ratio,
  );
  if (named) return { aspect: named.value, targetAspect: named.ratio!, ratio: named.ratio };
  return { aspect: "project", targetAspect: ratio, ratio };
}

function parseRatio(s: string): number | null {
  const t = (s || "").trim();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)\s*[:x/×]\s*(\d+(?:\.\d+)?)$/i.exec(t);
  const r = m ? Number(m[1]) / Number(m[2]) : Number(t);
  return Number.isFinite(r) && r > 0.2 && r < 5 ? r : null;
}

export function postToParent(msg: RecorderOutMessage): void {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, window.location.origin);
    }
  } catch {
    /* not embedded */
  }
}
