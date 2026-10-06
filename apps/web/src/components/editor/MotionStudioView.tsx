/**
 * The Motion view — HyperFrames Studio for THIS project, inside the editor.
 *
 * It is their own editor, unmodified: timeline, inspector, layers, variables,
 * catalog, renders — everything HyperFrames ships, and everything they ship
 * next, by bumping one version on the desktop. The desktop app runs it on the
 * user's machine for this project's folder (`~/Voidspace/motion/vs-<id>/`) and
 * puts a small proxy in front that themes it with our tokens and forwards its
 * agent hand-offs (see `hyperframes_studio_host.dart`).
 *
 * This view adds only the two seams between their editor and ours:
 *  - "Describe a change to the agent" in Studio copies a prompt; the proxy's
 *    shim forwards that copy here and we hand it to the Voidspace agent in the
 *    chat beside the editor (their agent lives in a closed desktop app).
 *  - "Add render to timeline" brings a Studio render onto OUR timeline as a
 *    local import, exactly like a dropped file.
 *
 * WHY THE PING: the desktop answers with a loopback URL, which only means
 * something if this browser runs on that same computer. We ask the proxy who
 * it is before framing it, so a person on another machine gets a sentence, not
 * a broken frame.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Clapperboard, Loader2, Monitor, Plus, RefreshCw } from "lucide-react";
import { useVoidspaceStore } from "../../stores/voidspace-store";
import { useProjectStore } from "../../stores/project-store";
import { useThemeStore } from "../../stores/theme-store";
import { useUIStore } from "../../stores/ui-store";
import { toast } from "../../stores/notification-store";
import { apiBase } from "../../services/open-folder";

interface StudioInfo {
  url: string;
  origin: string;
  studioProjectId: string;
  version: string;
}

type ViewState =
  | { kind: "starting" }
  | { kind: "ready"; studio: StudioInfo }
  | { kind: "no-desktop"; message: string }
  | { kind: "unreachable" }
  | { kind: "error"; message: string };

/** Studio's agent hand-offs are versioned requests ("## HyperFrames element
 *  edit request v1"). Anything else they copy (a path, a hex) stays a copy. */
const AGENT_REQUEST = /^##\s*HyperFrames\b[^\n]*\brequest\b/i;

function projectIdFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get("sceneListId") || "";
  } catch {
    return "";
  }
}

