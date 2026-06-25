import { useEffect } from 'react';
import { useUIStore } from './stores/ui-store';
import { WelcomeScreen } from './components/welcome/WelcomeScreen';
import { EditorInterface } from './components/editor/EditorInterface';
import { KeyboardShortcutsPanel } from './components/editor/KeyboardShortcutsPanel';
import { SettingsDialog } from './components/editor/SettingsDialog';
import { useKeyboardShortcuts } from './services/keyboard-service';
import { useAutoSave } from './hooks/useAutoSave';
import { readHandoffParams, clearHandoffUrl, loadSrcAsProject, parseLocalAssetSource } from './services/image-handoff';

export default function App() {
  const { currentView, showShortcutsPanel, toggleShortcutsPanel, showSettingsDialog, closeSettingsDialog } = useUIStore();
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setEditSource = useUIStore((s) => s.setEditSource);

  useKeyboardShortcuts();
  useAutoSave();

  useEffect(() => {
    document.documentElement.classList.add('dark');
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
      }
    })();
  }, [setCurrentView, setEditSource]);

  // Note: Escape no longer exits the editor — it deselects/cancels (handled in
  // keyboard-service), matching Photoshop. Use the Home button to leave.

  return (
    <div className="h-full w-full bg-background">
      {currentView === 'welcome' && <WelcomeScreen />}
      {currentView === 'editor' && <EditorInterface />}
      <KeyboardShortcutsPanel isOpen={showShortcutsPanel} onClose={toggleShortcutsPanel} />
      <SettingsDialog isOpen={showSettingsDialog} onClose={closeSettingsDialog} />
    </div>
  );
}
