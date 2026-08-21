import { useState, useRef, useEffect } from 'react';
import { Plus, Trash2, Copy, MoreHorizontal, ChevronUp, ChevronDown, Sparkles } from 'lucide-react';
import { useProjectStore } from '../../../stores/project-store';
import { useUIStore } from '../../../stores/ui-store';
import { exportArtboard } from '../../../services/export-service';
import type { Project, Artboard } from '../../../types/project';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@openreel/ui';

/**
 * A cheap description of everything on a page that a thumbnail would show.
 *
 * Not a hash of the pixels — that would mean rendering to find out whether to
 * render. It is the fields that change what gets drawn, in order, so two pages
 * with the same signature genuinely look the same. `sourceId` earns its place
 * here: a composition layer keeps its identity and gains an asset when its
 * render lands, and that swap is exactly the change the old cache could not see.
 */
function pageSignature(project: Project, ab: Artboard): string {
  const parts: string[] = [`${Math.round(ab.size.width)}x${Math.round(ab.size.height)}`,
    String((ab.background as any)?.color ?? '')];
  for (const id of ab.layerIds) {
    const l = project.layers[id] as any;
    if (!l) { parts.push(`${id}:gone`); continue; }
    const t = l.transform ?? {};
    parts.push([
      id, l.type, l.visible === false ? 'h' : 'v', l.opacity ?? 1,
      l.sourceId ?? '', l.content ?? '',
      Math.round(t.x ?? 0), Math.round(t.y ?? 0),
      Math.round(t.width ?? 0), Math.round(t.height ?? 0), Math.round(t.rotation ?? 0),
    ].join(','));
  }
  return parts.join('|');
}

