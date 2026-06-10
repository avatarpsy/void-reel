import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Minus, Plus, X, Gauge, Play, Pause } from "lucide-react";

/**
 * Teleprompter — a professional prompter OVERLAID on the editor's video player
 * while you record. The user writes their script up front; on record it
 * projects over the player (right where they look) and scrolls.
 *
 * Scroll model (why it's reliable now):
 *   • PRIMARY: a smooth, always-on time-based crawl at an adjustable speed
 *     (WPM). This ALWAYS moves — it does not depend on the microphone, which
 *     the recorder holds during a take. (The old version only crawled when the
 *     Web Speech API was ABSENT, so on Chrome — where the API exists but gets
 *     no audio because the recorder owns the mic — it never scrolled at all.)
 *   • ENHANCEMENT: when speech recognition does produce results, we fuzzily
 *     align the spoken words to the script and SNAP the read position to keep
 *     the crawl synced to where the speaker actually is. If speech is silent
 *     or unavailable, the crawl carries it.
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
}

const DEFAULTS: PrompterSettings = { fontSize: 38, speed: 2.3 };
const LS_KEY = "voidspace.teleprompter.settings";
// Keep the active word at this fraction down the panel ("reading line").
const READ_LINE = 0.4;
const SPEED_MIN = 0.8;
const SPEED_MAX = 4.5;

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function loadSettings(): PrompterSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // Migrate older saves (which had x/y/width) — keep only what we use now.
      return {
        fontSize: typeof s.fontSize === "number" ? s.fontSize : DEFAULTS.fontSize,
        speed: typeof s.speed === "number" ? s.speed : DEFAULTS.speed,
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
  const [listening, setListening] = useState(false);
  const [paused, setPaused] = useState(false);
  const [rect, setRect] = useState(measurePlayerRect);

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

  // ── Speech recognition (ENHANCEMENT — syncs the crawl, never gates it) ────
  useEffect(() => {
    if (!active) return;
    const SR: any =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return; // no API → the crawl below carries the scroll on its own

    let stopped = false;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (e: any) => {
      const last = e.results[e.results.length - 1];
      if (!last) return;
      const transcript: string = last[0]?.transcript ?? "";
      const probe = transcript
        .split(/\s+/)
        .map(normalizeWord)
        .filter(Boolean)
        .slice(-6);
      const next = matchProbe(probe);
      // Snap the read position to where the speaker actually is, but only ever
      // FORWARD (and not a huge jump) so noise can't fling the prompter around.
      if (next >= 0 && next > readPosRef.current && next - readPosRef.current < 18) {
        readPosRef.current = next;
      }
    };
    recognition.onerror = () => {
      /* transient (no-speech / aborted) — onend restarts */
    };
    recognition.onend = () => {
      if (!stopped && activeRef.current) {
        try {
          recognition.start();
        } catch {
          /* already started */
        }
      }
    };

    try {
      recognition.start();
      setListening(true);
    } catch {
      /* ignore */
    }
    return () => {
      stopped = true;
      setListening(false);
      try {
        recognition.onend = null;
        recognition.stop();
      } catch {
        /* ignore */
      }
    };
  }, [active, matchProbe]);

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

  // Position: overlay the player when measured, else a centered viewport band.
  const panelStyle: React.CSSProperties = rect
    ? { position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : { position: "fixed", left: "50%", top: "12vh", transform: "translateX(-50%)", width: "min(760px, 92vw)", height: "46vh" };

  return (
    <div
      className="teleprompter-overlay"
      style={{
        ...panelStyle,
        zIndex: 190, // above the player/preview, below the recording controls (200)
        display: "flex",
        flexDirection: "column",
        borderRadius: 16,
        overflow: "hidden",
        // Translucent scrim so the player/self-view stays faintly visible behind
        // the text; darker at the edges for readability.
        background:
          "linear-gradient(180deg, rgba(6,9,18,0.86) 0%, rgba(6,9,18,0.62) 40%, rgba(6,9,18,0.62) 60%, rgba(6,9,18,0.86) 100%)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        boxShadow: "0 20px 70px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(120,150,230,0.22)",
        userSelect: "none",
        pointerEvents: "auto",
      }}
    >
      {/* Compact control bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "7px 10px",
          background: "rgba(10,14,28,0.55)",
          borderBottom: "1px solid rgba(120,150,230,0.18)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: "rgba(241,244,255,0.82)" }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: listening ? "#46d39a" : "rgba(150,160,190,0.7)", boxShadow: listening ? "0 0 8px #46d39a" : "none" }} />
          Teleprompter
        </span>
        <div style={{ flex: 1 }} />

        {/* Pause / play the scroll */}
        <button type="button" onClick={() => setPaused((p) => !p)} style={ctrlBtn} title={paused ? "Resume scroll" : "Pause scroll"}>
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        {/* Speed */}
        <div style={chip} title="Scroll speed">
          <button type="button" onClick={() => bumpSpeed(-0.2)} style={ctrlBtn} title="Slower"><Minus size={13} /></button>
          <Gauge size={13} style={{ color: "rgba(241,244,255,0.6)" }} />
          <span style={{ fontSize: 11, color: "rgba(241,244,255,0.7)", width: 30, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {Math.round(settings.speed * 60)}
          </span>
          <button type="button" onClick={() => bumpSpeed(0.2)} style={ctrlBtn} title="Faster"><Plus size={13} /></button>
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
