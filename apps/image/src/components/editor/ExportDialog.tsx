import { useState, useMemo, useEffect } from 'react';
import { Download, FileImage, Loader2, Link2, Link2Off, Printer, Instagram, Youtube, Twitter, Linkedin, Facebook, Image, CloudUpload } from 'lucide-react';
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
import { saveImageToVoidspaceLibrary, overwriteLocalAsset, NotSignedInError } from '../../services/voidspace-storage';
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
  icon: React.ElementType;
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
    icon: Instagram,
    format: 'jpg',
    quality: 'high',
    recommendedSize: { width: 1080, height: 1080 },
    description: 'Square post, max 30MB',
  },
  {
    id: 'instagram-story',
    name: 'Instagram Story',
    icon: Instagram,
    format: 'jpg',
    quality: 'high',
    recommendedSize: { width: 1080, height: 1920 },
    description: '9:16 vertical',
  },
  {
    id: 'youtube-thumbnail',
    name: 'YouTube Thumbnail',
    icon: Youtube,
    format: 'jpg',
    quality: 'high',
    maxFileSize: '2MB',
    recommendedSize: { width: 1280, height: 720 },
    description: '16:9, under 2MB',
  },
  {
    id: 'twitter-post',
    name: 'Twitter/X Post',
    icon: Twitter,
    format: 'png',
    quality: 'high',
    recommendedSize: { width: 1200, height: 675 },
    description: '16:9 landscape',
  },
  {
    id: 'facebook-post',
    name: 'Facebook Post',
    icon: Facebook,
    format: 'jpg',
    quality: 'high',
    recommendedSize: { width: 1200, height: 630 },
    description: '1.91:1 ratio',
  },
  {
    id: 'linkedin-post',
    name: 'LinkedIn Post',
    icon: Linkedin,
    format: 'png',
    quality: 'high',
    recommendedSize: { width: 1200, height: 627 },
    description: 'Professional feed',
  },
  {
    id: 'web-optimized',
    name: 'Web Optimized',
    icon: Image,
    format: 'webp',
    quality: 'medium',
    description: 'Smallest file size',
  },
  {
    id: 'print-ready',
    name: 'Print Ready',
    icon: Printer,
    format: 'png',
    quality: 'max',
    description: 'Highest quality PNG',
  },
];

