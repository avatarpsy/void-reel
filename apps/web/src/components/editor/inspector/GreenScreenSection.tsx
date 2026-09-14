import React, { useState, useCallback, useMemo } from "react";
import { Video, Pipette, RefreshCw, Eye, EyeOff, Layers } from "lucide-react";
import { useProjectStore } from "../../../stores/project-store";
import type { RGB, ChromaKeySettings } from "@openreel/core";

interface GreenScreenSectionProps {
  clipId: string;
}

const ColorPreview: React.FC<{ color: RGB; onClick?: () => void }> = ({
  color,
  onClick,
}) => (
  <button
    onClick={onClick}
    className="w-8 h-8 rounded-lg border-2 border-border hover:border-primary transition-colors"
    style={{
      backgroundColor: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
    }}
    title="Click to pick color from video"
  />
);

const ControlSlider: React.FC<{
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}> = ({ label, value, onChange, min = 0, max = 1, step = 0.01 }) => {
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-text-secondary">{label}</span>
        <span className="text-[10px] font-mono text-text-primary bg-background-tertiary px-1.5 py-0.5 rounded border border-border">
          {Math.round(value * 100)}%
        </span>
      </div>
      <div className="relative h-1.5">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
        />
        <div className="absolute inset-0 bg-background-tertiary rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full shadow-sm pointer-events-none"
          style={{ left: `calc(${percentage}% - 5px)` }}
        />
      </div>
    </div>
  );
};

