import { useState, useCallback, useEffect } from "react";
import {
  ArrowRight,
  AudioWaveform,
  Clock3,
  Monitor,
  Music2,
  Smartphone,
  Sparkles,
  Square,
} from "lucide-react";
import { Button } from "@openreel/ui";
import type { SocialMediaCategory } from "@openreel/core";
import { VoidspaceTemplateGallery } from "./VoidspaceTemplateGallery";
import { CosmicField } from "../CosmicField";
import { useAnalytics, AnalyticsEvents } from "../../hooks/useAnalytics";

interface FormatOption {
  id: string;
  preset: SocialMediaCategory;
  /** Aspect used when creating the blank editor project. */
  aspect: "9:16" | "16:9" | "1:1";
  label: string;
  description: string;
  dimensions: string;
  icon: React.ElementType;
  gradient: string;
}

const FORMAT_OPTIONS: FormatOption[] = [
  {
    id: "vertical",
    preset: "tiktok",
    aspect: "9:16",
    label: "Vertical",
    description: "TikTok, Reels, Shorts",
    dimensions: "1080 × 1920",
    icon: Smartphone,
    gradient: "from-violet-500/20 to-fuchsia-500/20",
  },
  {
    id: "horizontal",
    preset: "youtube-video",
    aspect: "16:9",
    label: "Horizontal",
    description: "YouTube, Vimeo, Web",
    dimensions: "1920 × 1080",
    icon: Monitor,
    gradient: "from-blue-500/20 to-cyan-500/20",
  },
  {
    id: "square",
    preset: "instagram-post",
    aspect: "1:1",
    label: "Square",
    description: "Instagram, Facebook",
    dimensions: "1080 × 1080",
    icon: Square,
    gradient: "from-orange-500/20 to-rose-500/20",
  },
];

type ViewMode = "home" | "templates";
type LandingMode = "video" | "music";

