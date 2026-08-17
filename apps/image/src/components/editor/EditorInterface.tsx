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
import { PanelCollapseButton, PanelRail } from '@openreel/ui';
import { useUIStore } from '../../stores/ui-store';
import { useProjectStore } from '../../stores/project-store';
import { History, Ruler, SlidersHorizontal } from 'lucide-react';

const ExportDialog = lazy(() => import('./ExportDialog').then(m => ({ default: m.ExportDialog })));
const PublishCarouselModal = lazy(() => import('./PublishCarouselModal').then(m => ({ default: m.PublishCarouselModal })));

// Layers live in the LEFT panel (full height — Figma-style). The right column is
// a single tab strip: the selected-layer/artboard properties, guides, and edit
// history are PEERS, so whichever one you are using gets the full height.
type RightTab = 'design' | 'guides' | 'history';

const RIGHT_TABS: Array<{ key: RightTab; label: string; Icon: typeof SlidersHorizontal }> = [
  { key: 'design', label: 'Design', Icon: SlidersHorizontal },
  { key: 'guides', label: 'Guides', Icon: Ruler },
  { key: 'history', label: 'History', Icon: History },
];

export function EditorInterface() {
  const {
    isPanelCollapsed,
    isInspectorCollapsed,
    togglePanelCollapsed,
    toggleInspectorCollapsed,
    isExportDialogOpen,
    closeExportDialog,
  } = useUIStore();
  const publishCarouselOpen = useUIStore((s) => s.publishCarouselOpen);
  const setPublishCarouselOpen = useUIStore((s) => s.setPublishCarouselOpen);
  const { project } = useProjectStore();
  const [rightTab, setRightTab] = useState<RightTab>('design');
  const [leftWidth, setLeftWidth] = useState(288); // w-72 = 18rem
  // The right column used to be a hard `w-72`, so it was the one editor column
  // in the product you could not widen — a Curves or a Levels panel had to
  // scroll sideways inside a fixed sliver while the canvas had room to spare.
  const [rightWidth, setRightWidth] = useState(288);
  const resizingRef = useRef(false);

  /**
   * One resize routine for both columns.
   *
   * `grow` says which way the cursor has to travel to make the panel bigger:
   * the left column widens as the pointer moves right, the right column as it
   * moves left. Two near-identical handlers is how the two sides drift.
   */
  const startResize = (
    e: React.MouseEvent,
    current: number,
    apply: (px: number) => void,
    grow: 1 | -1,
  ) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      apply(Math.max(200, Math.min(560, current + (ev.clientX - startX) * grow)));
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
        {isPanelCollapsed ? (
          /* A rail, not an absence. Collapsing used to unmount this column
             outright, so the only route back was a toolbar button on the far
             side of the screen that you had to already know about. */
          /* `bg-card` because that is what THIS editor's panels are painted
             with; the shared default is the video editor's token and the two
             differ slightly in light mode. */
          <PanelRail side="left" label="Layers" onExpand={togglePanelCollapsed} className="bg-card" />
        ) : (
          <>
            <div style={{ width: leftWidth }} className="border-r border-border flex flex-col bg-card shrink-0">
              <LeftPanel />
            </div>
            {/* Drag the left panel's right edge to resize it horizontally. */}
            <div
              onMouseDown={(e) => startResize(e, leftWidth, setLeftWidth, 1)}
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

        {isInspectorCollapsed ? (
          <PanelRail side="right" label="Design" onExpand={toggleInspectorCollapsed} className="bg-card" />
        ) : (
          /* ONE tabbed column: Design · Guides · History.
             It used to be the Inspector stacked ABOVE a resizable Guides/History
             dock, which split the column in two and gave each half too little
             room — the properties list scrolled inside a sliver while History sat
             half-empty below it, and the drag handle between them was easy to
             grab by accident. Three peers in one tab strip means whichever one
             you are using gets the whole column. */
          <>
            <div
              onMouseDown={(e) => startResize(e, rightWidth, setRightWidth, -1)}
              className="w-1.5 cursor-col-resize hover:bg-primary/40 transition-colors shrink-0"
              title="Drag to resize"
            />
          <div style={{ width: rightWidth }} className="border-l border-border flex flex-col bg-card shrink-0">
            {/* The tab strip IS this panel's header, so the collapse button
                joins it at the trailing edge — the same last-item-on-the-top-row
                position the other panels use. `shrink-0` on the tabs keeps the
                button from being squeezed out as the column narrows. */}
            <div className="flex items-center border-b border-border shrink-0">
              <div className="flex flex-1 min-w-0" role="tablist" aria-label="Panel">
              {RIGHT_TABS.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={rightTab === key}
                  onClick={() => setRightTab(key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                    rightTab === key
                      ? 'text-foreground bg-background border-b-2 border-primary -mb-px'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
              </div>
              <PanelCollapseButton
                side="right"
                collapsed={false}
                name="Design"
                onToggle={toggleInspectorCollapsed}
                className="mr-1.5"
              />
            </div>

            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Generative Fill is a MODE, not a tab: it opens from the canvas
                  context menu and must stay visible while you work on the
                  selection, whichever tab is showing. */}
              <GenerativeFillPanel />
              {rightTab === 'design' && (
                <div className="flex-1 overflow-y-auto">
                  <Inspector />
                </div>
              )}
              {rightTab === 'guides' && <GuidePanel />}
              {rightTab === 'history' && <HistoryPanel />}
            </div>
          </div>
          </>
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
