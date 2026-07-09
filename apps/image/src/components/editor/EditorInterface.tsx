import { useState, useRef, lazy, Suspense } from 'react';
import { Toolbar } from './toolbar/Toolbar';
import { LeftPanel } from './panels/LeftPanel';
import { Canvas } from './canvas/Canvas';
import { Inspector } from './inspector/Inspector';
import { GenerativeFillPanel } from './inspector/GenerativeFillPanel';
import { GenerateImagePanel } from './inspector/GenerateImagePanel';
import { LayerSeparationModal } from './inspector/LayerSeparationModal';
import { HistoryPanel } from './panels/HistoryPanel';
import { GuidePanel } from './panels/GuidePanel';
import { PagesBar } from './pages/PagesBar';
import { useUIStore } from '../../stores/ui-store';
import { useProjectStore } from '../../stores/project-store';
import { History, Ruler } from 'lucide-react';

const ExportDialog = lazy(() => import('./ExportDialog').then(m => ({ default: m.ExportDialog })));
const PublishCarouselModal = lazy(() => import('./PublishCarouselModal').then(m => ({ default: m.PublishCarouselModal })));

// Layers now live in the LEFT panel (full height — Figma-style). The right side
// is the selected-layer Inspector plus a resizable Guides/History dock.
type BottomTab = 'history' | 'guides';

export function EditorInterface() {
  const { isPanelCollapsed, isInspectorCollapsed, isExportDialogOpen, closeExportDialog } = useUIStore();
  const publishCarouselOpen = useUIStore((s) => s.publishCarouselOpen);
  const setPublishCarouselOpen = useUIStore((s) => s.setPublishCarouselOpen);
  const { project } = useProjectStore();
  const [bottomTab, setBottomTab] = useState<BottomTab>('history');
  const [dockHeight, setDockHeight] = useState(240);
  const [leftWidth, setLeftWidth] = useState(288); // w-72 = 18rem
  const resizingRef = useRef(false);
  const leftResizingRef = useRef(false);

  const startLeftResize = (e: React.MouseEvent) => {
    e.preventDefault();
    leftResizingRef.current = true;
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) => {
      if (!leftResizingRef.current) return;
      const dx = ev.clientX - startX; // drag right => wider
      setLeftWidth(Math.max(200, Math.min(560, startW + dx)));
    };
    const onUp = () => {
      leftResizingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startY = e.clientY;
    const startH = dockHeight;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const dy = startY - ev.clientY; // drag up => taller
      setDockHeight(Math.max(120, Math.min(window.innerHeight - 220, startH + dy)));
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!project) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-background">
        <p className="text-muted-foreground">No project loaded</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      <Toolbar />

      <div className="flex-1 flex overflow-hidden">
        {!isPanelCollapsed && (
          <>
            <div style={{ width: leftWidth }} className="border-r border-border flex flex-col bg-card shrink-0">
              <LeftPanel />
            </div>
            {/* Drag the left panel's right edge to resize it horizontally. */}
            <div
              onMouseDown={startLeftResize}
              className="w-1.5 cursor-col-resize hover:bg-primary/40 transition-colors shrink-0"
              title="Drag to resize"
            />
          </>
        )}

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex overflow-hidden">
            <Canvas />
          </div>
          <PagesBar />
        </div>

        {!isInspectorCollapsed && (
          <div className="w-72 border-l border-border flex flex-col bg-card">
            <GenerativeFillPanel />
            <div className="flex-1 overflow-y-auto">
              <Inspector />
            </div>

            {/* Resizable Guides / History dock — drag the top edge to resize. */}
            <div
              onMouseDown={startResize}
              className="h-1.5 cursor-row-resize border-t border-border hover:bg-primary/40 transition-colors shrink-0"
              title="Drag to resize"
            />
            <div style={{ height: dockHeight }} className="flex flex-col shrink-0">
              <div className="flex border-b border-border">
                <button
                  onClick={() => setBottomTab('guides')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                    bottomTab === 'guides'
                      ? 'text-foreground bg-background border-b-2 border-primary -mb-px'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  <Ruler size={14} />
                  Guides
                </button>
                <button
                  onClick={() => setBottomTab('history')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                    bottomTab === 'history'
                      ? 'text-foreground bg-background border-b-2 border-primary -mb-px'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  <History size={14} />
                  History
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                {bottomTab === 'guides' && <GuidePanel />}
                {bottomTab === 'history' && <HistoryPanel />}
              </div>
            </div>
          </div>
        )}
      </div>

      {isExportDialogOpen && (
        <Suspense fallback={null}>
          <ExportDialog open={isExportDialogOpen} onClose={closeExportDialog} />
        </Suspense>
      )}

      <GenerateImagePanel />
      <LayerSeparationModal />

      {publishCarouselOpen && (
        <Suspense fallback={null}>
          <PublishCarouselModal open={publishCarouselOpen} onClose={() => setPublishCarouselOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
