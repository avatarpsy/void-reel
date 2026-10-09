import { create } from "zustand";

/**
 * What the viewer shows while the person is FINE-TUNING on the timeline —
 * the polish gestures an AI-made cut still needs (9 Oct 2026).
 *
 * Two things, both transient (never saved, never undone):
 *
 *  • `skimTime` — the time under the pointer while it hovers the lanes. The
 *    paused viewer paints this instead of the playhead, so moving the mouse
 *    across a clip shows its frames without moving the playhead (Final Cut's
 *    skimmer). `null` = paint the playhead as usual.
 *
 *  • `monitor` — the two-up view a slip or roll drag needs (DaVinci's trim
 *    view). A slip shows the clip's new FIRST and LAST frame; a roll shows the
 *    outgoing clip's last frame and the incoming clip's first. Frames are
 *    SOURCE times of one media item each, drawn straight from the media, so
 *    they are exact even when the compositor would be mid-render.
 */
export interface MonitorFrame {
  mediaId: string;
  /** Seconds into the SOURCE media. */
  time: number;
  label: string;
}

export interface EditMonitor {
  title: string;
  frames: [MonitorFrame, MonitorFrame];
  /** Short readout of the change, e.g. "+12f". */
  badge?: string;
}

const SKIM_PREF_KEY = "openreel.timeline.skimming";

function readSkimPref(): boolean {
  try {
    const v = localStorage.getItem(SKIM_PREF_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

interface EditMonitorState {
  skimEnabled: boolean;
  skimTime: number | null;
  monitor: EditMonitor | null;
  setSkimEnabled: (on: boolean) => void;
  setSkimTime: (t: number | null) => void;
  setMonitor: (m: EditMonitor | null) => void;
}

export const useEditMonitorStore = create<EditMonitorState>((set, get) => ({
  skimEnabled: readSkimPref(),
  skimTime: null,
  monitor: null,
  setSkimEnabled: (on) => {
    try {
      localStorage.setItem(SKIM_PREF_KEY, on ? "1" : "0");
    } catch {
      /* preference just won't persist */
    }
    set({ skimEnabled: on, skimTime: on ? get().skimTime : null });
  },
  setSkimTime: (t) => {
    if (get().skimTime === t) return;
    set({ skimTime: t });
  },
  setMonitor: (m) => set({ monitor: m }),
}));

/** Frame-accurate readout: "+12f", "-1s 4f". */
export function formatFrameDelta(seconds: number, fps: number): string {
  const f = Math.round(seconds * (fps || 30));
  const sign = f > 0 ? "+" : f < 0 ? "−" : "±";
  const abs = Math.abs(f);
  const rate = Math.round(fps || 30);
  const s = Math.floor(abs / rate);
  const rem = abs % rate;
  return s > 0 ? `${sign}${s}s ${rem}f` : `${sign}${rem}f`;
}

