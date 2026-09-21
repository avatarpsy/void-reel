import { useState, useMemo, useEffect } from 'react';
import { Download, Loader2, Link2, Link2Off, CloudUpload } from 'lucide-react';
import { Dialog, DialogFooter } from '../ui/Dialog';
import { useProjectStore } from '../../stores/project-store';
import { useUIStore } from '../../stores/ui-store';
// Its own tiny module on purpose: pptx-export drags in pptxgenjs and pdf-lib,
// which are loaded only when somebody actually exports.
import { pptxTextNote } from '../../services/pptx-text-note';
import {
  exportProject,
  exportArtboard,
  downloadBlob,
  getExportFilename,
  type ExportFormat,
  type ExportQuality,
  type ExportOptions,
} from '../../services/export-service';
import { saveImageToVoidspaceLibrary, overwriteEditSource, NotSignedInError } from '../../services/voidspace-storage';
import { announceEditedImage } from '../../services/image-handoff';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

type FormatInfo = {
  id: ExportFormat;
  name: string;
  description: string;
  supportsTransparency: boolean;
  supportsQuality: boolean;
  /** ONE file for the whole project rather than one per artboard. See
   *  DOCUMENT_FORMATS — the export path branches on this, it is not a label. */
  document?: boolean;
};

const FORMATS: FormatInfo[] = [
  { id: 'png', name: 'PNG', description: 'Lossless, best for graphics', supportsTransparency: true, supportsQuality: false },
  { id: 'jpg', name: 'JPG', description: 'Smaller size, photos', supportsTransparency: false, supportsQuality: true },
  { id: 'webp', name: 'WebP', description: 'Modern, best compression', supportsTransparency: true, supportsQuality: true },
  {
    id: 'pptx',
    name: 'PowerPoint',
    // Deliberately does not promise editable text. Whether the text survives as
    // text depends on what the slide is made of, so the honest version of that
    // claim cannot be a constant — see `pptxTextNote`.
    description: 'Every page a slide',
    supportsTransparency: false,
    supportsQuality: false,
    document: true,
  },
  {
    id: 'pdf',
    name: 'PDF',
    description: 'Every page a page, exactly as designed',
    supportsTransparency: false,
    supportsQuality: false,
    document: true,
  },
];

const QUALITY_PRESETS: { id: ExportQuality; name: string; value: number }[] = [
  { id: 'low', name: 'Low', value: 60 },
  { id: 'medium', name: 'Medium', value: 80 },
  { id: 'high', name: 'High', value: 92 },
  { id: 'max', name: 'Maximum', value: 100 },
];

const SCALE_OPTIONS = [
  { value: 0.5, label: '0.5x' },
  { value: 1, label: '1x' },
  { value: 2, label: '2x' },
  { value: 3, label: '3x' },
  { value: 4, label: '4x' },
];

const DPI_OPTIONS = [
  { value: 72, label: '72 DPI', description: 'Screen' },
  { value: 150, label: '150 DPI', description: 'Web print' },
  { value: 300, label: '300 DPI', description: 'Print' },
  { value: 600, label: '600 DPI', description: 'High quality' },
];

type PlatformPreset = {
  id: string;
  name: string;
  format: ExportFormat;
  quality: ExportQuality;
  maxFileSize?: string;
  recommendedSize?: { width: number; height: number };
  description: string;
};

