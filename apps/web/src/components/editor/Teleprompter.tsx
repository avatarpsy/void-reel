import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Minus, Plus, X, Gauge, Play, Pause, Contrast } from "lucide-react";
import { screenRecorderService } from "../../services/screen-recorder";
import { TeleprompterAsr, type AsrStatus } from "../../services/teleprompter-asr";

/**
 * Teleprompter — a professional prompter OVERLAID on TOP of the editor's video
 * player while you record. The user writes their script up front; on record it
 * projects over the player (right where they look) and scrolls.
 *
 * Layering: the panel sits at a very high z-index (just below the recording
 * controls) so the script always renders ON TOP of the live webcam/self-view,
 * never behind it. A solid dark scrim with a USER-ADJUSTABLE opacity sits behind
 * the text for readability against a bright shot — dial it up over a busy
 * background, down to keep more of the shot visible.
 *
 * Scroll model (why it's reliable now):
 *   • PRIMARY: a smooth, always-on time-based crawl at an adjustable speed
 *     (WPM). This ALWAYS moves — it does not depend on the microphone.
 *   • ENHANCEMENT (English): on-device Whisper. The recorder OWNS the mic during
 *     a take, so the Web Speech API gets no audio on Chrome and never fires.
 *     Instead we TAP the recorder's live mic track (screenRecorderService.
 *     getMicStream) and run a local whisper-base.en model on the trailing few
 *     seconds ~once a second, fuzzily aligning the spoken words to the script and
 *     SNAPPING the read position to where the speaker actually is. If speech is
 *     silent, still loading, or unavailable, the crawl carries it.
 *
 * Positioning: the panel measures the player element ([data-tour='preview'])
 * and overlays it exactly, so it reads as part of the video — not a stray
 * box floating over the whole window. Re-measures on resize.
 */

interface TeleprompterProps {
  script: string;
  /** True while actively recording (drives the crawl + speech tracking). */
  active: boolean;
  onClose?: () => void;
}

interface PrompterSettings {
  fontSize: number;
  /** Scroll pace in words/second (≈ wpm/60). 2.3 ≈ 138 wpm (natural speaking). */
  speed: number;
  /** Darkness of the scrim behind the text, 0 (see-through) → 1 (opaque). */
  opacity: number;
}

