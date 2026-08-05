import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useUIStore } from './stores/ui-store';
import { WelcomeScreen } from './components/welcome/WelcomeScreen';
import { EditorInterface } from './components/editor/EditorInterface';
import { KeyboardShortcutsPanel } from './components/editor/KeyboardShortcutsPanel';
import { SettingsDialog } from './components/editor/SettingsDialog';
import { CosmicField } from './components/CosmicField';
import { useKeyboardShortcuts } from './services/keyboard-service';
import { useAutoSave, loadSavedProject } from './hooks/useAutoSave';
import { useProjectCloudSync } from './hooks/useProjectCloudSync';
import { readHandoffParams, clearHandoffUrl, loadSrcAsProject, parseLocalAssetSource } from './services/image-handoff';
import { openCloudCarouselById } from './services/carousel-cloud';
import { openCloudImageProject } from './services/project-cloud-open';
import { installImageRpc } from './agent/rpc';
import { useProjectStore } from './stores/project-store';
import { resolveBootTheme, watchSiteTheme } from '@openreel/ui';

// Was the app opened to DIRECTLY load a project (carousel deep-link or an
// "edit this image" handoff)? Read once, synchronously, before first paint —
// so we render a loading screen instead of flashing the welcome/landing page
// and only then jumping into the editor.
function readBootTarget(): { carouselId?: string; projectId?: string } | null {
  const p = new URLSearchParams(window.location.search);
  const carouselId = p.get('carousel');
  if (carouselId) return { carouselId };
  const projectId = p.get('project');
  if (projectId) return { projectId };
  if (readHandoffParams()) return {};
  return null;
}

export default function App() {
  const { currentView, showShortcutsPanel, toggleShortcutsPanel, showSettingsDialog, closeSettingsDialog } = useUIStore();
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setEditSource = useUIStore((s) => s.setEditSource);

  // `booting` is true from the very first render when a deep-link is present,
  // so the welcome screen never flashes before the project opens.
  const [booting, setBooting] = useState(() => readBootTarget() !== null);

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
        await openCloudCarouselById(carouselId);
      } catch (e) {
        console.warn('[image] could not open carousel:', e);
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
        if (local) {
          useProjectStore.getState().loadProject(local);
          setCurrentView('editor');
          return;
        }
        await openCloudImageProject(projectId);
      } catch (e) {
        console.warn('[image] could not open project:', e);
      } finally {
        setBooting(false);
      }
    })();
  }, [setCurrentView]);

  // "Edit this image" handoff: another surface opened us with ?src=…&from=…
  // Load the image as a fresh project; the user saves it from Export when done.
  useEffect(() => {
    const h = readHandoffParams();
    if (!h) return;
    clearHandoffUrl();
    const source = parseLocalAssetSource(h.src);
    (async () => {
      try {
        await loadSrcAsProject(h.src, h.from);
        setEditSource(source); // overwrite-in-place target (null if not local)
        setCurrentView('editor');
      } catch (e) {
        console.warn('[image-handoff] could not open source image:', e);
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
