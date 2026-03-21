/**
 * VoidspaceTemplateGallery — Browse and select Voidspace video generation templates.
 *
 * Video generation flow:
 * 1. User selects template → fills in fields → clicks Generate
 * 2. Component sends postMessage to parent (Nuxt page) with structured payload
 * 3. Parent calls the backend AI agent endpoint with the parameters
 * 4. Video generation is async (3-5 min) — user gets feedback
 */
import { useState, useMemo, useCallback, useEffect } from "react";
import {
  Search,
  BookOpen,
  Video,
  Eye,
  GraduationCap,
  MessageSquareHeart,
  Music,
  ShoppingBag,
  LayoutGrid,
  MessageCircle,
  Sparkles,
  TrendingUp,
  ChevronRight,
  Clock,
  ArrowLeft,
  Code2,
  ChevronDown,
  ChevronUp,
  Wand2,
  PenLine,
  Plus,
  Loader2,
  Copy,
  Check,
  Mic,
  MessageSquare,
  Music2,
} from "lucide-react";
import { Input, Button } from "@openreel/ui";
import {
  VOIDSPACE_TEMPLATES,
  TEMPLATE_CATEGORIES,
  CREATE_FROM_SCRATCH_TEMPLATE,
  type VoidspaceVideoTemplate,
  type TemplateCategory,
  type TemplateField,
} from "../../data/voidspace-video-templates";

// ── Icon map ──────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  BookOpen,
  Video,
  Eye,
  GraduationCap,
  MessageSquareHeart,
  Music,
  ShoppingBag,
  LayoutGrid,
  MessageCircle,
  Sparkles,
  TrendingUp,
  PenLine,
};

function getIcon(name: string): React.ElementType {
  return ICON_MAP[name] || Sparkles;
}

const GRADIENT_STYLE_MAP: Record<string, string> = {
  "from-violet-600 to-purple-500": "linear-gradient(135deg, rgb(124 58 237), rgb(168 85 247))",
  "from-cyan-500 to-blue-500": "linear-gradient(135deg, rgb(6 182 212), rgb(59 130 246))",
  "from-emerald-500 to-teal-500": "linear-gradient(135deg, rgb(16 185 129), rgb(20 184 166))",
  "from-amber-500 to-orange-500": "linear-gradient(135deg, rgb(245 158 11), rgb(249 115 22))",
  "from-rose-500 to-pink-500": "linear-gradient(135deg, rgb(244 63 94), rgb(236 72 153))",
  "from-fuchsia-500 to-rose-500": "linear-gradient(135deg, rgb(217 70 239), rgb(244 63 94))",
  "from-indigo-500 to-violet-500": "linear-gradient(135deg, rgb(99 102 241), rgb(139 92 246))",
  "from-zinc-600 to-slate-700": "linear-gradient(135deg, rgb(82 82 91), rgb(51 65 85))",
};

function getGradientStyle(gradient: string): React.CSSProperties {
  return {
    backgroundImage:
      GRADIENT_STYLE_MAP[gradient] || "linear-gradient(135deg, rgb(59 130 246), rgb(168 85 247))",
  };
}

const TEMPLATE_COVER_MAP: Record<string, string> = {
  "voidspace-create-from-scratch": "/template-covers/create-from-scratch.webp",
  "voidspace-story-narration": "/template-covers/story-narration.webp",
  "voidspace-vlog": "/template-covers/vlog-talk-to-camera.webp",
  "voidspace-pov": "/template-covers/pov-experience.webp",
  "voidspace-explainer": "/template-covers/explainer.webp",
  "voidspace-testimonial": "/template-covers/testimonial.webp",
  "voidspace-music-video": "/template-covers/music-video.webp",
  "voidspace-product-showcase": "/template-covers/product-showcase.webp",
};

function getTemplateCover(templateId: string): string | null {
  return TEMPLATE_COVER_MAP[templateId] || null;
}

