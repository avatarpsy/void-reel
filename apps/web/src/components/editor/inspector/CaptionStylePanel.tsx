import React, { useCallback, useMemo, useState } from "react";
import { Type, Layers, CheckCheck } from "lucide-react";
import { useProjectStore } from "../../../stores/project-store";
import {
  CAPTION_ANIMATION_STYLES,
  getAnimationStyleDisplayName,
} from "@openreel/core";
import type {
  TextStyle,
  FontWeight,
  CaptionAnimationStyle,
} from "@openreel/core";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  LabeledSlider,
  Switch,
} from "@openreel/ui";
import { FONT_CATEGORIES, ensureFontReady } from "./font-catalog";

/**
 * CaptionStylePanel — the single, native caption editor.
 *
 * Captions are native text clips on the `track-captions` track. This panel
 * edits ONE selected caption or MANY (marquee/shift multi-select) with the
 * same controls, fixing the "inspector is empty on multi-select" bug. By
 * default edits hit only the selected boxes; the "Apply to all captions"
 * toggle widens every change to every caption on the track.
 *
 * Sizes are expressed as a percentage of the composition HEIGHT so captions
 * stay proportional (and viral-sized) on any aspect ratio / resolution — the
 * underlying TextStyle.fontSize stays in px (what the renderer consumes), we
 * just derive it from the % against project.settings.height.
 */

interface CaptionPreset {
  id: string;
  name: string;
  /** fontSize as a fraction of comp height (viral captions ≈ 5–8%). */
  heightRatio: number;
  /** normalized vertical position (0 = top, 1 = bottom). */
  positionY: number;
  /** stroke width as a fraction of fontSize (0 = no outline). */
  strokeRatio: number;
  /** active-word colour for the kinetic word highlight. */
  highlightColor: string;
  style: Partial<TextStyle>;
}

const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "kinetic",
    name: "Kinetic",
    heightRatio: 0.072,
    positionY: 0.8,
    strokeRatio: 0.09,
    highlightColor: "#FFE600",
    style: {
      fontFamily: "Anton",
      fontWeight: "normal" as FontWeight,
      color: "#FFFFFF",
      backgroundColor: "transparent",
      strokeColor: "#000000",
      textAlign: "center",
      shadowColor: "rgba(0,0,0,0.9)",
      shadowBlur: 18,
      shadowOffsetX: 0,
      shadowOffsetY: 6,
    },
  },
  {
    id: "boldbox",
    name: "Bold Box",
    heightRatio: 0.055,
    positionY: 0.85,
    strokeRatio: 0,
    highlightColor: "#FFE600",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: "bold" as FontWeight,
      color: "#FFFFFF",
      backgroundColor: "rgba(0,0,0,0.82)",
      strokeColor: "#000000",
      textAlign: "center",
      shadowColor: "transparent",
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    },
  },
  {
    id: "clean",
    name: "Clean",
    heightRatio: 0.05,
    positionY: 0.85,
    strokeRatio: 0,
    highlightColor: "#FFE600",
    style: {
      fontFamily: "Poppins",
      fontWeight: "bold" as FontWeight,
      color: "#FFFFFF",
      backgroundColor: "transparent",
      strokeColor: "#000000",
      textAlign: "center",
      shadowColor: "rgba(0,0,0,0.85)",
      shadowBlur: 10,
      shadowOffsetX: 0,
      shadowOffsetY: 3,
    },
  },
  {
    id: "pop",
    name: "Pop",
    heightRatio: 0.08,
    positionY: 0.5,
    strokeRatio: 0.08,
    highlightColor: "#FF3B3B",
    style: {
      fontFamily: "Bebas Neue",
      fontWeight: "normal" as FontWeight,
      color: "#FFFFFF",
      backgroundColor: "transparent",
      strokeColor: "#000000",
      textAlign: "center",
      shadowColor: "rgba(0,0,0,0.9)",
      shadowBlur: 14,
      shadowOffsetX: 0,
      shadowOffsetY: 4,
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    heightRatio: 0.042,
    positionY: 0.88,
    strokeRatio: 0,
    highlightColor: "#FFE600",
    style: {
      fontFamily: "Inter",
      fontWeight: "bold" as FontWeight,
      color: "#FFFFFF",
      backgroundColor: "transparent",
      strokeColor: "#000000",
      textAlign: "center",
      shadowColor: "rgba(0,0,0,0.8)",
      shadowBlur: 6,
      shadowOffsetX: 0,
      shadowOffsetY: 2,
    },
  },
];

const POSITION_OPTIONS: { id: string; label: string; y: number }[] = [
  { id: "top", label: "Top", y: 0.14 },
  { id: "middle", label: "Middle", y: 0.5 },
  { id: "bottom", label: "Bottom", y: 0.85 },
];

