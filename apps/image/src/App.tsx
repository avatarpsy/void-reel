import { useEffect, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { useUIStore } from './stores/ui-store';
import { WelcomeScreen } from './components/welcome/WelcomeScreen';
import { EditorInterface } from './components/editor/EditorInterface';
import { KeyboardShortcutsPanel } from './components/editor/KeyboardShortcutsPanel';
import { SettingsDialog } from './components/editor/SettingsDialog';
import { CosmicField } from './components/CosmicField';
import { useKeyboardShortcuts } from './services/keyboard-service';
import { useAutoSave, loadSavedProject } from './hooks/useAutoSave';
import { bakePendingCompositions } from './services/composition/bake';
import { useProjectCloudSync } from './hooks/useProjectCloudSync';
import { readHandoffParams, setEditReturnId, clearHandoffUrl, loadSrcAsProject, parseEditSource } from './services/image-handoff';
import { openCloudCarouselById } from './services/carousel-cloud';
import { openImageProjectWithCache } from './services/project-cloud-open';
import { installImageRpc } from './agent/rpc';
import { useProjectStore } from './stores/project-store';
import { resolveBootTheme, watchSiteTheme } from '@openreel/ui';

// Was the app opened to DIRECTLY load a project (carousel deep-link or an
// "edit this image" handoff)? Read once, synchronously, before first paint —
// so we render a loading screen instead of flashing the welcome/landing page
// and only then jumping into the editor.
function readBootTarget(): { carouselId?: string; projectId?: string; preset?: NewPreset } | null {
  const p = new URLSearchParams(window.location.search);
  const carouselId = p.get('carousel');
  if (carouselId) return { carouselId };
  const projectId = p.get('project');
  if (projectId) return { projectId };
  const preset = readNewPreset(p);
  if (preset) return { preset };
  if (readHandoffParams()) return {};
  return null;
}

/**
 * ── ?new=<preset> — LAND ON THE DOCUMENT, NOT ON THE PICKER ──────────────────
 *
 * The format grid is the right first screen for a person browsing: they are
 * choosing, and choosing is what it is for. It is the wrong one for an intent
 * that has already been stated. Someone who said "make me a deck about Q3" — in
 * chat, to the primary agent, before this tab existed — has already answered
 * every question the picker asks, and showing it to them means their answer was
 * thrown away and they have to give it again.
 *
 * So the intent travels in the URL and the editor opens the document. The agent
 * beside it can then start on slide one instead of on a menu.
 *
 * Sizes are the CANVAS_PRESETS values, restated here rather than looked up by
 * name: the preset list is a UI catalogue that may be re-labelled or reordered,
 * and a deep link resolving through a display string would break the day someone
 * renames a tile. These five are a stable contract with the URL.
 */
/**
 * Has the `?src=` handoff already been taken by this page load?
 *
 * React 18 StrictMode mounts effects twice in development, and a second import
 * would stack a duplicate layer. This used to be guarded implicitly by
 * `clearHandoffUrl()` running synchronously at the top of the effect — but the
 * param is now kept until the load SUCCEEDS (so a failure stays retryable),
 * which means the guard has to be its own thing. Reset on failure so "Try
 * again" can re-enter.
 */
let handoffClaimed = false;

type NewPreset = { name: string; width: number; height: number };
const NEW_PRESETS: Record<string, NewPreset> = {
  // Square social post — the shape the format picker offers first, and the one
  // an agent's "square poster" needs; without it an automated request fell
  // through to the picker, which waits for a person.
  post: { name: 'Post', width: 1080, height: 1080 },
  thumbnail: { name: 'Thumbnail', width: 1280, height: 720 },
  presentation: { name: 'Presentation', width: 1920, height: 1080 },
  'presentation-4-3': { name: 'Presentation', width: 1024, height: 768 },
  carousel: { name: 'Carousel', width: 1080, height: 1350 },
  story: { name: 'Vertical story', width: 1080, height: 1920 },
  poster: { name: 'Poster', width: 2480, height: 3508 },
};

function readNewPreset(p: URLSearchParams): NewPreset | null {
  const key = (p.get('new') ?? '').trim().toLowerCase();
  if (!key) return null;
  const preset = NEW_PRESETS[key];
  if (!preset) return null;
  // An explicit title beats the generic one — the deck is findable in the
  // Images tab by what it is about rather than as a third "Presentation".
  const title = (p.get('title') ?? '').trim().slice(0, 80);
  return title ? { ...preset, name: title } : preset;
}

export default function App() {
  const { currentView, showShortcutsPanel, toggleShortcutsPanel, showSettingsDialog, closeSettingsDialog } = useUIStore();
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setEditSource = useUIStore((s) => s.setEditSource);

  // `booting` is true from the very first render when a deep-link is present,
  // so the welcome screen never flashes before the project opens.
  const [booting, setBooting] = useState(() => readBootTarget() !== null);
  // Why the "Edit this image" handoff could not open the picture, if it failed.
  // Rendered instead of the format picker so the tab never looks like a normal
  // empty editor when it was asked to open something.
  const [handoffError, setHandoffError] = useState<string | null>(null);

  useKeyboardShortcuts();
  useAutoSave();
  useProjectCloudSync();

  // Theme. The editor used to force `.dark` permanently, so on a light-themed
  // site the canvas pane stayed black — the one part of the page that ignored
  // the user's choice. The host relays the site's mode with the SAME
  // `voidspace:theme` message the video editor already answers, so both editors
  // follow the site through one mechanism.
  //
  // But a message only arrives once the host is listening, and it never arrives
  // at all for a standalone /image/ session — which is how the landing (the
  // format picker) came up dark on a light site, then snapped to light a beat
  // later once embedded. So the FIRST paint resolves the theme itself: /image/
  // is served from the site's own origin, so the site's saved preference is
  // readable directly. Messages remain the live-update channel.
  useEffect(() => {
    const apply = (mode: string) => {
      document.documentElement.classList.toggle('dark', mode !== 'light');
      // The canvas paints its workspace backdrop from the theme, and it only
      // repaints on a state/size change — without this nudge the surround keeps
      // the OLD theme's grey until the next edit.
      window.dispatchEvent(new Event('resize'));
    };
    const params = new URLSearchParams(window.location.search);
    apply(resolveBootTheme(params.get('theme')));
    const stopWatching = watchSiteTheme(apply);

    const onMessage = (e: MessageEvent) => {
      const msg: any = e?.data;
      if (!msg || typeof msg !== 'object' || msg.type !== 'voidspace:theme') return;
      apply(String(msg.mode || 'dark'));
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      stopWatching();
    };
  }, []);

  // Chat ↔ editor RPC. Installed unconditionally: it only ever answers
  // `voidspace:img-*` messages, so a standalone /image/ session (no parent frame)
  // simply never receives one. Gating it on an embed flag would mean a project
  // opened by deep link couldn't be driven by the agent.
  useEffect(() => installImageRpc(), []);

  // Deep-link: the Studio projects hub's Images tab opens a specific carousel
  // via /image/?carousel=<draftId>. Load it as a multi-page project. We KEEP
  // the ?carousel= param in the URL so it reflects the open project (shareable
  // / bookmarkable), unlike the transient one-shot ?src= handoff below.
  useEffect(() => {
    const carouselId = new URLSearchParams(window.location.search).get('carousel');
    if (!carouselId) return;
    (async () => {
      try {
        if (!await openCloudCarouselById(carouselId)) throw new Error('This carousel could not be opened. Check your connection and try again.');
      } catch (e) {
        console.warn('[image] could not open carousel:', e);
        setHandoffError(e instanceof Error ? e.message : 'Could not open this carousel. Try again.');
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // Reopen an image-editor project from the Studio Images tab: /image/?project=<id>.
  // Local-first — the full, layer-preserving project lives in this browser's
  // IndexedDB, so restore that exactly. On another device (no local copy) fall
  // back to a flattened rebuild from the cloud page thumbnails.
  useEffect(() => {
    const projectId = new URLSearchParams(window.location.search).get('project');
    if (!projectId) return;
    (async () => {
      try {
        const local = await loadSavedProject(projectId);
        if (!await openImageProjectWithCache(projectId, local)) throw new Error('This project could not be found. Check your account and try again.');
        void bakePendingCompositions().catch(() => {});
      } catch (e) {
        console.warn('[image] could not open project:', e);
        setHandoffError(e instanceof Error ? e.message : 'Could not open this project. Try again.');
      } finally {
        setBooting(false);
      }
    })();
  }, [setCurrentView]);

  /**
   * ?new=<preset> — mint the document and go straight to the editor.
   *
   * Runs BEFORE the handoff effect below and after the two that open an existing
   * document, which is the correct order of specificity: reopening a real project
   * always wins over creating a new one, and `?new` only ever fires when nothing
   * else claimed the boot.
   *
   * The param is left in the URL rather than cleared. `?src=` is cleared because
   * it is a one-shot handoff whose meaning expires the moment it is consumed —
   * reloading with it would re-import the image over the user's work. `?new` is
   * different only in that a reload would mint a SECOND empty project, so it is
   * consumed here in the same way: guarded by the store, not by the address bar,
   * because a page that has already loaded a project must never be re-minted.
   */
  useEffect(() => {
    const preset = readNewPreset(new URLSearchParams(window.location.search));
    if (!preset) return;
    // React 18 StrictMode mounts effects twice in development, and a second
    // createProject would silently discard the first document. The store is the
    // only honest guard: if something is already open, this boot is over.
    if (useProjectStore.getState().project) { setBooting(false); return; }
    try {
      useProjectStore.getState().createProject(preset.name, {
        width: preset.width, height: preset.height,
      });
      setCurrentView('editor');
    } catch (e) {
      console.warn('[image] could not create project from ?new:', e);
    } finally {
      setBooting(false);
    }
  }, [setCurrentView]);

  // "Edit this image" handoff: another surface opened us with ?src=…&from=…
  // Load the image as a fresh project; the user saves it from Export when done.
  //
  // Two rules here, both learned from "Edit opened an empty editor":
  //  1. `?src=` is cleared only AFTER the image is on the canvas. Clearing it up
  //     front destroyed the only record of what the user asked for, so a failure
  //     left them on the format picker with nothing to retry.
  //  2. A failure is SAID OUT LOUD. The old catch was a console.warn, so a CORS
  //     rejection and "you opened the editor normally" looked identical.
  useEffect(() => {
    const h = readHandoffParams();
    if (!h) return;
    if (handoffClaimed) return;
    handoffClaimed = true;
    const source = parseEditSource(h.src);
    (async () => {
      try {
        await loadSrcAsProject(h.src, h.from);
        // Overwrite-in-place target — a studio file on disk OR an object in
        // our own bucket. Null only for a provider url we cannot write to.
        setEditSource(source);
        // Who gets a saved COPY back. Still set when `source` exists, because
        // the user may choose "New copy" over updating the original, and that
        // copy should reach the card rather than only the Library.
        setEditReturnId(h.editReturn ?? null);
        setCurrentView('editor');
        setHandoffError(null);
        clearHandoffUrl(); // consumed — a refresh must not re-import over the work
      } catch (e) {
        handoffClaimed = false;
        console.warn('[image-handoff] could not open source image:', e);
        setHandoffError((e as Error)?.message || 'could not open that image');
      } finally {
        setBooting(false);
      }
    })();
  }, [setCurrentView, setEditSource]);

  // Note: Escape no longer exits the editor — it deselects/cancels (handled in
  // keyboard-service), matching Photoshop. Use the Home button to leave.

  // While a deep-linked project is loading, show a clean loading screen (never
  // the welcome page) so the transition into the editor is direct.
  const showBootLoading = booting && currentView !== 'editor';
  // A handoff that failed must not fall through to the format picker — that is
  // exactly the "editor opened without the image" the user reported.
  const showHandoffError = !!handoffError && currentView !== 'editor';

  return (
    <div className="h-full w-full bg-background">
      {showBootLoading ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background overflow-hidden">
          <CosmicField />
          <div className="relative z-10 flex flex-col items-center gap-3">
            <Loader2 className="w-7 h-7 text-primary animate-spin" />
            <p className="text-sm text-text-secondary">Opening your project…</p>
          </div>
        </div>
      ) : showHandoffError ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background overflow-hidden">
          <CosmicField />
          <div className="relative z-10 flex max-w-sm flex-col items-center gap-3 px-6 text-center">
            <ImageOff className="w-8 h-8 text-text-secondary" />
            <p className="text-base font-medium">Couldn’t open your project</p>
            <p className="text-sm text-text-secondary">{handoffError}</p>
            <div className="flex gap-2 pt-2">
              {/* The ?src= param is still in the URL — a reload re-runs the
                  whole handoff, which is what makes a transient failure
                  recoverable without going back to the other tab. */}
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-all"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => setHandoffError(null)}
                className="rounded-lg border border-border bg-background-secondary px-4 py-2 text-sm text-text-secondary hover:border-primary/40 hover:text-text-primary transition-all"
              >
                Start blank
              </button>
            </div>
          </div>
        </div>
      ) : currentView === 'welcome' ? (
        <WelcomeScreen />
      ) : currentView === 'editor' ? (
        <EditorInterface />
      ) : null}
      <KeyboardShortcutsPanel isOpen={showShortcutsPanel} onClose={toggleShortcutsPanel} />
      <SettingsDialog isOpen={showSettingsDialog} onClose={closeSettingsDialog} />
    </div>
  );
}