type SizeMode = 'scale' | 'custom' | 'dpi';

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
  // Whether a re-save overwrites the same Library entry or adds a new copy.
  const [saveMode, setSaveMode] = useState<'copy' | 'overwrite'>('copy');
  const [hasSavedOnce, setHasSavedOnce] = useState(false);

  // Opened to edit a studio image we can overwrite in place → default to
  // updating the original (the user's intent), not spawning a Library copy,
  // and match the picker to the source's format so it's not misleading (the
  // file extension is fixed, so an overwrite always writes that format).
  useEffect(() => {
    if (!editSource) return;
    setSaveMode('overwrite');
    const srcFmt: ExportFormat = editSource.ext === 'jpg' || editSource.ext === 'jpeg'
      ? 'jpg' : editSource.ext === 'webp' ? 'webp' : 'png';
    setFormat(srcFmt);
  }, [editSource]);

  const currentFormat = FORMATS.find((f) => f.id === format)!;
  const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);

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
        const { exportProjectToPptx, exportProjectToPdf } = await import('../../services/pptx-export');
        const onProgress = (p: number, msg: string) => { setProgress(p); setProgressMessage(msg); };
        const safeName = (project.name || 'presentation').replace(/[^\w\s-]/g, '').trim() || 'presentation';

        if (format === 'pptx') {
          const { blob, dropped } = await exportProjectToPptx(project, {
            scale: effectiveScale, onProgress,
          });
          downloadBlob(blob, `${safeName}.pptx`);
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
          downloadBlob(blob, `${safeName}.pdf`);
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
        const filename = getExportFilename(project.name, artboardName, format);
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
      // "Update original" = overwrite the exact studio file we opened, encoded
      // in ITS format so the in-place bytes stay valid for its extension.
      const updateOriginal = !!editSource && saveMode === 'overwrite';
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
        await overwriteLocalAsset(blob, editSource!);
        setHasSavedOnce(true);
        showNotification('success', 'Updated the original — refresh the studio to see it');
        onClose();
        return;
      }

      // SVG/PDF fall back to PNG bytes in the exporter; store as a raster type.
      const rasterFormat = fmt === 'jpg' || fmt === 'webp' ? fmt : 'png';
      const name = (saveName.trim() || `${project.name} — ${artboard.name}`).slice(0, 80);
      const saved = await saveImageToVoidspaceLibrary(blob, name, rasterFormat, { overwrite: saveMode === 'overwrite' });
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
      showNotification('success', saveMode === 'overwrite' ? 'Updated in your Voidspace Library' : 'Saved to your Voidspace Library');
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export Image"
      description="Choose format and quality settings"
      maxWidth="md"
    >
      <div className="space-y-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Quick Presets
            </label>
            {selectedPreset && (
              <button
                onClick={clearPreset}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {PLATFORM_PRESETS.map((preset) => {
              const Icon = preset.icon;
              const isSelected = selectedPreset === preset.id;
              return (
                <button
                  key={preset.id}
                  onClick={() => handlePresetSelect(preset)}
                  className={`p-2 rounded-lg border text-center transition-all ${
                    isSelected
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
                  }`}
                >
                  <Icon size={16} className={`mx-auto mb-1 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className="block text-[10px] font-medium truncate">{preset.name}</span>
                  <span className="block text-[8px] text-muted-foreground truncate">{preset.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            Format
          </label>
          <div className="grid grid-cols-3 gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                className={`p-3 rounded-lg border text-left transition-all ${
                  format === f.id
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <FileImage size={16} className={format === f.id ? 'text-primary' : 'text-muted-foreground'} />
                  <span className="font-medium text-sm">{f.name}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{f.description}</p>
              </button>
            ))}
          </div>

          {/* Says what will actually happen to this deck's text, rather than
              promising something that depends on how the slides were made. */}
          {format === 'pptx' && pptxNote && (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {pptxNote}
            </p>
          )}
        </div>

        {currentFormat.supportsQuality && (
          <div>
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              Quality
            </label>
            <div className="grid grid-cols-4 gap-2">
              {QUALITY_PRESETS.map((q) => (
                <button
                  key={q.id}
                  onClick={() => setQuality(q.id)}
                  className={`px-3 py-2 rounded-lg border text-center transition-all ${
                    quality === q.id
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
                  }`}
                >
                  <span className="text-sm font-medium">{q.name}</span>
                  <span className="block text-[10px] text-muted-foreground">{q.value}%</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            Size
          </label>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setSizeMode('scale')}
              className={`flex-1 px-3 py-2 rounded-lg border text-center text-sm font-medium transition-all ${
                sizeMode === 'scale'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
              }`}
            >
              Scale
            </button>
            <button
              onClick={() => setSizeMode('custom')}
              className={`flex-1 px-3 py-2 rounded-lg border text-center text-sm font-medium transition-all ${
                sizeMode === 'custom'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
              }`}
            >
              Custom
            </button>
            <button
              onClick={() => setSizeMode('dpi')}
              className={`flex-1 px-3 py-2 rounded-lg border text-center text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
                sizeMode === 'dpi'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
              }`}
            >
              <Printer size={14} />
              Print
            </button>
          </div>

          {sizeMode === 'scale' && (
            <div className="flex gap-2">
              {SCALE_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setScale(s.value)}
                  className={`flex-1 px-3 py-2 rounded-lg border text-center text-sm font-medium transition-all ${
                    scale === s.value
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {sizeMode === 'custom' && (
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="block text-[10px] text-muted-foreground mb-1">Width (px)</label>
                <input
                  type="number"
                  value={customWidth}
                  onChange={(e) => handleCustomWidthChange(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                  min={1}
                  max={16384}
                />
              </div>
              <button
                onClick={() => setLockAspectRatio(!lockAspectRatio)}
                className={`mt-5 p-2 rounded-lg transition-colors ${
                  lockAspectRatio ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}
                title={lockAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
              >
                {lockAspectRatio ? <Link2 size={16} /> : <Link2Off size={16} />}
              </button>
              <div className="flex-1">
                <label className="block text-[10px] text-muted-foreground mb-1">Height (px)</label>
                <input
                  type="number"
                  value={customHeight}
                  onChange={(e) => handleCustomHeightChange(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                  min={1}
                  max={16384}
                />
              </div>
            </div>
          )}

          {sizeMode === 'dpi' && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2">
                {DPI_OPTIONS.map((d) => (
                  <button
                    key={d.value}
                    onClick={() => setDpi(d.value)}
                    className={`px-2 py-2 rounded-lg border text-center transition-all ${
                      dpi === d.value
                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                        : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
                    }`}
                  >
                    <span className="block text-sm font-medium">{d.value}</span>
                    <span className="block text-[9px] text-muted-foreground">{d.description}</span>
                  </button>
                ))}
              </div>
              {printDimensions && (
                <div className="p-3 bg-secondary/30 rounded-lg text-xs text-muted-foreground">
                  <p>Print size at {dpi} DPI:</p>
                  <p className="font-medium text-foreground mt-1">
                    {printDimensions.inches.width}" × {printDimensions.inches.height}" ({printDimensions.cm.width} × {printDimensions.cm.height} cm)
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {currentFormat.supportsTransparency && (
          <div>
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              Background
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setBackground('include')}
                className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                  background === 'include'
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
                }`}
              >
                Include Background
              </button>
              <button
                onClick={() => setBackground('transparent')}
                className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                  background === 'transparent'
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
                }`}
              >
                Transparent
              </button>
            </div>
          </div>
        )}

        {/*
          A DOCUMENT IS ALWAYS EVERY PAGE, so it must not offer the choice.

          The checkbox stayed visible for PowerPoint and PDF, where the export
          path ignores it and writes all pages regardless — a control that reads
          as a choice, accepts a click, and changes nothing. Found in an
          end-to-end run: unticking it still produced a five-slide deck.

          Replaced with a statement of what will happen, which is the honest
          version of the same line.
        */}
        {project.artboards.length > 1 && (currentFormat.document ? (
          <p className="text-sm text-muted-foreground">
            All {project.artboards.length} pages are included — a {currentFormat.name} file is the
            whole document.
          </p>
        ) : (
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={exportAll}
                onChange={(e) => setExportAll(e.target.checked)}
                className="w-4 h-4 rounded border-border bg-background text-primary focus:ring-primary/50"
              />
              <span className="text-sm">Export all artboards ({project.artboards.length})</span>
            </label>
          </div>
        ))}

        <div className="p-4 bg-secondary/50 rounded-lg space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Dimensions</span>
            <span className="font-medium">
              {dimensions?.width} × {dimensions?.height} px
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Estimated size</span>
            <span className="font-medium">{estimatedSize}</span>
          </div>
        </div>

        {isExporting && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{progressMessage}</span>
              <span className="font-medium">{Math.round(progress)}%</span>
            </div>
            <div className="h-2 bg-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Save-to-Library controls: name it, and choose new copy vs overwrite. */}
      <div className="px-1 pt-2 pb-1 space-y-2 border-t border-border">
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-muted-foreground w-14 shrink-0">Save name</label>
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={artboard ? `${project.name} — ${artboard.name}` : 'Image name'}
            className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground w-14 shrink-0">On save</span>
          <div className="inline-flex rounded-md border border-input overflow-hidden text-[11px]">
            <button
              onClick={() => setSaveMode('copy')}
              className={`px-2.5 py-1 transition-colors ${saveMode === 'copy' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent'}`}
            >
              New copy
            </button>
            <button
              onClick={() => setSaveMode('overwrite')}
              className={`px-2.5 py-1 transition-colors ${saveMode === 'overwrite' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent'}`}
            >
              {editSource ? 'Update original' : 'Overwrite'}
            </button>
          </div>
          {editSource && saveMode === 'overwrite' && (
            <span className="text-[10px] text-muted-foreground">replaces the studio image — shows on refresh</span>
          )}
          {editSource && saveMode === 'copy' && (
            <span className="text-[10px] text-muted-foreground">new Library image — swap it in from the studio</span>
          )}
          {!editSource && hasSavedOnce && saveMode === 'copy' && (
            <span className="text-[10px] text-muted-foreground">a new Library entry each save</span>
          )}
        </div>
      </div>

      <DialogFooter>
        <button
          onClick={onClose}
          disabled={isExporting || isSaving}
          className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSaveToVoidspace}
          disabled={isExporting || isSaving || exportAll}
          title="Save this artboard to your Voidspace Library (reusable in video and other flows)"
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-foreground text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
        >
          {isSaving ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <CloudUpload size={16} />
              Save to Voidspace
            </>
          )}
        </button>
        <button
          onClick={handleExport}
          disabled={isExporting || isSaving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {isExporting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Exporting...
            </>
          ) : (
            <>
              <Download size={16} />
              Export
            </>
          )}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