const ColorPresetButton: React.FC<{
  color: RGB;
  label: string;
  isActive: boolean;
  onClick: () => void;
}> = ({ color, label, isActive, onClick }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[9px] transition-colors ${
      isActive
        ? "bg-primary text-white"
        : "bg-background-tertiary text-text-muted hover:text-text-primary"
    }`}
  >
    <div
      className="w-3 h-3 rounded-sm border border-border"
      style={{
        backgroundColor: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
      }}
    />
    {label}
  </button>
);

const COLOR_PRESETS: { color: RGB; label: string }[] = [
  { color: { r: 0, g: 1, b: 0 }, label: "Green" },
  { color: { r: 0, g: 0, b: 1 }, label: "Blue" },
  { color: { r: 1, g: 0, b: 1 }, label: "Magenta" },
  { color: { r: 0, g: 1, b: 1 }, label: "Cyan" },
];

const CHROMA_DEFAULTS: ChromaKeySettings = {
  enabled: false,
  keyColor: { r: 0, g: 1, b: 0 },
  tolerance: 0.3,
  edgeSoftness: 0.1,
  spillSuppression: 0.5,
};

export const GreenScreenSection: React.FC<GreenScreenSectionProps> = ({
  clipId,
}) => {
  const project = useProjectStore((state) => state.project);

  const [isPickingColor, setIsPickingColor] = useState(false);

  /**
   * ── THIS SECTION USED TO DO NOTHING AT ALL ─────────────────────────────────
   * It drove `ChromaKeyEngine`, and no renderer has ever read that engine: the
   * only two things that construct one are this file and `InspectorPanel`. So
   * keying a green screen changed no pixel in the preview, none in the export,
   * and — because the engine's map is not part of the Project — was gone on
   * reload. Three separate ways to be a no-op.
   *
   * The working chroma key is an ordinary entry in the video-effect chain:
   * `chromaKey` is a compiled shader in `video-effects-engine` with a CPU
   * fallback, it renders in preview AND export, and it persists through
   * `project.effectsState` like every other effect. That is also the path the
   * agent already reaches via the `video-effects` surface — so before this
   * change the agent could key a shot and the user could not, using a panel
   * that looked like it worked.
   *
   * One path now. The Inspector writes the same effect the renderer reads.
   *
   * KNOWN GAP, deliberately accepted: the shader takes keyColor / tolerance /
   * edgeSoftness and has no spill suppression. The old engine had a spill
   * setting that suppressed nothing, so nothing is lost by keeping the control
   * and storing its value in the effect params — it round-trips, and the day
   * the shader grows a `u_spill` uniform it starts working with no migration.
   * The label says so rather than implying it is doing something.
   */
  const chromaEffect = useMemo(() => {
    const effects = useProjectStore.getState().getVideoEffects(clipId) ?? [];
    return effects.find((e) => e.type === "chromaKey") ?? null;
    // `project.modifiedAt` is the re-read trigger: effects live in the bridge,
    // not on the clip, so there is no deeper value to depend on.
  }, [clipId, project.modifiedAt]);

  const settings = useMemo<ChromaKeySettings>(() => {
    if (!chromaEffect) return CHROMA_DEFAULTS;
    const p = chromaEffect.params ?? {};
    return {
      enabled: chromaEffect.enabled !== false,
      keyColor: (p.keyColor as RGB) ?? CHROMA_DEFAULTS.keyColor,
      tolerance: typeof p.tolerance === "number" ? p.tolerance : CHROMA_DEFAULTS.tolerance,
      edgeSoftness: typeof p.edgeSoftness === "number" ? p.edgeSoftness : CHROMA_DEFAULTS.edgeSoftness,
      spillSuppression:
        typeof p.spillSuppression === "number" ? p.spillSuppression : CHROMA_DEFAULTS.spillSuppression,
    };
  }, [chromaEffect]);

  /** Write one or more chroma params, creating the effect on first touch so a
   *  user who drags Tolerance before pressing the toggle still gets a key. */
  const patchChroma = useCallback(
    (patch: Partial<Omit<ChromaKeySettings, "enabled">>) => {
      const store = useProjectStore.getState();
      const existing = (store.getVideoEffects(clipId) ?? []).find(
        (e) => e.type === "chromaKey",
      );
      if (existing) {
        store.updateVideoEffect(clipId, existing.id, { ...existing.params, ...patch });
      } else {
        store.addVideoEffect(clipId, "chromaKey", {
          keyColor: CHROMA_DEFAULTS.keyColor,
          tolerance: CHROMA_DEFAULTS.tolerance,
          edgeSoftness: CHROMA_DEFAULTS.edgeSoftness,
          spillSuppression: CHROMA_DEFAULTS.spillSuppression,
          ...patch,
        });
      }
    },
    [clipId],
  );

  const handleToggleEnabled = useCallback(() => {
    const store = useProjectStore.getState();
    const existing = (store.getVideoEffects(clipId) ?? []).find(
      (e) => e.type === "chromaKey",
    );
    if (!existing) {
      // `enabled` is the EFFECT's own flag, not a param — passing it through
      // here would put a dead key in `params` that the shader never reads.
      store.addVideoEffect(clipId, "chromaKey", {
        keyColor: CHROMA_DEFAULTS.keyColor,
        tolerance: CHROMA_DEFAULTS.tolerance,
        edgeSoftness: CHROMA_DEFAULTS.edgeSoftness,
        spillSuppression: CHROMA_DEFAULTS.spillSuppression,
      });
      return;
    }
    // Toggle, never delete: a user turning the key off to compare is not asking
    // to lose the colour and tolerance they just dialled in.
    store.toggleVideoEffect(clipId, existing.id, existing.enabled === false);
  }, [clipId]);

  const handleSetKeyColor = useCallback(
    (color: RGB) => patchChroma({ keyColor: color }),
    [patchChroma],
  );

  const handleSetTolerance = useCallback(
    (value: number) => patchChroma({ tolerance: value }),
    [patchChroma],
  );

  const handleSetEdgeSoftness = useCallback(
    (value: number) => patchChroma({ edgeSoftness: value }),
    [patchChroma],
  );

  const handleSetSpillSuppression = useCallback(
    (value: number) => patchChroma({ spillSuppression: value }),
    [patchChroma],
  );

  const handleResetToDefaults = useCallback(() => {
    patchChroma({
      keyColor: CHROMA_DEFAULTS.keyColor,
      tolerance: CHROMA_DEFAULTS.tolerance,
      edgeSoftness: CHROMA_DEFAULTS.edgeSoftness,
      spillSuppression: CHROMA_DEFAULTS.spillSuppression,
    });
  }, [patchChroma]);

  const isActiveColor = (preset: RGB) =>
    Math.abs(settings.keyColor.r - preset.r) < 0.1 &&
    Math.abs(settings.keyColor.g - preset.g) < 0.1 &&
    Math.abs(settings.keyColor.b - preset.b) < 0.1;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-2 bg-gradient-to-r from-green-500/20 to-emerald-500/20 rounded-lg border border-green-500/30">
        <Video size={16} className="text-green-400" />
        <div className="flex-1">
          <span className="text-[11px] font-medium text-text-primary">
            Green Screen
          </span>
          <p className="text-[9px] text-text-muted">
            Remove background color from video
          </p>
        </div>
        <button
          onClick={handleToggleEnabled}
          className={`p-1.5 rounded transition-colors ${
            settings.enabled
              ? "bg-green-500/30 text-green-400"
              : "bg-background-tertiary text-text-muted hover:text-text-primary"
          }`}
          title={settings.enabled ? "Disable chroma key" : "Enable chroma key"}
        >
          {settings.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>

      {settings.enabled && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-text-primary">
                Key Color
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsPickingColor(!isPickingColor)}
                  className={`p-1.5 rounded transition-colors ${
                    isPickingColor
                      ? "bg-primary text-white"
                      : "bg-background-tertiary text-text-muted hover:text-text-primary"
                  }`}
                  title="Pick color from video"
                >
                  <Pipette size={12} />
                </button>
                <ColorPreview color={settings.keyColor} />
              </div>
            </div>

            {isPickingColor && (
              <div className="p-2 bg-primary/10 border border-primary/30 rounded-lg">
                <p className="text-[9px] text-primary text-center">
                  Click on the video preview to pick a color
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-1">
              {COLOR_PRESETS.map((preset) => (
                <ColorPresetButton
                  key={preset.label}
                  color={preset.color}
                  label={preset.label}
                  isActive={isActiveColor(preset.color)}
                  onClick={() => handleSetKeyColor(preset.color)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-border">
            <ControlSlider
              label="Tolerance"
              value={settings.tolerance}
              onChange={handleSetTolerance}
            />

            <ControlSlider
              label="Edge Softness"
              value={settings.edgeSoftness}
              onChange={handleSetEdgeSoftness}
            />

            <ControlSlider
              label="Spill Suppression (stored, not yet applied)"
              value={settings.spillSuppression}
              onChange={handleSetSpillSuppression}
            />
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-border">
            <button
              onClick={handleResetToDefaults}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] text-text-secondary hover:text-text-primary bg-background-tertiary rounded-lg transition-colors"
            >
              <RefreshCw size={12} />
              Reset to Defaults
            </button>
          </div>

          <div className="flex items-center gap-2 p-2 bg-background-tertiary rounded-lg">
            <Layers size={12} className="text-text-muted" />
            <p className="text-[9px] text-text-muted flex-1">
              Place video clips below this one to use as background
            </p>
          </div>
        </>
      )}

      {!settings.enabled && (
        <div className="text-center py-4">
          <Video
            size={24}
            className="mx-auto mb-2 text-text-muted opacity-50"
          />
          <p className="text-[10px] text-text-muted">
            Enable to remove background color
          </p>
          <button
            onClick={handleToggleEnabled}
            className="mt-2 px-4 py-1.5 text-[10px] bg-green-500/20 text-green-400 hover:bg-green-500/30 rounded-lg transition-colors"
          >
            Enable Green Screen
          </button>
        </div>
      )}
    </div>
  );
};

export default GreenScreenSection;