const PLATFORM_PRESETS: PlatformPreset[] = [
  {
    id: 'instagram-post',
    name: 'Instagram Post',
    format: 'jpg',
    quality: 'high',
    recommendedSize: { width: 1080, height: 1080 },
    description: 'Square post, max 30MB',
  },
  {
    id: 'instagram-story',
    name: 'Instagram Story',
    format: 'jpg',
    quality: 'high',
    recommendedSize: { width: 1080, height: 1920 },
    description: '9:16 vertical',
  },
  {
    id: 'youtube-thumbnail',
    name: 'YouTube Thumbnail',
    format: 'jpg',
    quality: 'high',
    maxFileSize: '2MB',
    recommendedSize: { width: 1280, height: 720 },
    description: '16:9, under 2MB',
  },
  {
    id: 'twitter-post',
    name: 'Twitter/X Post',
    format: 'png',
    quality: 'high',
    recommendedSize: { width: 1200, height: 675 },
    description: '16:9 landscape',
  },
  {
    id: 'facebook-post',
    name: 'Facebook Post',
    format: 'jpg',
    quality: 'high',
    recommendedSize: { width: 1200, height: 630 },
    description: '1.91:1 ratio',
  },
  {
    id: 'linkedin-post',
    name: 'LinkedIn Post',
    format: 'png',
    quality: 'high',
    recommendedSize: { width: 1200, height: 627 },
    description: 'Professional feed',
  },
  {
    id: 'web-optimized',
    name: 'Web Optimized',
    format: 'webp',
    quality: 'medium',
    description: 'Smallest file size',
  },
  {
    id: 'print-ready',
    name: 'Print Ready',
    format: 'png',
    quality: 'max',
    description: 'Highest quality PNG',
  },
];

type SizeMode = 'scale' | 'custom' | 'dpi';

/**
 * Where the exported image goes. The three things a person can actually mean,
 * named as verbs so the button can simply say them.
 *  - `replace`  the image this editor was opened on, at the same url
 *  - `library`  a new image in the user's Voidspace Library
 *  - `download` a file on this computer
 */
