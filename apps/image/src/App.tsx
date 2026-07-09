import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useUIStore } from './stores/ui-store';
import { WelcomeScreen } from './components/welcome/WelcomeScreen';
import { EditorInterface } from './components/editor/EditorInterface';
import { KeyboardShortcutsPanel } from './components/editor/KeyboardShortcutsPanel';
import { SettingsDialog } from './components/editor/SettingsDialog';
import { CosmicField } from './components/CosmicField';
import { useKeyboardShortcuts } from './services/keyboard-service';
import { useAutoSave } from './hooks/useAutoSave';
import { readHandoffParams, clearHandoffUrl, loadSrcAsProject, parseLocalAssetSource } from './services/image-handoff';
import { openCloudCarouselById } from './services/carousel-cloud';

// Was the app opened to DIRECTLY load a project (carousel deep-link or an
// "edit this image" handoff)? Read once, synchronously, before first paint —
// so we render a loading screen instead of flashing the welcome/landing page
// and only then jumping into the editor.
function readBootTarget(): { carouselId?: string } | null {
  const p = new URLSearchParams(window.location.search);
  const carouselId = p.get('carousel');
  if (carouselId) return { carouselId };
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

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

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