async function ping(origin: string, projectId: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${origin}/__voidspace_motion`, { signal: ctrl.signal });
    const json = await res.json();
    return json?.projectId === projectId;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function MotionStudioView({ active }: { active: boolean }) {
  const [state, setState] = useState<ViewState>({ kind: "starting" });
  const [placing, setPlacing] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const isDark = useThemeStore((s) => s.isDark);
  const settings = useProjectStore((s) => s.project.settings);
  const projectId = projectIdFromUrl();

  const open = useCallback(async () => {
    setState({ kind: "starting" });
    if (!projectId) {
      setState({ kind: "error", message: "Save this project first — Motion works on a saved project." });
      return;
    }
    const token = await useVoidspaceStore.getState().getIdToken?.();
    if (!token) {
      setState({ kind: "error", message: "Sign in to use the Motion studio." });
      return;
    }
    const aspect = settings.width > settings.height ? "16:9" : settings.width < settings.height ? "9:16" : "1:1";
    try {
      const res = await fetch(`${apiBase()}/api/studio/motion`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", projectId, aspect, theme: isDark ? "dark" : "light" }),
      });
      const json = await res.json().catch(() => ({} as any));
      if (json?.deviceUnavailable) {
        setState({ kind: "no-desktop", message: String(json.error || "") });
        return;
      }
      if (!res.ok || !json?.ok || !json?.url) {
        setState({ kind: "error", message: String(json?.error || json?.statusMessage || "The Motion studio did not start.") });
        return;
      }
      const studio: StudioInfo = {
        url: json.url,
        origin: json.origin,
        studioProjectId: json.studioProjectId,
        version: json.version,
      };
      if (!(await ping(studio.origin, projectId))) {
        setState({ kind: "unreachable" });
        return;
      }
      setState({ kind: "ready", studio });
    } catch (e: any) {
      setState({ kind: "error", message: e?.message || String(e) });
    }
    // isDark/settings are read at open time only; theme changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    void open();
  }, [open]);

  const studio = state.kind === "ready" ? state.studio : null;

  // Their agent buttons → our agent.
  useEffect(() => {
    if (!studio) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== studio.origin) return;
      const d = e.data as any;
      if (!d || d.source !== "hyperframes-studio") return;
      if (d.type === "copy" && typeof d.text === "string" && AGENT_REQUEST.test(d.text.trim())) {
        try {
          window.parent.postMessage(
            { type: "voidspace:agent-prompt", text: d.text, from: "motion" },
            apiBase() || window.location.origin,
          );
          toast.success("Sent to your agent", "It is working on it in the chat.");
        } catch {
          toast.info("Copied", "Paste it into the chat to send it to your agent.");
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [studio]);

  // Keep their theme in step with ours.
  useEffect(() => {
    if (!studio) return;
    frameRef.current?.contentWindow?.postMessage(
      { target: "hyperframes-studio", type: "theme", theme: isDark ? "dark" : "light" },
      studio.origin,
    );
  }, [studio, isDark]);

  const addLatestRender = useCallback(async () => {
    if (!studio) return;
    setPlacing(true);
    try {
      const listUrl = `${studio.origin}/api/projects/${encodeURIComponent(studio.studioProjectId)}/renders`;
      const list = await fetch(listUrl).then((r) => r.json());
      const render = (list?.renders ?? []).find((r: any) => r?.status === "complete");
      if (!render) {
        toast.info("No render yet", "Export from the Motion studio first, then add it here.");
        return;
      }
      const fileUrl = `${studio.origin}/api/projects/${encodeURIComponent(studio.studioProjectId)}/renders/file/${encodeURIComponent(render.filename)}`;
      const blob = await fetch(fileUrl).then((r) => {
        if (!r.ok) throw new Error(`render download failed (${r.status})`);
        return r.blob();
      });
      const file = new File([blob], `motion-${render.filename}`, { type: blob.type || "video/mp4" });
      const store = useProjectStore.getState();
      const imported = await store.importMedia(file);
      if (!imported.success || !imported.actionId) throw new Error(imported.error?.message || "import failed");
      const tracks = useProjectStore.getState().project.timeline?.tracks ?? [];
      const videoTrack = tracks.find((t: any) => t.type === "video");
      if (videoTrack) {
        const end = Math.max(0, ...(videoTrack.clips ?? []).map((c: any) => c.startTime + c.duration));
        await store.addClip(videoTrack.id, imported.actionId, end);
      } else {
        await store.addClipToNewTrack(imported.actionId, 0);
      }
      toast.success("Added to the timeline", render.filename);
      useUIStore.getState().setEditorView("timeline");
    } catch (e: any) {
      toast.error("Could not add the render", e?.message || String(e));
    } finally {
      setPlacing(false);
    }
  }, [studio]);

  return (
    <div className={active ? "flex-1 flex flex-col min-h-0 bg-background" : "hidden"}>
      <div className="h-10 shrink-0 flex items-center gap-3 px-3 border-b border-border bg-background-secondary">
        <Clapperboard size={15} className="text-primary" />
        <span className="text-text-primary text-xs font-medium">Motion</span>
        <span className="text-text-muted text-[11px]">
          HyperFrames Studio{studio ? ` ${studio.version}` : ""} · on your computer
        </span>
        <div className="flex-1" />
        {studio && (
          <button
            onClick={addLatestRender}
            disabled={placing}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-50 transition-colors"
          >
            {placing ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Add latest render to timeline
          </button>
        )}
        <button
          onClick={() => useUIStore.getState().setEditorView("timeline")}
          className="h-7 px-2.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-background-elevated transition-colors"
        >
          Back to timeline
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {studio ? (
          <iframe
            ref={frameRef}
            src={studio.url}
            title="Motion — HyperFrames Studio"
            className="absolute inset-0 w-full h-full border-0 bg-background"
            allow="clipboard-write; local-network-access; fullscreen"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="max-w-md text-center flex flex-col items-center gap-3">
              {state.kind === "starting" && (
                <>
                  <Loader2 size={22} className="animate-spin text-primary" />
                  <p className="text-text-primary text-sm">Starting the Motion studio on your computer…</p>
                  <p className="text-text-muted text-xs leading-relaxed">
                    The first time takes a minute while it downloads. If your browser asks to let
                    Voidspace connect to apps on this device, allow it — that is how the studio on your
                    computer appears here.
                  </p>
                </>
              )}
              {state.kind === "no-desktop" && (
                <>
                  <Monitor size={22} className="text-text-secondary" />
                  <p className="text-text-primary text-sm">Motion runs in the Voidspace desktop app</p>
                  <p className="text-text-muted text-xs leading-relaxed">
                    Open Voidspace on your computer, then try again. Don&apos;t have it yet?{" "}
                    <a className="text-primary hover:underline" href="/download" target="_top">
                      Get the desktop app
                    </a>
                    .
                  </p>
                </>
              )}
              {state.kind === "unreachable" && (
                <>
                  <AlertTriangle size={22} className="text-text-secondary" />
                  <p className="text-text-primary text-sm">This browser can&apos;t reach the Motion studio</p>
                  <p className="text-text-muted text-xs leading-relaxed">
                    It is running on the computer with your Voidspace desktop app. Open this project in a
                    browser on that computer — and if the browser asked about connecting to apps on this
                    device, allow it.
                  </p>
                </>
              )}
              {state.kind === "error" && (
                <>
                  <AlertTriangle size={22} className="text-text-secondary" />
                  <p className="text-text-primary text-sm">The Motion studio didn&apos;t start</p>
                  <p className="text-text-muted text-xs leading-relaxed break-words">{state.message}</p>
                </>
              )}
              {state.kind !== "starting" && (
                <button
                  onClick={() => void open()}
                  className="mt-1 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs bg-background-elevated text-text-primary hover:bg-background-tertiary transition-colors"
                >
                  <RefreshCw size={13} /> Try again
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MotionStudioView;