type Destination = 'replace' | 'library' | 'download';

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const { project, selectedArtboardId } = useProjectStore();
  const { showNotification, editSource } = useUIStore();

  // Computed from the document, because whether PowerPoint text survives as
  // text depends entirely on what the slides are made of.
  const pptxNote = useMemo(() => pptxTextNote(project), [project]);

  const [format, setFormat] = useState<ExportFormat>('png');
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [scale, setScale] = useState(1);
  const [sizeMode, setSizeMode] = useState<SizeMode>('scale');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [customWidth, setCustomWidth] = useState(0);
  const [customHeight, setCustomHeight] = useState(0);
  const [dpi, setDpi] = useState(72);
  const [lockAspectRatio, setLockAspectRatio] = useState(true);
  const [background, setBackground] = useState<'include' | 'transparent'>('include');
  const [exportAll, setExportAll] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [saveName, setSaveName] = useState('');
  const [hasSavedOnce, setHasSavedOnce] = useState(false);

  /**
   * ── ONE QUESTION: WHERE IS THIS GOING? ──────────────────────────────────
   *
   * This dialog used to ask it three times and never quite answer it. There
   * was an "On save: New copy / Overwrite" toggle, a "Save to Voidspace"
   * button and an "Export" button — and the toggle silently applied to only
   * one of the buttons, while "Overwrite" meant "replace the Library entry",
   * not "replace the image I opened", which is what the word plainly says to
   * someone who arrived here from an Edit button.
   *
   * So it is one choice now, and the button says what that choice does.
   */
  const [destination, setDestination] = useState<Destination>('library');

  // Opened to edit an image we can replace in place → that is what the user
  // came to do, so it is the default. The format follows the SOURCE's, because
  // a replacement keeps the original's url and extension and bytes in another
  // format would serve as a broken image at an address nothing can correct.
  useEffect(() => {
    if (!editSource) return;
    setDestination('replace');
    const srcFmt: ExportFormat = editSource.ext === 'jpg' || editSource.ext === 'jpeg'
      ? 'jpg' : editSource.ext === 'webp' ? 'webp' : 'png';
    setFormat(srcFmt);
  }, [editSource]);

  const currentFormat = FORMATS.find((f) => f.id === format)!;
  const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);

  /**
   * What this image is called, unless the user says otherwise.
   *
   * The page suffix belongs to a document, not to an image: a single-page
   * project showed "image — Page 1", where `image` was the handoff label and
   * `Page 1` was the only page there is. Neither half told anyone anything.
   */
  const defaultName = (project && artboard)
    ? (project.artboards.length > 1 ? `${project.name} — ${artboard.name}` : project.name)
    : 'Image';

  const effectiveScale = useMemo(() => {
    if (!artboard) return 1;
    if (sizeMode === 'scale') return scale;
    if (sizeMode === 'custom' && customWidth > 0) {
      return customWidth / artboard.size.width;
    }
    if (sizeMode === 'dpi') {
      return dpi / 72;
    }
    return 1;
  }, [artboard, sizeMode, scale, customWidth, dpi]);

  const dimensions = useMemo(() => {
    if (!artboard) return null;
    if (sizeMode === 'custom') {
      return { width: customWidth || artboard.size.width, height: customHeight || artboard.size.height };
    }
    return {
      width: Math.round(artboard.size.width * effectiveScale),
      height: Math.round(artboard.size.height * effectiveScale),
    };
  }, [artboard, sizeMode, effectiveScale, customWidth, customHeight]);

  useEffect(() => {
    if (artboard) {
      setCustomWidth(artboard.size.width);
      setCustomHeight(artboard.size.height);
    }
  }, [artboard?.id]);

  const handleCustomWidthChange = (newWidth: number) => {
    setCustomWidth(newWidth);
    if (lockAspectRatio && artboard && newWidth > 0) {
      const aspectRatio = artboard.size.width / artboard.size.height;
      setCustomHeight(Math.round(newWidth / aspectRatio));
    }
  };

  const handleCustomHeightChange = (newHeight: number) => {
    setCustomHeight(newHeight);
    if (lockAspectRatio && artboard && newHeight > 0) {
      const aspectRatio = artboard.size.width / artboard.size.height;
      setCustomWidth(Math.round(newHeight * aspectRatio));
    }
  };

  const handlePresetSelect = (preset: PlatformPreset) => {
    setSelectedPreset(preset.id);
    setFormat(preset.format);
    setQuality(preset.quality);

    if (preset.recommendedSize && artboard) {
      const artboardRatio = artboard.size.width / artboard.size.height;
      const presetRatio = preset.recommendedSize.width / preset.recommendedSize.height;
      const ratioMatch = Math.abs(artboardRatio - presetRatio) < 0.1;

      if (ratioMatch) {
        const targetScale = preset.recommendedSize.width / artboard.size.width;
        if (targetScale <= 4 && targetScale >= 0.5) {
          setScale(targetScale);
          setSizeMode('scale');
        } else {
          setSizeMode('custom');
          setCustomWidth(preset.recommendedSize.width);
          setCustomHeight(preset.recommendedSize.height);
          setLockAspectRatio(false);
        }
      }
    }
  };

  const clearPreset = () => {
    setSelectedPreset(null);
  };

  const printDimensions = useMemo(() => {
    if (!dimensions) return null;
    const inches = {
      width: (dimensions.width / dpi).toFixed(2),
      height: (dimensions.height / dpi).toFixed(2),
    };
    const cm = {
      width: ((dimensions.width / dpi) * 2.54).toFixed(2),
      height: ((dimensions.height / dpi) * 2.54).toFixed(2),
    };
    return { inches, cm };
  }, [dimensions, dpi]);

  const estimatedSize = useMemo(() => {
    if (!dimensions) return null;
    const pixels = dimensions.width * dimensions.height;
    const bytesPerPixel = format === 'png' ? 3 : format === 'jpg' ? 0.5 : 0.4;
    const qualityMultiplier = QUALITY_PRESETS.find((q) => q.id === quality)?.value ?? 80;
    const estimated = pixels * bytesPerPixel * (qualityMultiplier / 100);

    if (estimated > 1024 * 1024) {
      return `~${(estimated / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `~${Math.round(estimated / 1024)} KB`;
  }, [dimensions, format, quality]);

  const handleExport = async () => {
    if (!project) return;

    setIsExporting(true);
    setProgress(0);

    try {
      /**
       * ── A DOCUMENT IS ONE FILE, NOT N FILES ────────────────────────────────
       *
       * The raster path below renders each artboard and downloads one file per
       * page, which is right for images and nonsense for a deck: ten separate
       * .pptx files is not a presentation. So these formats take their own
       * path, and "export all" stops being a choice — a one-slide deck made
       * from a ten-page project is not something anyone means to ask for.
       *
       * Loaded on demand. pptxgenjs and pdf-lib are ~400KB together and are
       * needed by neither the editor nor a PNG export, so they must not sit in
       * the bundle everyone downloads to open a canvas.
       */
      if (currentFormat.document) {
        const { exportProjectToPptx, exportProjectToPdf, exportFileName } = await import('../../services/pptx-export');
        const onProgress = (p: number, msg: string) => { setProgress(p); setProgressMessage(msg); };
        // One sanitiser, shared with the agent's export — see exportFileName.

        if (format === 'pptx') {
          const { blob, dropped } = await exportProjectToPptx(project, {
            scale: effectiveScale, onProgress,
          });
          downloadBlob(blob, exportFileName(project.name, 'pptx'));
          // Told, not hidden. A layer missing from slide six is something the
          // user needs to know BEFORE they present it, and the export otherwise
          // reports unqualified success.
          if (dropped.length) {
            showNotification(
              'error',
              `Exported, but ${dropped.length} layer${dropped.length > 1 ? 's' : ''} could not be included: ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '…' : ''}`,
            );
          } else {
            showNotification('success', `Exported ${project.artboards.length} slides to PowerPoint`);
          }
        } else {
          const blob = await exportProjectToPdf(project, { scale: effectiveScale, onProgress });
          downloadBlob(blob, exportFileName(project.name, 'pdf'));
          showNotification('success', `Exported ${project.artboards.length} pages to PDF`);
        }
        onClose();
        return;
      }

      const options: ExportOptions = {
        format,
        quality,
        scale: effectiveScale,
        background: currentFormat.supportsTransparency ? background : 'include',
        artboardIds: exportAll ? undefined : selectedArtboardId ? [selectedArtboardId] : undefined,
      };

      const blobs = await exportProject(project, options, (p, msg) => {
        setProgress(p);
        setProgressMessage(msg);
      });

      const artboards = exportAll
        ? project.artboards
        : project.artboards.filter((a) => a.id === selectedArtboardId);

      blobs.forEach((blob, index) => {
        const artboardName = artboards[index]?.name ?? `artboard-${index + 1}`;
        // One name field, both destinations. It used to feed the Library save
        // only, so a user who typed a name and pressed Export got a file called
        // something else entirely.
        const named = blobs.length === 1 && saveName.trim();
        const filename = named
          ? `${saveName.trim().replace(/[^\w\s.-]+/g, '').slice(0, 80) || 'image'}.${format}`
          : getExportFilename(project.name, artboardName, format);
        downloadBlob(blob, filename);
      });

      showNotification('success', `Exported ${blobs.length} artboard${blobs.length > 1 ? 's' : ''}`);
      onClose();
    } catch (error) {
      showNotification('error', 'Export failed. Please try again.');
    } finally {
      setIsExporting(false);
      setProgress(0);
    }
  };

  // Save the current artboard into the shared Voidspace Library (same storage
  // as video generations) so it's reusable across flows. Single-artboard only.
  const handleSaveToVoidspace = async () => {
    if (!project || !artboard) return;
    setIsSaving(true);
    try {
      // "Replace original" = overwrite the exact file we opened, encoded in ITS
      // format so the in-place bytes stay valid for its extension.
      const updateOriginal = !!editSource && destination === 'replace';
      const fmt: ExportFormat = updateOriginal
        ? (editSource!.ext === 'jpg' || editSource!.ext === 'jpeg' ? 'jpg' : editSource!.ext === 'webp' ? 'webp' : 'png')
        : format;
      const supportsAlpha = fmt !== 'jpg';
      const options: ExportOptions = {
        format: fmt,
        quality,
        scale: effectiveScale,
        background: supportsAlpha ? background : 'include',
      };
      const blob = await exportArtboard(project, artboard, options);

      if (updateOriginal) {
        await overwriteEditSource(blob, editSource!);
        setHasSavedOnce(true);
        // The url did not change and every surface listening on
        // `voidspace-image-edit` re-fetches, so this is true immediately —
        // it used to say "refresh the studio to see it", which it no longer
        // needs and which made a working save look half-finished.
        showNotification('success', 'Updated everywhere this image is used');
        onClose();
        return;
      }

      // SVG/PDF fall back to PNG bytes in the exporter; store as a raster type.
      const rasterFormat = fmt === 'jpg' || fmt === 'webp' ? fmt : 'png';
      const name = (saveName.trim() || defaultName).slice(0, 80);
      /**
       * A RE-SAVE UPDATES THE IMAGE IT SAVED, RATHER THAN STACKING ANOTHER.
       *
       * This used to be the "On save" toggle's job, which made the user answer
       * a question they could not have an opinion about until after the first
       * save. The stable filename is derived from the NAME, so this is exactly
       * how Save As behaves everywhere else: save again and it updates; change
       * the name and it forks. No control needed.
       */
      const saved = await saveImageToVoidspaceLibrary(blob, name, rasterFormat, { overwrite: hasSavedOnce });
      /**
       * Hand it back to whoever opened us for an edit.
       *
       * `permanentUrl`, not the auth-gated `url`: the studio puts this on the
       * card's variation list, which persists to Firestore and is read by the
       * phone — a token-scoped link would render here and nowhere else.
       *
       * No-op unless the caller asked for the round trip, so an ordinary Save
       * to Library behaves exactly as it did.
       */
      announceEditedImage(saved.permanentUrl || saved.url);
      setHasSavedOnce(true);
      showNotification('success', hasSavedOnce ? 'Updated in your Voidspace Library' : 'Saved to your Voidspace Library');
      onClose();
    } catch (error) {
      if (error instanceof NotSignedInError) {
        showNotification('error', 'Sign in on Voidspace to save to your Library');
      } else {
        showNotification('error', 'Could not save to Voidspace. Please try again.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (!project || !artboard) return null;

  /** Only offered when there is something to replace — see `parseEditSource`. */
  const canReplace = !!editSource;

  /**
   * Some choices are not the user's to make.
   *
   * A PowerPoint or a PDF is the whole document and several pages at once, and
   * "export all artboards" is several files — neither is one image, so neither
   * can land in the Library or replace anything. Rather than let the user pick
   * a destination that would then be ignored, the choice collapses to Download
   * and the dialog SAYS why.
   */
  const downloadOnly = !!currentFormat.document || exportAll;
  const dest: Destination = downloadOnly
    ? 'download'
    : (destination === 'replace' && !canReplace ? 'library' : destination);

  const DESTINATIONS: { id: Destination; label: string; hint: string }[] = [
    ...(canReplace ? [{
      id: 'replace' as const,
      label: 'Replace original',
      hint: 'Updates this image everywhere it is used — same link, no copies.',
    }] : []),
    {
      id: 'library',
      label: hasSavedOnce ? 'Update saved image' : 'Save to Voidspace',
      hint: hasSavedOnce
        ? 'Updates the image you saved. Change the name to save a separate one.'
        : 'Adds a new image to your Library, reusable in video and other flows.',
    },
    { id: 'download', label: 'Download', hint: 'Saves a file to this computer.' },
  ];
  const destHint = DESTINATIONS.find((d) => d.id === dest)?.hint ?? '';

  const busy = isExporting || isSaving;
  const primaryLabel = dest === 'replace' ? 'Replace original'
    : dest === 'library' ? (hasSavedOnce ? 'Update saved image' : 'Save to Voidspace')
    : 'Download';

  /** Scale, custom and print collapse into ONE dropdown — they were a row of
   *  mode buttons above a row of scale buttons, two decisions deep for a thing
   *  almost everyone leaves at 1x. */
  const sizeKey = sizeMode === 'custom' ? 'custom' : sizeMode === 'dpi' ? 'print' : `x${scale}`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={canReplace ? 'Save image' : 'Export image'}
      description={canReplace
        ? 'Replace the image you opened, or keep it and save a new one.'
        : 'Choose where it goes, then how it is written.'}
      maxWidth="md"
    >
      <div className="space-y-4">
        {/*
          WHERE IT GOES, FIRST — because it decides what everything below means.
          A format and a size are settings; the destination is the decision, and
          it used to be spread across a toggle and two competing buttons.
        */}
        {!downloadOnly ? (
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">Where</label>
            <div className="flex rounded-lg border border-input overflow-hidden text-xs">
              {DESTINATIONS.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setDestination(d.id)}
                  className={`flex-1 px-3 py-2 font-medium transition-colors ${
                    dest === d.id
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{destHint}</p>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {currentFormat.document
              ? `A ${currentFormat.name} file is the whole document — it downloads to this computer.`
              : `Every page exports as its own file — ${project.artboards.length} downloads.`}
          </p>
        )}

        {/*
          A NAME, only where a name is a real thing. Replacing the original
          keeps its url and its filename, so a name field there is a control
          that cannot do anything — and the placeholder it used to show
          ("image — Page 1", the handoff label plus a page number) was nobody's
          idea of what the picture is called.
        */}
        {dest !== 'replace' && (
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">Name</label>
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder={defaultName}
              className="w-full px-2.5 py-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">Preset</label>
            <select
              value={selectedPreset ?? ''}
              onChange={(e) => {
                const preset = PLATFORM_PRESETS.find((x) => x.id === e.target.value);
                if (preset) handlePresetSelect(preset); else clearPreset();
              }}
              className="w-full px-2 py-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">No preset</option>
              {PLATFORM_PRESETS.map((pr) => (
                <option key={pr.id} value={pr.id}>{pr.name} — {pr.description}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">Format</label>
            <select
              value={format}
              onChange={(e) => { setFormat(e.target.value as ExportFormat); clearPreset(); }}
              disabled={dest === 'replace'}
              className="w-full px-2 py-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
            >
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>{f.name} — {f.description}</option>
              ))}
            </select>
          </div>
        </div>

        {/* A replacement writes to the original's url, which carries its
            extension — bytes in another format would serve as a broken image
            at an address nothing downstream can correct. So the format is not
            a choice here, and the dialog says so instead of greying a control
            with no explanation. */}
        {dest === 'replace' && (
          <p className="text-[11px] text-muted-foreground -mt-1">
            Saved as {currentFormat.name}, matching the image you opened.
          </p>
        )}

        {/* Says what will actually happen to this deck's text, rather than
            promising something that depends on how the slides were made. */}
        {format === 'pptx' && pptxNote && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{pptxNote}</p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">Size</label>
            <select
              value={sizeKey}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'custom') { setSizeMode('custom'); return; }
                if (v === 'print') { setSizeMode('dpi'); return; }
                setSizeMode('scale');
                setScale(Number(v.slice(1)));
              }}
              className="w-full px-2 py-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {SCALE_OPTIONS.map((sc) => (
                <option key={sc.value} value={`x${sc.value}`}>
                  {sc.label} — {Math.round(artboard.size.width * sc.value)} × {Math.round(artboard.size.height * sc.value)}
                </option>
              ))}
              <option value="custom">Custom size…</option>
              <option value="print">Print size…</option>
            </select>
          </div>

          {currentFormat.supportsQuality && (
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">Quality</label>
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as ExportQuality)}
                className="w-full px-2 py-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {QUALITY_PRESETS.map((q) => (
                  <option key={q.id} value={q.id}>{q.name} — {q.value}%</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {sizeMode === 'custom' && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-[10px] text-muted-foreground mb-1">Width (px)</label>
              <input
                type="number"
                value={customWidth}
                onChange={(e) => handleCustomWidthChange(Number(e.target.value))}
                className="w-full px-2.5 py-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                min={1}
                max={16384}
              />
            </div>
            <button
              onClick={() => setLockAspectRatio(!lockAspectRatio)}
              className={`p-2 rounded-md transition-colors ${
                lockAspectRatio ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
              title={lockAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
            >
              {lockAspectRatio ? <Link2 size={14} /> : <Link2Off size={14} />}
            </button>
            <div className="flex-1">
              <label className="block text-[10px] text-muted-foreground mb-1">Height (px)</label>
              <input
                type="number"
                value={customHeight}
                onChange={(e) => handleCustomHeightChange(Number(e.target.value))}
                className="w-full px-2.5 py-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                min={1}
                max={16384}
              />
            </div>
          </div>
        )}

        {sizeMode === 'dpi' && (
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-[10px] text-muted-foreground mb-1">Resolution</label>
              <select
                value={dpi}
                onChange={(e) => setDpi(Number(e.target.value))}
                className="w-full px-2 py-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {DPI_OPTIONS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label} — {d.description}</option>
                ))}
              </select>
            </div>
            {printDimensions && (
              <p className="flex-1 text-[11px] text-muted-foreground pb-2">
                {printDimensions.inches.width}" × {printDimensions.inches.height}"
                <span className="block">{printDimensions.cm.width} × {printDimensions.cm.height} cm</span>
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {currentFormat.supportsTransparency && (
            <label className="flex items-center gap-2 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={background === 'transparent'}
                onChange={(e) => setBackground(e.target.checked ? 'transparent' : 'include')}
                className="w-3.5 h-3.5 rounded border-border bg-background text-primary focus:ring-primary/50"
              />
              <span>Transparent background</span>
            </label>
          )}

          {/*
            A DOCUMENT IS ALWAYS EVERY PAGE, so it must not offer the choice.
            The checkbox used to stay visible for PowerPoint and PDF, where the
            export path writes all pages regardless — a control that reads as a
            choice, accepts a click and changes nothing.
          */}
          {project.artboards.length > 1 && !currentFormat.document && (
            <label className="flex items-center gap-2 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={exportAll}
                onChange={(e) => setExportAll(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-border bg-background text-primary focus:ring-primary/50"
              />
              <span>All {project.artboards.length} pages</span>
            </label>
          )}
        </div>

        {dimensions && (
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/40 text-[11px] text-muted-foreground">
            <span>{dimensions.width} × {dimensions.height} px</span>
            {estimatedSize && <span>{estimatedSize}</span>}
          </div>
        )}

        {busy && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{progressMessage || 'Working…'}</span>
              <span className="font-medium">{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        <button
          onClick={onClose}
          disabled={busy}
          className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        {/*
          ONE action, matching the destination above. There were two competing
          buttons and a mode toggle that applied to only one of them, so the
          same click meant a different thing depending on a control three
          sections away — and the word "Overwrite" meant the Library entry, not
          the image the user had opened.
        */}
        <button
          onClick={dest === 'download' ? handleExport : handleSaveToVoidspace}
          disabled={busy}
          title={destHint}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {isSaving ? 'Saving…' : 'Exporting…'}
            </>
          ) : (
            <>
              {dest === 'download' ? <Download size={16} /> : <CloudUpload size={16} />}
              {primaryLabel}
            </>
          )}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