export function PagesBar() {
  const {
    project,
    selectedArtboardId,
    selectArtboard,
    addArtboard,
    removeArtboard,
    updateArtboard,
  } = useProjectStore();

  const setGenerateImageOpen = useUIStore((s) => s.setGenerateImageOpen);

  const [isExpanded, setIsExpanded] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Real rendered previews per page, each kept with the SIGNATURE of the page it
  // was drawn from. Rendering every page on every change starves the canvas's own
  // image loads (pages stuck on "Loading"), so a thumbnail is reused while it is
  // still true — and the signature is what makes "still true" a question that can
  // be answered. Reusing on "do I have one", as this did, keeps a blank forever.
  const [thumbs, setThumbs] = useState<Record<string, { url: string; sig: string }>>({});
  const thumbsRef = useRef<Record<string, { url: string; sig: string }>>({});
  thumbsRef.current = thumbs;
  const inputRef = useRef<HTMLInputElement>(null);

  const artboardIds = project?.artboards.map((a) => a.id).join(',') ?? '';
  const projectRev = project?.updatedAt ?? 0;
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const have = thumbsRef.current;
      /**
       * Regenerate a page whose CONTENT changed, not only the selected one.
       *
       * This used to keep any thumbnail it already had and refresh only the
       * page being edited, on the reasoning that other pages do not change while
       * you work on this one. They do. The agent edits pages it has not selected,
       * and a composition's pixels arrive from a render tens of seconds AFTER
       * the layer was placed — so a deck built by the agent kept the blank
       * swatches taken before any slide had pixels, and the strip disagreed with
       * the canvas for the rest of the session.
       *
       * Comparing a cheap signature costs one string per page and makes "is this
       * thumbnail still true" answerable, which "do I have one" never was.
       */
      const targets = project.artboards.filter(
        (ab) => have[ab.id]?.sig !== pageSignature(project, ab) || ab.id === selectedArtboardId,
      );
      for (const ab of targets) {
        try {
          const scale = Math.min(1, 160 / Math.max(ab.size.width, ab.size.height));
          const blob = await exportArtboard(project, ab, { scale, format: 'jpg', quality: 'low', background: 'include' });
          if (cancelled) return;
          const dataUrl = await new Promise<string>((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result as string);
            fr.onerror = () => resolve('');
            fr.readAsDataURL(blob);
          });
          if (cancelled || !dataUrl) continue;
          // Stamp what was DRAWN. Recomputing the signature here rather than
          // reusing the one from the filter is deliberate: the page may have
          // changed again while this render was running, and recording the older
          // signature would mark a stale thumbnail as current.
          setThumbs((prev) => ({ ...prev, [ab.id]: { url: dataUrl, sig: pageSignature(project, ab) } }));
        } catch { /* leave this page's swatch fallback */ }
      }
      // Drop thumbnails for pages that no longer exist.
      const live = new Set(project.artboards.map((a) => a.id));
      const stale = Object.keys(have).filter((id) => !live.has(id));
      if (stale.length) setThumbs((prev) => {
        const next = { ...prev };
        for (const id of stale) delete next[id];
        return next;
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artboardIds, projectRev, selectedArtboardId]);

  if (!project) return null;

  const artboards = project.artboards;

  const handleAddPage = () => {
    const currentArtboard = artboards.find((a) => a.id === selectedArtboardId);
    const size = currentArtboard?.size ?? { width: 1080, height: 1080 };
    const newId = addArtboard(`Page ${artboards.length + 1}`, size);
    selectArtboard(newId);
  };

  const handleDuplicatePage = (artboardId: string) => {
    const artboard = artboards.find((a) => a.id === artboardId);
    if (!artboard) return;
    const newId = addArtboard(`${artboard.name} copy`, artboard.size);
    selectArtboard(newId);
  };

  const handleDeletePage = (artboardId: string) => {
    if (artboards.length <= 1) return;
    removeArtboard(artboardId);
  };

  const handleRename = (artboardId: string, newName: string) => {
    if (newName.trim()) {
      updateArtboard(artboardId, { name: newName.trim() });
    }
    setEditingId(null);
  };

  const handleStartRename = (artboardId: string) => {
    setEditingId(artboardId);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  return (
    <div className="bg-card border-t border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          <span>Pages</span>
          <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full">
            {artboards.length}
          </span>
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setGenerateImageOpen(true, true)}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded transition-colors"
            title="Generate a new page with AI"
          >
            <Sparkles size={13} />
            <span>Generate</span>
          </button>
          <button
            onClick={handleAddPage}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <Plus size={14} />
            <span>Add Page</span>
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="px-3 pb-3 overflow-x-auto">
          <div className="flex gap-2">
            {artboards.map((artboard) => {
              const isSelected = artboard.id === selectedArtboardId;
              const aspectRatio = artboard.size.width / artboard.size.height;
              const thumbHeight = 64;
              const thumbWidth = Math.min(thumbHeight * aspectRatio, 100);

              return (
                <div
                  key={artboard.id}
                  className={`group relative flex-shrink-0 rounded-lg border-2 transition-all cursor-pointer ${
                    isSelected
                      ? 'border-primary ring-2 ring-primary/20'
                      : 'border-border hover:border-muted-foreground'
                  }`}
                  onClick={() => selectArtboard(artboard.id)}
                >
                  <div
                    className="bg-muted rounded-md overflow-hidden"
                    style={{ width: thumbWidth, height: thumbHeight }}
                  >
                    {thumbs[artboard.id]?.url ? (
                      // Real rendered preview of the page's composited content.
                      <img
                        src={thumbs[artboard.id].url}
                        alt={artboard.name}
                        className="w-full h-full object-cover"
                        style={{
                          backgroundColor:
                            artboard.background.type === 'color' ? artboard.background.color : '#ffffff',
                        }}
                      />
                    ) : (
                      // Fallback swatch until the first render lands.
                      <div
                        className="w-full h-full"
                        style={{
                          backgroundColor:
                            artboard.background.type === 'color'
                              ? artboard.background.color
                              : artboard.background.type === 'transparent'
                              ? 'transparent'
                              : '#ffffff',
                          backgroundImage:
                            artboard.background.type === 'transparent'
                              ? 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)'
                              : undefined,
                          backgroundSize: '8px 8px',
                          backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
                        }}
                      />
                    )}
                  </div>

                  <div className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="w-5 h-5 flex items-center justify-center bg-background border border-border rounded shadow-sm hover:bg-accent transition-colors"
                        >
                          <MoreHorizontal size={12} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onClick={() => handleStartRename(artboard.id)}>
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDuplicatePage(artboard.id)}>
                          <Copy size={14} className="mr-2" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDeletePage(artboard.id)}
                          disabled={artboards.length <= 1}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 size={14} className="mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="absolute -bottom-5 left-0 right-0 text-center">
                    {editingId === artboard.id ? (
                      <input
                        ref={inputRef}
                        type="text"
                        defaultValue={artboard.name}
                        onBlur={(e) => handleRename(artboard.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleRename(artboard.id, e.currentTarget.value);
                          } else if (e.key === 'Escape') {
                            setEditingId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full text-[10px] text-center bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"
                        autoFocus
                      />
                    ) : (
                      <span
                        className={`text-[10px] truncate max-w-full inline-block ${
                          isSelected ? 'text-foreground font-medium' : 'text-muted-foreground'
                        }`}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          handleStartRename(artboard.id);
                        }}
                      >
                        {artboard.name}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            <button
              onClick={handleAddPage}
              className="flex-shrink-0 w-16 h-16 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border hover:border-muted-foreground hover:bg-accent/50 transition-all"
            >
              <Plus size={20} className="text-muted-foreground" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
