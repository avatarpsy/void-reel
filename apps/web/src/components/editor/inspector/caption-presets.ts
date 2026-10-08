/**
 * Caption style presets + position stops — shared by the Inspector's
 * CaptionStylePanel and the agent's `caption-style` surface, so a preset the
 * agent applies is exactly the one the user's button applies.
 */
import type { TextStyle, FontWeight } from "@openreel/core";

export interface CaptionPreset {
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

export const CAPTION_PRESETS: CaptionPreset[] = [
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

export const CAPTION_POSITION_OPTIONS: { id: string; label: string; y: number }[] = [
  { id: "top", label: "Top", y: 0.14 },
  { id: "middle", label: "Middle", y: 0.5 },
  { id: "bottom", label: "Bottom", y: 0.85 },
];
