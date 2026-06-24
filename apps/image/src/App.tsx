import { useEffect } from 'react';
import { useUIStore } from './stores/ui-store';
import { WelcomeScreen } from './components/welcome/WelcomeScreen';
import { EditorInterface } from './components/editor/EditorInterface';
import { KeyboardShortcutsPanel } from './components/editor/KeyboardShortcutsPanel';
import { SettingsDialog } from './components/editor/SettingsDialog';
import { useKeyboardShortcuts } from './services/keyboard-service';
import { useAutoSave } from './hooks/useAutoSave';

export default function App() {
  const { currentView, showShortcutsPanel, toggleShortcutsPanel, showSettingsDialog, closeSettingsDialog } = useUIStore();

  useKeyboardShortcuts();
  useAutoSave();

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

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