const DEFAULTS: PrompterSettings = { fontSize: 38, speed: 2.3, opacity: 0.72 };
const LS_KEY = "voidspace.teleprompter.settings";
// Keep the active word at this fraction down the panel ("reading line").
const READ_LINE = 0.4;
const SPEED_MIN = 0.8;
const SPEED_MAX = 4.5;
const OPACITY_MIN = 0.3;
const OPACITY_MAX = 0.95;
// Above the inline recording preview (webcam self-view, z-40 inside the player)
// so the script renders ON TOP of the shot. One below the recording controls
// (2147483000) so Stop/Pause always stay reachable above the prompter.
const OVERLAY_Z = 2147482000;

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function loadSettings(): PrompterSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // Migrate older saves (which had x/y/width, and no opacity) — keep only
      // what we use now and backfill new fields from defaults.
      return {
        fontSize: typeof s.fontSize === "number" ? s.fontSize : DEFAULTS.fontSize,
        speed: typeof s.speed === "number" ? s.speed : DEFAULTS.speed,
        opacity: typeof s.opacity === "number" ? s.opacity : DEFAULTS.opacity,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

/** Measure the editor player so the prompter overlays it exactly. */
function measurePlayerRect(): { left: number; top: number; width: number; height: number } | null {
  if (typeof document === "undefined") return null;
  const el =
    document.querySelector("[data-tour='preview']") ||
    document.querySelector(".preview-canvas-wrap") ||
    document.querySelector("canvas");
  if (!el) return null;
  const r = (el as HTMLElement).getBoundingClientRect();
  if (r.width < 80 || r.height < 80) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export const Teleprompter: React.FC<TeleprompterProps> = ({
  script,
  active,
  onClose,
}) => {
  const [settings, setSettings] = useState<PrompterSettings>(loadSettings);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [rect, setRect] = useState(measurePlayerRect);
  // On-device Whisper state — only "listening" (green dot) vs not. The model
  // download is a silent background concern (prewarmed site-wide), so there is
  // deliberately NO "setting up / downloading" state shown here.
  const [asrStatus, setAsrStatus] = useState<AsrStatus>("idle");

  const scrollRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const targetScrollRef = useRef(0);
  // Fractional read position (word index). The crawl advances it; speech snaps it.
  const readPosRef = useRef(0);
  const speedRef = useRef(settings.speed);
  speedRef.current = settings.speed;
  const activeRef = useRef(active);
  activeRef.current = active && !paused;
  const currentIndexRef = useRef(0);
  currentIndexRef.current = currentIndex;

  const tokens = useMemo(() => {
    const out: { display: string; norm: string }[] = [];
    for (const raw of script.split(/\s+/)) {
      if (!raw) continue;
      out.push({ display: raw, norm: normalizeWord(raw) });
    }
    return out;
  }, [script]);
  const normWords = useMemo(() => tokens.map((t) => t.norm), [tokens]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  // ── Keep the panel pinned over the player ────────────────────────────────
  useEffect(() => {
    const update = () => setRect(measurePlayerRect());
    update();
    // The player can lay out a beat after mount (iframe/canvas sizing), so
    // re-measure a few times early, then on resize.
    const timers = [120, 320, 700, 1400].map((ms) => window.setTimeout(update, ms));
    window.addEventListener("resize", update);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("resize", update);
    };
  }, [active]);

  // ── Forward fuzzy matcher (speech → script position) ─────────────────────
  const matchProbe = useCallback(
    (probe: string[]): number => {
      const cleanProbe = probe.filter(Boolean);
      if (cleanProbe.length === 0) return -1;
      const cur = currentIndexRef.current;
      const SEARCH_BACK = 2;
      const SEARCH_AHEAD = 25;
      const from = Math.max(0, cur - SEARCH_BACK);
      const to = Math.min(normWords.length - 1, cur + SEARCH_AHEAD);

      let bestPos = -1;
      let bestScore = 0;
      for (let pos = from; pos <= to; pos++) {
        let p = cleanProbe.length - 1;
        let s = pos;
        let score = 0;
        let scanned = 0;
        const maxScan = cleanProbe.length + 4;
        while (p >= 0 && s >= 0 && scanned < maxScan) {
          if (normWords[s] === cleanProbe[p]) {
            score += 1;
            p--;
            s--;
          } else {
            s--;
          }
          scanned++;
        }
        const endBonus = normWords[pos] === cleanProbe[cleanProbe.length - 1] ? 0.6 : 0;
        const total = score + endBonus;
        if (total > bestScore) {
          bestScore = total;
          bestPos = pos;
        }
      }
      if (bestPos >= 0 && bestScore >= 1.4 && bestPos >= currentIndexRef.current - 1) {
        return bestPos;
      }
      return -1;
    },
    [normWords],
  );

  // Snap the read position to where the speaker actually is, but only ever
  // FORWARD (and not a huge jump) so noise can't fling the prompter around.
  const snapToWords = useCallback(
    (probe: string[]) => {
      const next = matchProbe(probe);
      if (next >= 0 && next > readPosRef.current && next - readPosRef.current < 18) {
        readPosRef.current = next;
      }
    },
    [matchProbe],
  );

  // ── On-device Whisper (English) — ENHANCEMENT; syncs the crawl, never gates it ──
  // The recorder owns the mic, so Web Speech gets no audio on Chrome. We tap the
  // recorder's live mic track and transcribe it locally, snapping the scroll to
  // the recognized words. The crawl below carries scrolling until Whisper warms.
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let asr: TeleprompterAsr | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const begin = (stream: MediaStream) => {
      if (disposed) return;
      asr = new TeleprompterAsr({
        onWords: (words) => {
          if (!activeRef.current) return; // paused / stopped — ignore late results
          snapToWords(words);
        },
        onStatus: (s) => setAsrStatus(s),
      });
      void asr.start(stream);
    };

    // The mic track may land a beat after `recording` begins (permissions →
    // stream assignment). Poll briefly for it, then give up (crawl-only).
    const tryStart = () => {
      const stream = screenRecorderService.getMicStream();
      if (stream) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        begin(stream);
        return true;
      }
      return false;
    };
    if (!tryStart()) {
      let attempts = 0;
      pollTimer = setInterval(() => {
        if (tryStart() || ++attempts > 12) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }
      }, 300);
    }

    return () => {
      disposed = true;
      if (pollTimer) clearInterval(pollTimer);
      asr?.stop();
      setAsrStatus("idle");
    };
  }, [active, snapToWords]);

  // ── Unified scroll loop: crawl + ease (always running) ───────────────────
  useEffect(() => {
    let raf = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000); // clamp big gaps (tab blur)
      lastTs = now;

      // Advance the read position by the crawl speed while recording.
      if (activeRef.current && tokens.length > 0) {
        readPosRef.current = Math.min(
          tokens.length - 1,
          readPosRef.current + speedRef.current * dt,
        );
      }

      const idx = Math.max(0, Math.min(tokens.length - 1, Math.round(readPosRef.current)));
      if (idx !== currentIndexRef.current) setCurrentIndex(idx);

      // Recompute the scroll target from the active word's position.
      const container = scrollRef.current;
      const el = wordRefs.current[idx];
      if (container && el) {
        targetScrollRef.current = Math.max(0, el.offsetTop - container.clientHeight * READ_LINE);
        const cur = container.scrollTop;
        const delta = targetScrollRef.current - cur;
        if (Math.abs(delta) > 0.5) container.scrollTop = cur + delta * 0.12;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // tokens.length so the loop re-binds when a new script loads.
  }, [tokens.length]);

  // Reset to the top whenever a new take begins.
  useEffect(() => {
    if (active) {
      readPosRef.current = 0;
      setCurrentIndex(0);
      setPaused(false);
      targetScrollRef.current = 0;
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [active]);

  const bumpFont = (delta: number) =>
    setSettings((s) => ({ ...s, fontSize: Math.max(20, Math.min(96, s.fontSize + delta)) }));
  const bumpSpeed = (delta: number) =>
    setSettings((s) => ({ ...s, speed: Math.round(Math.max(SPEED_MIN, Math.min(SPEED_MAX, s.speed + delta)) * 10) / 10 }));
  const setOpacity = (v: number) =>
    setSettings((s) => ({ ...s, opacity: Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, v)) }));

  // Position: overlay the player when measured, else a centered viewport band.
  const panelStyle: React.CSSProperties = rect
    ? { position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : { position: "fixed", left: "50%", top: "12vh", transform: "translateX(-50%)", width: "min(760px, 92vw)", height: "46vh" };

  // Header speech-tracking indicator. Green = live Whisper auto-scroll, grey =
  // crawl-only (mic off / model still warming). No download/loading state is
  // ever shown — the model is fetched silently in the background.
  const asrLive = asrStatus === "listening";
  const dotColor = asrLive ? "#46d39a" : "rgba(150,160,190,0.7)";
  const headerLabel = "Teleprompter";

  // Solid dark scrim behind the text at the user's chosen opacity, with the
  // edges nudged a touch darker for readability. This paints ON TOP of the
  // webcam self-view (see OVERLAY_Z) so the script is never behind the shot.
  const op = settings.opacity;
  const edgeOp = Math.min(1, op + 0.1);

  return (
    <div
      className="teleprompter-overlay"
      style={{
        ...panelStyle,
        zIndex: OVERLAY_Z,
        display: "flex",
        flexDirection: "column",
        borderRadius: 16,
        overflow: "hidden",
        background: `linear-gradient(180deg, rgba(6,9,18,${edgeOp}) 0%, rgba(6,9,18,${op}) 22%, rgba(6,9,18,${op}) 78%, rgba(6,9,18,${edgeOp}) 100%)`,
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        boxShadow: "0 20px 70px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(120,150,230,0.22)",
        userSelect: "none",
        pointerEvents: "auto",
      }}
    >
      {/* Compact control bar — wraps instead of clipping on a narrow player. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          padding: "7px 10px",
          background: "rgba(10,14,28,0.72)",
          borderBottom: "1px solid rgba(120,150,230,0.18)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: "rgba(241,244,255,0.82)", whiteSpace: "nowrap" }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: dotColor,
              boxShadow: asrLive ? "0 0 8px #46d39a" : "none",
            }}
          />
          {headerLabel}
        </span>
        <div style={{ flex: 1, minWidth: 8 }} />

        {/* Pause / play the scroll */}
        <button type="button" onClick={() => setPaused((p) => !p)} style={ctrlBtn} title={paused ? "Resume scroll" : "Pause scroll"}>
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        {/* Speed */}
        <div style={chip} title="Scroll speed (words per minute)">
          <button type="button" onClick={() => bumpSpeed(-0.2)} style={ctrlBtn} title="Slower"><Minus size={13} /></button>
          <Gauge size={13} style={{ color: "rgba(241,244,255,0.6)" }} />
          <span style={{ fontSize: 11, color: "rgba(241,244,255,0.7)", width: 30, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {Math.round(settings.speed * 60)}
          </span>
          <button type="button" onClick={() => bumpSpeed(0.2)} style={ctrlBtn} title="Faster"><Plus size={13} /></button>
        </div>
        {/* Background opacity */}
        <div style={chip} title="Background darkness">
          <Contrast size={13} style={{ color: "rgba(241,244,255,0.6)" }} />
          <input
            type="range"
            min={OPACITY_MIN}
            max={OPACITY_MAX}
            step={0.05}
            value={settings.opacity}
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
            style={{ width: 68, accentColor: "#5b9dff", cursor: "pointer" }}
            title="Background darkness"
          />
          <span style={{ fontSize: 11, color: "rgba(241,244,255,0.7)", width: 32, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {Math.round(settings.opacity * 100)}%
          </span>
        </div>
        {/* Font size */}
        <div style={chip} title="Text size">
          <button type="button" onClick={() => bumpFont(-4)} style={ctrlBtn} title="Smaller"><span style={{ fontSize: 11, fontWeight: 800 }}>A−</span></button>
          <button type="button" onClick={() => bumpFont(4)} style={ctrlBtn} title="Bigger"><span style={{ fontSize: 13, fontWeight: 800 }}>A+</span></button>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} style={{ ...ctrlBtn, marginLeft: 2 }} title="Hide teleprompter">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Reading area */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {/* Reading-line guide */}
        <div
          style={{
            position: "absolute",
            top: `${READ_LINE * 100}%`,
            left: 0,
            right: 0,
            height: 2,
            background: "linear-gradient(90deg, transparent, rgba(91,157,255,0.6), transparent)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
        <div
          ref={scrollRef}
          style={{
            height: "100%",
            overflow: "hidden",
            padding: "0 8%",
            maskImage: "linear-gradient(to bottom, transparent, #000 16%, #000 84%, transparent)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent, #000 16%, #000 84%, transparent)",
          }}
        >
          {/* top spacer so the first word can reach the reading line */}
          <div style={{ height: `${READ_LINE * 100}%` }} />
          <p
            style={{
              fontSize: settings.fontSize,
              lineHeight: 1.5,
              fontWeight: 700,
              color: "rgba(241,244,255,0.5)",
              margin: 0,
              textAlign: "center",
              textShadow: "0 2px 12px rgba(0,0,0,0.6)",
            }}
          >
            {tokens.map((t, i) => (
              <span
                key={i}
                ref={(el) => (wordRefs.current[i] = el)}
                style={{
                  color:
                    i < currentIndex
                      ? "rgba(241,244,255,0.34)"
                      : i === currentIndex
                        ? "#ffffff"
                        : "rgba(241,244,255,0.86)",
                  transition: "color 120ms linear",
                }}
              >
                {t.display}{" "}
              </span>
            ))}
          </p>
          {/* bottom spacer so the last word can reach the line */}
          <div style={{ height: "100%" }} />
        </div>
      </div>
    </div>
  );
};

const ctrlBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 24,
  height: 22,
  padding: "0 5px",
  borderRadius: 6,
  border: "1px solid rgba(120,150,230,0.28)",
  background: "rgba(28,36,64,0.6)",
  color: "rgba(241,244,255,0.85)",
  cursor: "pointer",
};

const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 4px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.04)",
};