interface CaptionStylePanelProps {
  /** Currently selected caption clip ids (the default edit target). */
  clipIds: string[];
  /** Every caption clip id on the track (target when "apply to all" is on). */
  allCaptionIds: string[];
}

const FontField: React.FC<{
  value: string;
  onChange: (font: string) => void;
}> = ({ value, onChange }) => (
  <div className="flex items-center justify-between">
    <span className="text-[10px] text-text-secondary">Font</span>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="max-w-[150px] bg-background-secondary border-border text-text-primary text-[10px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="bg-background-secondary border-border max-h-80">
        {Object.entries(FONT_CATEGORIES).map(([category, fonts]) => (
          <SelectGroup key={category}>
            <SelectLabel className="text-text-muted text-[10px] font-medium">
              {category}
            </SelectLabel>
            {fonts.map((font) => (
              <SelectItem key={font} value={font} style={{ fontFamily: font }}>
                {font}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  </div>
);

export const CaptionStylePanel: React.FC<CaptionStylePanelProps> = ({
  clipIds,
  allCaptionIds,
}) => {
  const project = useProjectStore((state) => state.project);
  const getTextClip = useProjectStore((state) => state.getTextClip);
  const updateTextStyle = useProjectStore((state) => state.updateTextStyle);
  const updateTextTransform = useProjectStore(
    (state) => state.updateTextTransform,
  );
  const updateCaptionFields = useProjectStore(
    (state) => state.updateCaptionFields,
  );

  const [applyToAll, setApplyToAll] = useState(false);

  const compHeight = project.settings?.height || 1080;

  const targets = useMemo(
    () => (applyToAll ? allCaptionIds : clipIds),
    [applyToAll, allCaptionIds, clipIds],
  );

  // Representative clip drives the displayed control values. Re-reads after
  // every edit via project.modifiedAt.
  const repClip = useMemo(
    () => (targets.length ? getTextClip(targets[0]) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets, getTextClip, project.modifiedAt],
  );
  const style = repClip?.style;

  const applyStyle = useCallback(
    (changes: Partial<TextStyle>) => {
      targets.forEach((id) => updateTextStyle(id, changes));
    },
    [targets, updateTextStyle],
  );

  const applyVerticalPosition = useCallback(
    (y: number) => {
      targets.forEach((id) => {
        const clip = getTextClip(id);
        const x = clip?.transform?.position?.x ?? 0.5;
        updateTextTransform(id, { position: { x, y } });
      });
    },
    [targets, getTextClip, updateTextTransform],
  );

  const applyCaptionFields = useCallback(
    (fields: {
      captionHighlight?: boolean;
      captionHighlightColor?: string;
      captionAnimation?: CaptionAnimationStyle;
    }) => {
      targets.forEach((id) => updateCaptionFields(id, fields));
    },
    [targets, updateCaptionFields],
  );

  const applyPreset = useCallback(
    async (preset: CaptionPreset) => {
      await ensureFontReady(preset.style.fontFamily || "Inter");
      const fontSize = Math.round(compHeight * preset.heightRatio);
      const strokeWidth = Math.round(fontSize * preset.strokeRatio);
      applyStyle({ ...preset.style, fontSize, strokeWidth });
      applyVerticalPosition(preset.positionY);
      applyCaptionFields({ captionHighlightColor: preset.highlightColor });
    },
    [compHeight, applyStyle, applyVerticalPosition, applyCaptionFields],
  );

  if (!targets.length) return null;

  const sizePct = style
    ? Math.round((style.fontSize / compHeight) * 1000) / 10
    : 6;
  const strokeWidth = style?.strokeWidth ?? 0;
  const multi = clipIds.length > 1;

  return (
    <div className="space-y-4">
      {/* Header + scope toggle */}
      <div className="p-3 bg-primary/10 rounded-lg border border-primary/30 space-y-2">
        <div className="flex items-center gap-2">
          <Type size={14} className="text-primary" />
          <span className="text-xs font-bold text-primary">
            {multi ? `Captions · ${clipIds.length} selected` : "Caption"}
          </span>
        </div>
        <label className="flex items-center justify-between cursor-pointer">
          <span className="flex items-center gap-1.5 text-[10px] text-text-secondary">
            <Layers size={11} />
            Apply to all captions
          </span>
          <Switch checked={applyToAll} onCheckedChange={setApplyToAll} />
        </label>
        <p className="text-[9px] text-text-muted leading-snug">
          {applyToAll
            ? `Changes apply to all ${allCaptionIds.length} captions.`
            : multi
              ? `Changes apply to the ${clipIds.length} selected captions.`
              : "Changes apply to this caption. Toggle on to restyle all."}
        </p>
      </div>

      {/* Style presets */}
      <div className="space-y-2">
        <span className="text-[10px] text-text-secondary font-medium">
          Style
        </span>
        <div className="grid grid-cols-3 gap-1.5">
          {CAPTION_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyPreset(preset)}
              className="px-2 py-2 rounded-lg bg-background-tertiary border border-border hover:border-primary hover:bg-primary/10 transition-colors text-[10px] text-text-primary"
              style={{ fontFamily: preset.style.fontFamily }}
              title={`Apply "${preset.name}" caption style`}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      {/* Font + size */}
      <div className="space-y-3 p-3 bg-background-tertiary rounded-lg">
        <FontField
          value={style?.fontFamily || "Inter"}
          onChange={async (fontFamily) => {
            await ensureFontReady(fontFamily, style?.fontSize || 48);
            applyStyle({ fontFamily });
          }}
        />
        <LabeledSlider
          label="Size"
          value={sizePct}
          min={2}
          max={14}
          step={0.5}
          unit="%"
          onChange={(pct) => {
            const fontSize = Math.round((compHeight * pct) / 100);
            // Keep the outline proportional when one is present.
            applyStyle(
              strokeWidth > 0
                ? { fontSize, strokeWidth: Math.round(fontSize * 0.09) }
                : { fontSize },
            );
          }}
        />
      </div>

      {/* Colors + outline */}
      <div className="space-y-3 p-3 bg-background-tertiary rounded-lg">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-secondary">Text Color</span>
          <input
            type="color"
            value={style?.color || "#ffffff"}
            onChange={(e) => applyStyle({ color: e.target.value })}
            className="w-7 h-7 rounded border border-border cursor-pointer bg-transparent"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-secondary">Outline</span>
          <input
            type="color"
            value={style?.strokeColor || "#000000"}
            onChange={(e) => applyStyle({ strokeColor: e.target.value })}
            className="w-7 h-7 rounded border border-border cursor-pointer bg-transparent"
          />
        </div>
        <LabeledSlider
          label="Outline width"
          value={strokeWidth}
          min={0}
          max={Math.max(24, Math.round((style?.fontSize || 80) * 0.2))}
          step={1}
          unit="px"
          onChange={(w) => applyStyle({ strokeWidth: w })}
        />
      </div>

      {/* Kinetic word highlight (only for captions that carry word timing) */}
      {repClip?.captionWords && repClip.captionWords.length > 0 && (
        <div className="space-y-3 p-3 bg-background-tertiary rounded-lg">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[10px] text-text-secondary font-medium">
              Word highlight
            </span>
            <Switch
              checked={repClip?.captionHighlight !== false}
              onCheckedChange={(on) =>
                applyCaptionFields({ captionHighlight: on })
              }
            />
          </label>
          {repClip?.captionHighlight !== false && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-text-secondary">Animation</span>
              <Select
                value={repClip?.captionAnimation || "word-highlight"}
                onValueChange={(v) =>
                  applyCaptionFields({
                    captionAnimation: v as CaptionAnimationStyle,
                  })
                }
              >
                <SelectTrigger className="max-w-[150px] bg-background-secondary border-border text-text-primary text-[10px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-background-secondary border-border">
                  {CAPTION_ANIMATION_STYLES.filter((s) => s !== "none").map(
                    (s) => (
                      <SelectItem key={s} value={s}>
                        {getAnimationStyleDisplayName(s)}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-secondary">Active word</span>
            <input
              type="color"
              value={repClip?.captionHighlightColor || "#FFE600"}
              onChange={(e) =>
                applyCaptionFields({ captionHighlightColor: e.target.value })
              }
              className="w-7 h-7 rounded border border-border cursor-pointer bg-transparent"
            />
          </div>
          <p className="text-[9px] text-text-muted leading-snug">
            The spoken word pops + changes colour, in sync with the audio.
          </p>
        </div>
      )}

      {/* Vertical position (height) */}
      <div className="space-y-2 p-3 bg-background-tertiary rounded-lg">
        <span className="text-[10px] text-text-secondary font-medium">
          Position
        </span>
        <div className="grid grid-cols-3 gap-1.5">
          {POSITION_OPTIONS.map((opt) => {
            const active =
              repClip &&
              Math.abs((repClip.transform?.position?.y ?? 0.85) - opt.y) < 0.04;
            return (
              <button
                key={opt.id}
                onClick={() => applyVerticalPosition(opt.y)}
                className={`px-2 py-1.5 rounded-lg border text-[10px] transition-colors ${
                  active
                    ? "bg-primary text-white border-primary"
                    : "bg-background-secondary border-border text-text-secondary hover:text-text-primary"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="text-[9px] text-text-muted leading-snug flex items-center gap-1">
          <CheckCheck size={10} />
          Drag any caption on the canvas to fine-tune its spot.
        </p>
      </div>
    </div>
  );
};

export default CaptionStylePanel;