/** Narration label */
function NarrationLabel({ narration }: { narration: string }) {
  if (narration === "dialogue") return <><MessageSquare size={11} /><span>Dialogue</span></>;
  if (narration === "narrator") return <><Mic size={11} /><span>Narrator</span></>;
  return <><Music2 size={11} /><span>Music Only</span></>;
}

// ── Video Generation ──────────────────────────────────────

function buildGenerationPrompt(
  template: VoidspaceVideoTemplate,
  fieldValues: Record<string, string>,
): string {
  const parts: string[] = [];

  if (template.id === "voidspace-create-from-scratch") {
    const topic = fieldValues.topic || "";
    const script = fieldValues.script || "";
    const style = fieldValues.style || template.videoStyle;
    const narrationMode = fieldValues.narrationMode || template.narration;
    const mood = fieldValues.mood || "";
    const duration = fieldValues.duration || template.defaultDuration;
    const aspectRatio = fieldValues.aspectRatio || template.defaultAspectRatio;

    parts.push(`Create a ${duration}-second video about: ${topic}`);
    if (script) parts.push(`\n\nScript:\n${script}`);
    parts.push(`\n\nVideo settings:`);
    parts.push(`- Style: ${style}`);
    parts.push(`- Narration: ${narrationMode === "false" ? "no speech, music only" : narrationMode}`);
    if (mood) parts.push(`- Mood: ${mood}`);
    parts.push(`- Aspect ratio: ${aspectRatio}`);
  } else {
    const topic = fieldValues.topic || fieldValues.subject || "";
    const mood = fieldValues.mood || "";
    const scriptContent = fieldValues.script || fieldValues.talking_points || fieldValues.story_premise || "";
    const duration = fieldValues.duration || template.defaultDuration;

    parts.push(`Create a ${template.name.toLowerCase()} style video (${duration} seconds).`);
    if (topic) parts.push(`\nTopic: ${topic}`);
    if (mood) parts.push(`Mood: ${mood}`);
    if (scriptContent) parts.push(`\nContent:\n${scriptContent}`);

    for (const field of template.fields) {
      const skip = ["topic", "mood", "script", "duration", "subject", "talking_points", "story_premise"];
      if (skip.includes(field.id)) continue;
      const val = fieldValues[field.id];
      if (val?.trim()) parts.push(`${field.label}: ${val}`);
    }

    parts.push(`\n\nVideo settings:`);
    parts.push(`- Style: ${template.videoStyle}`);
    parts.push(`- Narration: ${template.narration === "false" ? "no speech, music only" : template.narration}`);
    parts.push(`- Subtitle type: ${template.subtitleType}`);
    parts.push(`- Aspect ratio: ${template.defaultAspectRatio}`);
  }

  return parts.join("\n");
}

function sendGenerationRequest(
  template: VoidspaceVideoTemplate,
  fieldValues: Record<string, string>,
  requestId: string,
) {
  const prompt = buildGenerationPrompt(template, fieldValues);

  window.parent.postMessage({
    type: "voidspace:generate-video",
    requestId,
    template: {
      id: template.id,
      name: template.name,
      videoStyle: fieldValues.style || template.videoStyle,
      narration: fieldValues.narrationMode || template.narration,
      subtitleType: template.subtitleType,
      storyStyle: template.storyStyle,
      defaultDuration: fieldValues.duration || template.defaultDuration,
      defaultAspectRatio: fieldValues.aspectRatio || template.defaultAspectRatio,
    },
    fields: fieldValues,
    prompt,
  }, "*");
}

// ── Props ─────────────────────────────────────────────────

interface VoidspaceTemplateGalleryProps {
  onTemplateSelected?: (template: VoidspaceVideoTemplate, fieldValues: Record<string, string>) => void;
}

// ── Gallery Component ─────────────────────────────────────