interface WelcomeScreenProps {
  initialTab?: "templates";
  mode?: LandingMode;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  initialTab,
  mode = "video",
}) => {
  const { track } = useAnalytics();

  const [viewMode, setViewMode] = useState<ViewMode>(initialTab ?? "home");
  const [hoveredFormat, setHoveredFormat] = useState<string | null>(null);
  const isMusicMode = mode === "music" && viewMode === "home";

  // When initialTab="templates" (embedded from Nuxt page), hide the inner header
  const isEmbedded = initialTab === "templates";

  // The format / music cards are the on-ramp into the Voidspace studio,
  // which pairs the editor with the AI chat sidebar ("chat on the side").
  // That workspace lives at the Nuxt `/ai` route — NOT inside this
  // standalone openreel app — so we navigate the top-level window there,
  // carrying the chosen aspect (or music mode) as a query param the studio
  // page reads on mount (see `/ai` aspect/mode seeding).
  //
  // We deliberately do NOT set `window.location.hash = "#/new"` here. This
  // landing is served at `/studio/?forceWelcome=1`; because `forceWelcome=1`
  // lives in the query string, the openreel `showWelcome` guard keeps this
  // screen mounted even after the hash flips to `#/new` — the blank project
  // gets created but is never revealed, and there's no chat beside it.
  // Leaving the app for `/ai` both fixes that trap and is the intended
  // studio on-ramp.
  const openStudio = useCallback((params: Record<string, string>) => {
    const query = new URLSearchParams(params).toString();
    const target = query ? `/ai?${query}` : "/ai";
    // Use the top window in case we are ever rendered inside a frame;
    // same-origin so the href assignment never throws.
    (window.top ?? window).location.href = target;
  }, []);

  // Picking a format opens the studio at the chosen aspect, with the AI
  // chat ready on the side.
  const handleStartInStudio = useCallback(
    (option: FormatOption) => {
      track(AnalyticsEvents.PROJECT_CREATED, {
        preset: option.preset,
        aspect: option.aspect,
        source: "studio_landing",
      });
      openStudio({ aspect: option.aspect });
    },
    [openStudio, track],
  );

  const handleStartMusic = useCallback(() => {
    track(AnalyticsEvents.PROJECT_CREATED, {
      preset: "music",
      aspect: "16:9",
      source: "studio_music_landing",
    });
    openStudio({ mode: "music" });
  }, [openStudio, track]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // From templates → back home. From home → back to the projects
        // list (never silently drop into the chat-less bare editor).
        if (viewMode !== "home") setViewMode("home");
        else window.location.href = "/studio/projects";
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode]);

  if (viewMode === "templates") {
    return (
      <div className="fixed inset-0 z-50 bg-background flex flex-col">
        <CosmicField />
        {/* Only show inner header when navigated from home (standalone Studio mode) */}
        {!isEmbedded && (
          <header className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setViewMode("home")}
            >
              <ArrowRight className="rotate-180" size={16} />
              Back
            </Button>
            <h2 className="text-sm font-medium text-text-primary">Voidspace Templates</h2>
            <div className="w-16" />
          </header>
        )}
        <div className="relative z-10 flex-1 overflow-y-auto p-6">
          <VoidspaceTemplateGallery />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-background overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.08),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,rgba(139,92,246,0.05),transparent_50%)]" />

      {/* Voidspace cosmic field — stars + crescent moons, matching the rest
          of the site. Sits above the gradient washes, below the content. */}
      <CosmicField />

      {/* Back to Voidspace projects (sticky in top-left of editor shell) */}
      <a
        href="/studio/projects"
        className="absolute top-5 left-6 z-20 inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <ArrowRight className="rotate-180" size={14} />
        My Projects
      </a>

      <div className="relative z-10 h-full flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-3xl">
          <div className="flex flex-col items-center text-center mb-12">
            <div className="flex items-center gap-3 mb-6">
              <img
                src="/studio/images/logo.png"
                alt="Voidspace"
                className="w-12 h-12"
              />
            </div>

            <h1 className="text-4xl sm:text-5xl font-bold text-text-primary tracking-tight mb-3">
              {isMusicMode ? "Create music with your AI agent." : "From idea to export."}
            </h1>
            <p className="text-xl text-text-secondary mb-8">
              {isMusicMode ? "Prompt, produce, and visualize." : "In your browser."}
            </p>
            <p className="text-base text-text-muted max-w-md">
              {isMusicMode
                ? "Start in music mode to generate a track, refine the sound, and bring it into a visual project when you are ready."
                : "Pick a format and start creating with the AI agent."}
            </p>
          </div>

          {isMusicMode ? (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  {
                    label: "Prompt the Sound",
                    description: "Describe genre, mood, lyrics, and structure.",
                    icon: Sparkles,
                  },
                  {
                    label: "Shape the Track",
                    description: "Iterate on timing, sections, and direction.",
                    icon: AudioWaveform,
                  },
                  {
                    label: "Make it Visual",
                    description: "Turn the finished track into a video project.",
                    icon: Clock3,
                  },
                ].map((item) => {
                  const Icon = item.icon;

                  return (
                    <div
                      key={item.label}
                      className="relative flex flex-col items-center p-6 rounded-2xl bg-background-secondary border border-border"
                    >
                      <div className="w-16 h-16 mb-4 rounded-xl flex items-center justify-center bg-background-tertiary">
                        <Icon size={28} className="text-primary" />
                      </div>
                      <h3 className="text-lg font-semibold text-text-primary mb-2">
                        {item.label}
                      </h3>
                      <p className="text-sm text-text-muted leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <Button
                  size="lg"
                  onClick={handleStartMusic}
                  className="min-w-56"
                >
                  <Music2 size={18} />
                  Start Music Project
                  <ArrowRight size={16} />
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {FORMAT_OPTIONS.map((option) => {
                const Icon = option.icon;
                const isHovered = hoveredFormat === option.id;

                return (
                  <button
                    key={option.id}
                    onClick={() => handleStartInStudio(option)}
                    onMouseEnter={() => setHoveredFormat(option.id)}
                    onMouseLeave={() => setHoveredFormat(null)}
                    className={`
                      group relative flex flex-col items-center p-6 rounded-2xl
                      bg-background-secondary border border-border
                      hover:border-primary/40 hover:bg-background-tertiary
                      transition-all duration-200
                      ${isHovered ? "scale-[1.02] shadow-lg shadow-primary/5" : ""}
                    `}
                  >
                    <div
                      className={`
                      absolute inset-0 rounded-2xl bg-gradient-to-br ${option.gradient}
                      opacity-0 group-hover:opacity-100 transition-opacity duration-300
                    `}
                    />

                    <div className="relative z-10 flex flex-col items-center">
                      <div
                        className={`
                        w-16 h-16 mb-4 rounded-xl flex items-center justify-center
                        bg-background-tertiary group-hover:bg-primary/10
                        transition-colors duration-200
                      `}
                      >
                        <Icon
                          size={28}
                          className="text-text-muted group-hover:text-primary transition-colors"
                        />
                      </div>

                      <h3 className="text-lg font-semibold text-text-primary mb-1">
                        {option.label}
                      </h3>
                      <p className="text-sm text-text-muted mb-3">
                        {option.description}
                      </p>
                      <span className="text-xs font-mono text-text-muted/70 bg-background-tertiary px-2 py-1 rounded">
                        {option.dimensions}
                      </span>
                    </div>

                    <div
                      className={`
                      absolute bottom-4 left-1/2 -translate-x-1/2
                      flex items-center gap-1 text-sm font-medium text-primary
                      opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0
                      transition-all duration-200
                    `}
                    >
                      Start creating
                      <ArrowRight size={14} />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <p className="text-xs text-text-muted/45">
            {isMusicMode
              ? "Music mode opens the AI composer in an audio-first workspace"
              : "Choose a format to start creating with the AI agent"}
          </p>
        </div>
      </div>
    </div>
  );
};

export default WelcomeScreen;