export const VoidspaceTemplateGallery: React.FC<VoidspaceTemplateGalleryProps> = ({ onTemplateSelected }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<TemplateCategory | "all">("all");
  const [selectedTemplate, setSelectedTemplate] = useState<VoidspaceVideoTemplate | null>(null);
  const scratchCoverSrc = getTemplateCover("voidspace-create-from-scratch");
  const [scratchCoverFailed, setScratchCoverFailed] = useState(false);
  const hasScratchCover = !!scratchCoverSrc && !scratchCoverFailed;

  const filteredTemplates = useMemo(() => {
    let result = VOIDSPACE_TEMPLATES;

    if (selectedCategory !== "all") {
      result = result.filter((t) => t.category === selectedCategory);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.description.toLowerCase().includes(query) ||
          t.tags.some((tag) => tag.toLowerCase().includes(query)),
      );
    }

    return result;
  }, [selectedCategory, searchQuery]);

  const handleBack = useCallback(() => {
    setSelectedTemplate(null);
  }, []);

  // ── Detail View ──
  if (selectedTemplate) {
    return (
      <VoidspaceTemplateDetail
        template={selectedTemplate}
        onBack={handleBack}
        onGenerate={onTemplateSelected}
      />
    );
  }

  // ── Gallery Grid View ──
  const showScratchCard = !searchQuery.trim() ||
    "create scratch custom blank freeform".includes(searchQuery.toLowerCase());

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-2xl font-bold text-text-primary mb-2">
          Create New Video
        </h2>
        <p className="text-base text-text-muted">
          Choose a template or start from scratch.
        </p>
      </div>

      {/* Search */}
      <div className="max-w-lg mx-auto">
        <div className="relative">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted z-10"
          />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search templates..."
            className="pl-11 py-2.5 bg-background-secondary border-border rounded-xl text-text-primary"
          />
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex items-center justify-center gap-2 flex-wrap">
        {TEMPLATE_CATEGORIES.map((cat) => {
          const CatIcon = getIcon(cat.icon);
          const isActive = selectedCategory === cat.id;
          const count =
            cat.id === "all"
              ? VOIDSPACE_TEMPLATES.length
              : VOIDSPACE_TEMPLATES.filter((t) => t.category === cat.id).length;

          return (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200
                ${
                  isActive
                    ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                    : "bg-background-secondary text-text-muted hover:bg-background-tertiary hover:text-text-secondary border border-transparent hover:border-border"
                }
              `}
            >
              <CatIcon size={14} />
              {cat.label}
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full ${
                  isActive
                    ? "bg-white/20 text-primary-foreground"
                    : "bg-background-tertiary text-text-muted"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Template Grid */}
      {filteredTemplates.length === 0 && !showScratchCard ? (
        <div className="flex flex-col items-center justify-center py-20">
          <Search size={32} className="text-text-muted/30 mb-4" />
          <p className="text-base font-medium text-text-primary mb-1">
            No templates found
          </p>
          <p className="text-sm text-text-muted">
            Try a different search term
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {/* Create from Scratch — always first */}
          {showScratchCard && (
            <button
              onClick={() => setSelectedTemplate(CREATE_FROM_SCRATCH_TEMPLATE)}
              className="group relative flex flex-col rounded-2xl overflow-hidden
                bg-background-secondary border-2 border-dashed border-primary/20
                hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5
                transition-all duration-300 text-left"
            >
              <div className="relative h-36 w-full flex items-center justify-center bg-gradient-to-br from-primary/5 via-background-secondary to-background-tertiary">
                {hasScratchCover && (
                  <img
                    src={scratchCoverSrc}
                    alt="Create from scratch cover"
                    className="absolute inset-0 h-full w-full object-cover"
                    onError={() => setScratchCoverFailed(true)}
                    loading="lazy"
                    decoding="async"
                  />
                )}
                <div className="absolute inset-0 bg-black/15" />
                <div className="relative z-[1] w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center
                  group-hover:bg-primary/20 group-hover:scale-110 transition-all duration-300">
                  <Plus
                    size={30}
                    className="text-primary/60 group-hover:text-primary transition-colors"
                  />
                </div>
              </div>
              <div className="p-5 flex-1 flex flex-col">
                <h3 className="text-[15px] font-semibold text-text-primary mb-1.5 group-hover:text-primary transition-colors">
                  Create from Scratch
                </h3>
                <p className="text-[13px] text-text-muted leading-relaxed mb-4 flex-1">
                  Full creative control. Write your script, choose style &amp; format.
                </p>
                <div className="flex items-center gap-2 text-xs text-text-muted/70">
                  <PenLine size={12} />
                  <span>Custom</span>
                  <span className="w-px h-3 bg-border" />
                  <span>All formats</span>
                </div>
              </div>
            </button>
          )}

          {filteredTemplates.map((template) => (
            <VoidspaceTemplateCard
              key={template.id}
              template={template}
              onClick={() => setSelectedTemplate(template)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ── Template Card ─────────────────────────────────────────

const VoidspaceTemplateCard: React.FC<{
  template: VoidspaceVideoTemplate;
  onClick: () => void;
}> = ({ template, onClick }) => {
  const Icon = getIcon(template.icon);
  const coverSrc = getTemplateCover(template.id);
  const [coverFailed, setCoverFailed] = useState(false);
  const hasCover = !!coverSrc && !coverFailed;

  return (
    <button
      onClick={onClick}
      className="group relative flex w-full min-w-0 flex-col rounded-2xl
        bg-background-secondary border border-border/60
        hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5
        transition-all duration-300 text-left overflow-hidden"
    >
      {/* Gradient header */}
      <div
        className="relative flex h-36 w-full items-center justify-center"
        style={!hasCover ? getGradientStyle(template.gradient) : undefined}
      >
        {hasCover && (
          <img
            src={coverSrc}
            alt={`${template.name} cover`}
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setCoverFailed(true)}
            loading="lazy"
            decoding="async"
          />
        )}
        <div className="absolute inset-0 bg-black/15" />
        <div className="relative z-[1] flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-sm
          group-hover:scale-110 group-hover:bg-white/25 transition-all duration-300">
          <Icon size={30} className="text-white/90" />
        </div>

        {/* Style badge */}
        <div className="absolute top-3 right-3 z-[2] max-w-[60%] truncate px-2.5 py-1 bg-black/25 backdrop-blur-md text-white/90 text-[10px] font-semibold rounded-full uppercase tracking-wide">
          {template.storyStyle.replace(/_/g, " ")}
        </div>

        {/* Hover arrow */}
        <div className="absolute bottom-3 right-3 z-[2] w-8 h-8 rounded-full bg-white/20 backdrop-blur-sm
          flex items-center justify-center
          opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0
          transition-all duration-200">
          <ChevronRight size={16} className="text-white" />
        </div>
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col p-5">
        <h3 className="text-[15px] font-semibold text-text-primary mb-1.5 group-hover:text-primary transition-colors">
          {template.name}
        </h3>
        <p className="text-[13px] text-text-muted leading-relaxed mb-4 flex-1 line-clamp-2">
          {template.description}
        </p>

        {/* Meta row */}
        <div className="flex items-center gap-3 text-xs text-text-muted/70">
          <span className="flex items-center gap-1.5">
            <Clock size={12} />
            {template.defaultDuration}s
          </span>
          <span className="w-px h-3 bg-border" />
          <NarrationLabel narration={template.narration} />
          <span className="w-px h-3 bg-border" />
          <span>{template.defaultAspectRatio}</span>
        </div>
      </div>
    </button>
  );
};

// ── Template Detail View ──────────────────────────────────

type GenerationState = "idle" | "sending" | "processing" | "error";

const VoidspaceTemplateDetail: React.FC<{
  template: VoidspaceVideoTemplate;
  onBack: () => void;
  onGenerate?: (template: VoidspaceVideoTemplate, fieldValues: Record<string, string>) => void;
}> = ({ template, onBack, onGenerate }) => {
  const Icon = getIcon(template.icon);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    for (const field of template.fields) {
      if (field.defaultValue) defaults[field.id] = field.defaultValue;
    }
    return defaults;
  });
  const [showSampleJson, setShowSampleJson] = useState(false);
  const [activeTab, setActiveTab] = useState<"script" | "sample">("script");
  const [genState, setGenState] = useState<GenerationState>("idle");
  const [genError, setGenError] = useState<string | null>(null);
  const [genMessage, setGenMessage] = useState<string>("Video generation takes 3-5 minutes. You can edit it in the Studio afterwards.");
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);

  useEffect(() => {
    const onBridgeMessage = (event: MessageEvent) => {
      if (!event.data) return;

      if (event.data.type === "voidspace:bridge-ready") {
        setBridgeReady(true);
        return;
      }

      if (event.data.type !== "voidspace:generate-status") return;
      const statusRequestId = String(event.data.requestId || "");
      if (!statusRequestId || statusRequestId !== activeRequestId) return;

      const status = String(event.data.status || "");
      const message = String(event.data.message || "");

      if (status === "sending") {
        setGenState("sending");
        if (message) setGenMessage(message);
        return;
      }

      if (status === "processing") {
        setGenState("processing");
        setGenError(null);
        setGenMessage(message || "Video generation started! Rendering usually takes 3-5 minutes.");
        return;
      }

      if (status === "error") {
        setGenState("error");
        setGenError(message || "Generation failed. Please try again.");
      }
    };

    window.addEventListener("message", onBridgeMessage);

    // Request bridge handshake when embedded inside parent page.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "voidspace:bridge-ping" }, "*");
    }

    return () => {
      window.removeEventListener("message", onBridgeMessage);
    };
  }, [activeRequestId]);

  const updateField = useCallback((fieldId: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const requiredFieldsFilled = template.fields
    .filter((f) => f.required)
    .every((f) => fieldValues[f.id]?.trim());

  const handleGenerate = useCallback(() => {
    if (!requiredFieldsFilled || genState !== "idle") return;

    if (!bridgeReady) {
      console.warn("[VoidspaceTemplateGallery] Generate blocked: host bridge not connected. Open via /video-editor.");
      setGenError("Generate is only available through the embedded editor page. Open /video-editor and try again.");
      return;
    }

    setGenError(null);
    setGenMessage("Starting video generation request...");
    setGenState("sending");
    const requestId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setActiveRequestId(requestId);
    sendGenerationRequest(template, fieldValues, requestId);
    onGenerate?.(template, fieldValues);

    // Safety fallback: move to processing state if no host status arrives quickly.
    setTimeout(() => {
      setGenState((prev) => (prev === "sending" ? "processing" : prev));
      setGenMessage((prev) =>
        prev && prev.length > 0
          ? prev
          : "Request sent. Video is processing in the background (3-5 minutes).",
      );
    }, 1800);
  }, [requiredFieldsFilled, genState, bridgeReady, onGenerate, template, fieldValues]);

  const handleCopySampleJson = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(template.sampleOutput, null, 2));
      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 1600);
    } catch {
      setJsonCopied(false);
    }
  }, [template.sampleOutput]);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-6"
      >
        <ArrowLeft size={14} />
        Back to templates
      </button>

      {/* Header */}
      <div className="flex items-start gap-5 mb-8">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl shadow-lg"
          style={getGradientStyle(template.gradient)}
        >
          <Icon size={28} className="text-white" />
        </div>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-text-primary mb-1">
            {template.name}
          </h2>
          <p className="text-sm text-text-secondary leading-relaxed">
            {template.longDescription}
          </p>
          <div className="flex items-center gap-3 mt-3">
            <span className="px-2.5 py-1 bg-background-tertiary rounded-lg text-xs text-text-muted">
              <NarrationLabel narration={template.narration} />
            </span>
            <span className="px-2.5 py-1 bg-background-tertiary rounded-lg text-xs text-text-muted">
              {template.defaultAspectRatio}
            </span>
            <span className="px-2.5 py-1 bg-background-tertiary rounded-lg text-xs text-text-muted">
              {template.storyStyle.replace(/_/g, " ")}
            </span>
          </div>
        </div>
      </div>

      {/* Processing Banner */}
      {(genState === "sending" || genState === "processing") && (
        <div className="flex items-center gap-3 p-4 mb-6 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <Loader2 size={20} className="text-emerald-500 flex-shrink-0 animate-spin" />
          <div>
            <p className="text-sm font-semibold text-emerald-400">
              {genState === "sending" ? "Starting generation..." : "Video is processing"}
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              {genMessage}
            </p>
          </div>
        </div>
      )}

      {genError && (
        <div className="p-4 mb-6 rounded-xl bg-destructive/10 border border-destructive/30">
          <p className="text-sm text-destructive">{genError}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-background-secondary rounded-xl p-1">
        <button
          onClick={() => setActiveTab("script")}
          className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === "script"
              ? "bg-background text-text-primary shadow-sm"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <Wand2 size={14} className="inline mr-2 -mt-0.5" />
          Write Your Script
        </button>
        <button
          onClick={() => setActiveTab("sample")}
          className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === "sample"
              ? "bg-background text-text-primary shadow-sm"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <Code2 size={14} className="inline mr-2 -mt-0.5" />
          Sample Output
        </button>
      </div>

      {/* Script Tab */}
      {activeTab === "script" && (
        <div className="space-y-5">
          {/* Tips */}
          <div className="bg-primary/5 rounded-xl p-4 border border-primary/10">
            <p className="text-sm text-text-secondary mb-3">
              {template.scriptGuidance}
            </p>
            <ul className="space-y-1.5">
              {template.promptTips.map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-text-muted">
                  <span className="text-primary mt-0.5">•</span>
                  {tip}
                </li>
              ))}
            </ul>
          </div>

          {/* Fields */}
          {template.fields.map((field) => (
            <TemplateFieldInput
              key={field.id}
              field={field}
              value={fieldValues[field.id] || ""}
              onChange={(val) => updateField(field.id, val)}
            />
          ))}

          {/* Generate Button */}
          <div className="pt-4">
            <Button
              onClick={handleGenerate}
              disabled={!requiredFieldsFilled || genState === "sending" || genState === "processing"}
              className="w-full py-3 text-base font-semibold rounded-xl"
            >
              {genState === "sending" ? (
                <>
                  <Loader2 size={18} className="mr-2 animate-spin" />
                  Starting...
                </>
              ) : genState === "processing" ? (
                <>
                  <Loader2 size={18} className="mr-2 animate-spin" />
                  Processing...
                </>
              ) : genState === "error" ? (
                <>
                  <Wand2 size={18} className="mr-2" />
                  Try Again
                </>
              ) : (
                <>
                  <Wand2 size={18} className="mr-2" />
                  Generate Video
                </>
              )}
            </Button>
            {(genState === "idle" || genState === "error") && (
              <p className="text-center text-xs text-text-muted mt-2">
                Video generation takes 3-5 minutes. You can edit it in the Studio afterwards.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Sample Output Tab */}
      {activeTab === "sample" && (
        <div className="space-y-5">
          {/* Sample overview */}
          <div className="bg-background-secondary rounded-xl p-5 border border-border">
            <h3 className="text-lg font-semibold text-text-primary mb-1">
              "{template.sampleOutput.title}"
            </h3>
            <p className="text-sm text-text-muted mb-3">
              {template.sampleOutput.description}
            </p>
            <div className="flex items-center gap-3 text-xs text-text-muted">
              <span>Mood: {template.sampleOutput.mood}</span>
              <span>•</span>
              <span>
                {template.sampleOutput.scenes.length} scenes
              </span>
              <span>•</span>
              <span>
                {template.sampleOutput.scenes.reduce((a, s) => a + s.duration_seconds, 0)}s total
              </span>
            </div>
          </div>

          {/* Scene cards */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-text-secondary">Scene Breakdown</h4>
            {template.sampleOutput.scenes.map((scene) => (
              <div
                key={scene.scene_number}
                className="bg-background-secondary rounded-xl p-4 border border-border"
              >
                <div className="flex items-center gap-3 mb-2">
                  <span className="w-7 h-7 rounded-lg bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                    {scene.scene_number}
                  </span>
                  <h5 className="text-sm font-semibold text-text-primary flex-1">
                    {scene.title}
                  </h5>
                  <span className="text-xs text-text-muted">{scene.duration_seconds}s</span>
                </div>
                <p className="text-sm text-text-secondary mb-2">{scene.text}</p>
                {(scene.voiceover || scene.dialogue) && (
                  <div className="bg-background rounded-lg p-3 mt-2">
                    <p className="text-xs text-text-muted mb-1 flex items-center gap-1.5">
                      {scene.voiceover ? <><Mic size={10} /> Voiceover:</> : <><MessageSquare size={10} /> Dialogue:</>}
                    </p>
                    <p className="text-sm text-text-secondary italic">
                      "{scene.voiceover || scene.dialogue}"
                    </p>
                  </div>
                )}
                <p className="text-xs text-text-muted mt-2 leading-relaxed">
                  <span className="text-text-muted/60">Visual: </span>
                  {scene.first_frame_image_description.substring(0, 120)}...
                </p>
              </div>
            ))}
          </div>

          {/* Raw JSON toggle */}
          <div className="border border-border rounded-xl overflow-hidden">
            <button
              onClick={() => setShowSampleJson(!showSampleJson)}
              className="w-full flex items-center justify-between px-4 py-3 bg-background-secondary hover:bg-background-tertiary transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                <Code2 size={14} />
                Raw JSON Template
              </span>
              {showSampleJson ? <ChevronUp size={14} className="text-text-muted" /> : <ChevronDown size={14} className="text-text-muted" />}
            </button>
            {showSampleJson && (
              <div className="bg-background border-t border-border/70">
                <div className="flex items-center justify-end px-3 py-2 border-b border-border/60">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleCopySampleJson}
                    className="h-8 px-2.5 text-xs"
                  >
                    {jsonCopied ? (
                      <>
                        <Check size={13} className="mr-1.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy size={13} className="mr-1.5" />
                        Copy JSON
                      </>
                    )}
                  </Button>
                </div>
                <div className="max-h-[26rem] overflow-auto overscroll-contain">
                  <pre className="p-4 text-xs text-text-muted leading-relaxed font-mono whitespace-pre min-w-max">
                    {JSON.stringify(template.sampleOutput, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>

          {/* Template JSON schema info */}
          <div className="bg-background-secondary rounded-xl p-4 border border-border">
            <h4 className="text-sm font-semibold text-text-secondary mb-2">
              Create Your Own Template
            </h4>
            <p className="text-xs text-text-muted leading-relaxed">
              Templates follow a standard JSON schema. Each template defines video generation parameters
              (video_style, narration, subtitle_type) and includes a sample output with scene definitions.
              To create a custom template, follow the structure shown in the raw JSON above and include:
              title, template type, hook, mood, description, and an array of scenes with visual descriptions.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Field Input Component ─────────────────────────────────

const TemplateFieldInput: React.FC<{
  field: TemplateField;
  value: string;
  onChange: (value: string) => void;
}> = ({ field, value, onChange }) => {
  return (
    <div>
      <label className="block text-sm font-medium text-text-secondary mb-2">
        {field.label}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </label>

      {field.type === "textarea" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={5}
          className="w-full px-4 py-3 bg-background-secondary border border-border/60 rounded-xl text-sm text-text-primary placeholder:text-text-muted/50 resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
        />
      ) : field.type === "select" ? (
        <div className="flex flex-wrap gap-2">
          {field.options?.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
                value === opt.value
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-background-secondary text-text-muted border border-border/60 hover:border-primary/30 hover:text-text-secondary"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : field.type === "number" ? (
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="bg-background-secondary border-border/60 rounded-xl text-text-primary"
        />
      ) : (
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="bg-background-secondary border-border/60 rounded-xl text-text-primary"
        />
      )}
    </div>
  );
};

export default VoidspaceTemplateGallery;
