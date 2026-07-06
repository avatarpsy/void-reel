import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, X, Gauge, Play, Pause, Contrast, Move, Crosshair } from "lucide-react";
import { screenRecorderService } from "../../services/screen-recorder";
import { TeleprompterAsr, type AsrStatus } from "../../services/teleprompter-asr";
import { buildScriptIndex, SpeechTracker, type ScriptIndex } from "../../services/teleprompter-align";

/**
 * Teleprompter — a prompter OVERLAID on TOP of the recording self-view while you
 * record. The user writes their script up front; on record it projects over the
 * shot (right where they look) and scrolls to follow their SPEECH.
 *
 * Layering: rendered through a portal to <body> at a very high z-index (just
 * below the recording controls) so it always paints ON TOP of the inline webcam
 * self-view (which lives inside the player, a lower stacking context). Without
 * the portal a `position:fixed` panel can get trapped behind the player when an
 * ancestor has a transform.
 *
 * Scroll model (speech-PRIMARY):
 *   • When on-device Whisper is LISTENING, the scroll FOLLOWS your voice — it
 *     advances to the word you just spoke and HOLDS when you pause. It never
 *     runs ahead of you. (The recorder owns the mic, so Web Speech gets no audio
 *     on Chrome; we tap the recorder's live mic track and run whisper-base.en on
 *     the trailing few seconds ~once a second, fuzzily aligning to the script.)
 *   • FALLBACK: if the model is still warming, the mic is unavailable, or speech
 *     tracking is unsupported, a gentle time-based crawl at the chosen speed
 *     carries the scroll so the prompter still works.
 *
 * Positioning: by default the panel overlays the player ([data-tour='preview'])
 * exactly. The user can DRAG the header to reposition it and drag the corner to
 * resize; "Re-pin to video" snaps it back over the player.
 */

interface TeleprompterProps {
  script: string;
  /** True while actively recording (drives the scroll + speech tracking). */
  active: boolean;
  onClose?: () => void;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PrompterSettings {
  fontSize: number;
  /** Fallback crawl pace in words/second (≈ wpm/60). Only used when speech
   *  tracking isn't live. 2.3 ≈ 138 wpm. */
  speed: number;
  /** Darkness of the scrim behind the text, 0 (see-through) → 1 (opaque). */
  opacity: number;
  /** Manual position/size. null = auto-overlay the player. */
  pos: Box | null;
}

const DEFAULTS: PrompterSettings = { fontSize: 38, speed: 2.3, opacity: 0.72, pos: null };
const LS_KEY = "voidspace.teleprompter.settings";
// Keep the active word at this fraction down the panel ("reading line").
const READ_LINE = 0.4;
const SPEED_MIN = 0.8;
const SPEED_MAX = 4.5;
const OPACITY_MIN = 0.3;
const OPACITY_MAX = 0.95;
// Portaled to <body>; sits just below the recording controls (2147483000) so
// Stop/Pause always stay reachable above the prompter, and ABOVE the inline
// webcam self-view (z-40 inside the player) so the script is never behind the shot.
const OVERLAY_Z = 2147482000;

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sanitizePos(p: any): Box | null {
  if (!p || typeof p !== "object") return null;
  const { left, top, width, height } = p;
  if ([left, top, width, height].some((n) => typeof n !== "number" || !isFinite(n))) return null;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 720;
  const w = clamp(width, 240, vw);
  const h = clamp(height, 150, vh);
  // Keep at least a sliver on screen so a stale save can't strand it off-view.
  return { left: clamp(left, -w + 80, vw - 80), top: clamp(top, 0, vh - 56), width: w, height: h };
}

function loadSettings(): PrompterSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        fontSize: typeof s.fontSize === "number" ? s.fontSize : DEFAULTS.fontSize,
        speed: typeof s.speed === "number" ? s.speed : DEFAULTS.speed,
        opacity: typeof s.opacity === "number" ? s.opacity : DEFAULTS.opacity,
        pos: sanitizePos(s.pos),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

/** Measure the editor player so the prompter overlays it exactly. */
function measurePlayerRect(): Box | null {
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
  const [rect, setRect] = useState<Box | null>(measurePlayerRect);
  const [asrStatus, setAsrStatus] = useState<AsrStatus>("idle");

  const scrollRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const targetScrollRef = useRef(0);
  // Fractional read position (word index). Speech drives it; crawl is fallback.
  const readPosRef = useRef(0);
  const speedRef = useRef(settings.speed);
  speedRef.current = settings.speed;
  const activeRef = useRef(active);
  activeRef.current = active && !paused;
  const currentIndexRef = useRef(0);
  currentIndexRef.current = currentIndex;
  const asrStatusRef = useRef<AsrStatus>("idle");
  asrStatusRef.current = asrStatus;
  // Voice activity from the mic tap (RMS gate) + accumulated speaking time
  // without a single confirmed match. If the user is audibly SPEAKING but
  // recognition produces nothing for a while, recognition is broken on this
  // device — fall back to the crawl instead of freezing at the top.
  const voiceActiveRef = useRef(false);
  const voicedNoMatchMsRef = useRef(0);
  // When "listening" began — bounds the worst-case freeze: if NOTHING has
  // matched after this long (even if the voice gate never fired, e.g. a
  // silently-dead audio tap), fall back to the crawl.
  const listeningSinceRef = useRef(0);
  const [syncLost, setSyncLost] = useState(false);
  const syncLostRef = useRef(false);
  syncLostRef.current = syncLost;
  useEffect(() => {
    listeningSinceRef.current = asrStatus === "listening" ? performance.now() : 0;
  }, [asrStatus]);

  const tokens = useMemo(() => {
    const out: { display: string; norm: string }[] = [];
    for (const raw of script.split(/\s+/)) {
      if (!raw) continue;
      out.push({ display: raw, norm: normalizeWord(raw) });
    }
    return out;
  }, [script]);
  const normWords = useMemo(() => tokens.map((t) => t.norm), [tokens]);
  // Phonetic-indexed script + the stateful voice-follow tracker (confirmed
  // position, miss-streak re-anchoring, speaking-rate estimate). One tracker
  // per script; a new script resets it.
  const scriptIndex = useMemo<ScriptIndex>(() => buildScriptIndex(normWords), [normWords]);
  const trackerRef = useRef<SpeechTracker | null>(null);
  if (!trackerRef.current) trackerRef.current = new SpeechTracker(scriptIndex, settings.speed);
  useEffect(() => {
    trackerRef.current?.setIndex(scriptIndex, speedRef.current);
  }, [scriptIndex]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  // ── Keep the panel pinned over the player (only while auto-positioned) ──────
  useEffect(() => {
    if (settings.pos) return; // user dragged it — don't fight them
    const update = () => setRect(measurePlayerRect());
    update();
    const timers = [120, 320, 700, 1400].map((ms) => window.setTimeout(update, ms));
    window.addEventListener("resize", update);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("resize", update);
    };
  }, [active, settings.pos]);

  // ── Speech → script alignment (phonetic + locality + re-anchor) ──────────
  // Called ~1×/s with the recent spoken words. The SpeechTracker aligns them to
  // the script near the cursor, advances FORWARD past a confidence gate, and
  // after a streak of misses re-anchors globally (skip / re-read — which may
  // legitimately jump the read position, incl. backward).
  const onRecognized = useCallback((words: string[]) => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    const ev = tracker.feed(words, performance.now(), Math.round(readPosRef.current));
    if (ev.kind === "reanchor") readPosRef.current = ev.pos;
  }, []);

  // ── On-device Whisper (English) — the PRIMARY driver when listening ──────
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
          onRecognized(words);
        },
        onStatus: (s) => setAsrStatus(s),
        onVoice: (v) => {
          voiceActiveRef.current = v;
        },
      });
      void asr.start(stream);
    };

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
        if (tryStart() || ++attempts > 16) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          // Mic never showed up — mark unsupported so the UI says "manual scroll"
          // and the crawl fallback takes over.
          if (!disposed && attempts > 16) setAsrStatus((s) => (s === "listening" ? s : "unsupported"));
        }
      }, 300);
    }

    return () => {
      disposed = true;
      if (pollTimer) clearInterval(pollTimer);
      asr?.stop();
      setAsrStatus("idle");
    };
  }, [active, onRecognized]);

  // ── Unified scroll loop: speech-follow (primary) + crawl (fallback) ──────
  useEffect(() => {
    let raf = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000); // clamp big gaps (tab blur)
      lastTs = now;

      if (activeRef.current && tokens.length > 0) {
        const listening = asrStatusRef.current === "listening";
        const tracker = trackerRef.current;

        // ── Recognition health ──
        // Accumulate time the user is audibly SPEAKING while recognition
        // produces no confirmed match. Silence doesn't count (holding during a
        // pause is correct). Past ~8s of voiced-but-unmatched speech, treat
        // recognition as broken on this device and fall back to the crawl so
        // the prompter NEVER freezes. A confirmed match instantly restores
        // voice-follow.
        if (listening && tracker) {
          const sinceMatch = tracker.lastMatchAtMs > 0 ? now - tracker.lastMatchAtMs : Infinity;
          if (sinceMatch < 2500) {
            voicedNoMatchMsRef.current = 0;
            if (syncLostRef.current) setSyncLost(false);
          } else if (voiceActiveRef.current) {
            voicedNoMatchMsRef.current += dt * 1000;
            if (voicedNoMatchMsRef.current > 8000 && !syncLostRef.current) setSyncLost(true);
          }
          // Absolute freeze bound: listening but NOTHING has ever matched
          // (covers a silently-dead audio tap the voice gate can't see).
          if (
            !tracker.hasSpoken &&
            !syncLostRef.current &&
            listeningSinceRef.current > 0 &&
            now - listeningSinceRef.current > 12000
          ) {
            setSyncLost(true);
          }
        }

        const followVoice = listening && tracker?.hasSpoken && !syncLostRef.current;
        if (followVoice && tracker) {
          // FOLLOW your voice. The tracker's target = last confirmed word plus
          // a speculative creep at ~85% of your measured speaking rate (capped
          // +3 words) so the highlight tracks the word you're saying NOW — but
          // never runs away. When you pause, the target stops and readPos HOLDS.
          const tgt = tracker.targetAt(now, tokens.length - 1);
          if (tgt > readPosRef.current) {
            readPosRef.current += (tgt - readPosRef.current) * Math.min(1, dt * 5);
            if (tgt - readPosRef.current < 0.05) readPosRef.current = tgt;
          }
        } else if (listening && !syncLostRef.current) {
          // Warm + listening but you haven't spoken yet → hold at the top.
        } else {
          // FALLBACK crawl (model warming / mic off / unsupported / sync lost):
          // time-based at the chosen speed.
          readPosRef.current = Math.min(
            tokens.length - 1,
            readPosRef.current + speedRef.current * dt,
          );
        }
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
  }, [tokens.length]);

  // Reset to the top whenever a new take begins.
  useEffect(() => {
    if (active) {
      readPosRef.current = 0;
      trackerRef.current?.reset(speedRef.current);
      voiceActiveRef.current = false;
      voicedNoMatchMsRef.current = 0;
      setSyncLost(false);
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
  const repinToVideo = () => setSettings((s) => ({ ...s, pos: null }));

  // Current box: manual position (if dragged) else the measured player rect.
  const fallbackBox: Box = {
    left: typeof window !== "undefined" ? window.innerWidth / 2 - 380 : 120,
    top: typeof window !== "undefined" ? window.innerHeight * 0.12 : 80,
    width: typeof window !== "undefined" ? Math.min(760, window.innerWidth * 0.92) : 760,
    height: typeof window !== "undefined" ? window.innerHeight * 0.46 : 360,
  };
  const box: Box = settings.pos ?? rect ?? fallbackBox;

  // ── Drag to reposition (header) + drag-corner to resize ──────────────────
  const dragMove = (
    e: React.PointerEvent,
    apply: (orig: Box, dx: number, dy: number) => Box,
  ) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig: Box = settings.pos ?? rect ?? fallbackBox;
    const move = (ev: PointerEvent) => {
      setSettings((s) => ({ ...s, pos: sanitizePos(apply(orig, ev.clientX - startX, ev.clientY - startY)) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    // Don't start a drag when the user is hitting a control in the header.
    if ((e.target as HTMLElement).closest("button,input")) return;
    dragMove(e, (o, dx, dy) => ({ ...o, left: o.left + dx, top: o.top + dy }));
  };
  const onResizePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    dragMove(e, (o, dx, dy) => ({ ...o, width: o.width + dx, height: o.height + dy }));
  };

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };

  // Speech-tracking status → dot colour + label so the user KNOWS what's happening.
  const asrLive = asrStatus === "listening" && !syncLost;
  const dotColor = asrLive
    ? "#46d39a"
    : asrStatus === "warming" || syncLost
      ? "#f5c451"
      : "rgba(150,160,190,0.7)";
  const statusLabel = syncLost
    ? "Auto-scroll · voice sync lost"
    : asrStatus === "listening"
      ? "Following your voice"
      : asrStatus === "warming"
        ? "Warming up…"
        : asrStatus === "unsupported"
          ? "Voice off · auto-scroll"
          : active
            ? "Auto-scroll"
            : "Ready";

  const op = settings.opacity;
  const edgeOp = Math.min(1, op + 0.1);

  const node = (
    <div
      className="teleprompter-overlay"
      style={{
        ...panelStyle,
        zIndex: OVERLAY_Z,
        display: "flex",
        flexDirection: "column",
        borderRadius: 16,
        overflow: "hidden",
        // NO backdrop-filter: blurring a live <video> underneath forces the
        // compositor to re-blur every frame — visible preview jank while
        // recording. The user-adjustable dark scrim does the readability work.
        background: `linear-gradient(180deg, rgba(6,9,18,${edgeOp}) 0%, rgba(6,9,18,${op}) 22%, rgba(6,9,18,${op}) 78%, rgba(6,9,18,${edgeOp}) 100%)`,
        boxShadow: "0 20px 70px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(120,150,230,0.22)",
        userSelect: "none",
        pointerEvents: "auto",
      }}
    >
      {/* Compact control bar — also the DRAG HANDLE (grab to reposition). */}
      <div
        onPointerDown={onHeaderPointerDown}
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          padding: "7px 10px",
          background: "rgba(10,14,28,0.72)",
          borderBottom: "1px solid rgba(120,150,230,0.18)",
          cursor: "grab",
          touchAction: "none",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: "rgba(241,244,255,0.82)", whiteSpace: "nowrap" }}>
          <Move size={12} style={{ color: "rgba(150,160,190,0.6)" }} />
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: dotColor,
              boxShadow: asrLive ? "0 0 8px #46d39a" : "none",
            }}
          />
          {statusLabel}
        </span>
        <div style={{ flex: 1, minWidth: 8 }} />

        {/* Re-pin over the video (only when manually moved) */}
        {settings.pos && (
          <button type="button" onClick={repinToVideo} style={ctrlBtn} title="Re-pin over the video">
            <Crosshair size={13} />
          </button>
        )}
        {/* Pause / play the scroll */}
        <button type="button" onClick={() => setPaused((p) => !p)} style={ctrlBtn} title={paused ? "Resume scroll" : "Pause scroll"}>
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        {/* Fallback crawl speed (used when voice tracking isn't live) */}
        <div style={chip} title="Fallback scroll speed (words per minute) — used when voice tracking isn't active">
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

        {/* Resize handle (drag to resize the panel). */}
        <div
          onPointerDown={onResizePointerDown}
          title="Drag to resize"
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 18,
            height: 18,
            cursor: "nwse-resize",
            zIndex: 2,
            background:
              "linear-gradient(135deg, transparent 50%, rgba(120,150,230,0.55) 50%, rgba(120,150,230,0.55) 62%, transparent 62%, transparent 74%, rgba(120,150,230,0.55) 74%, rgba(120,150,230,0.55) 86%, transparent 86%)",
            touchAction: "none",
          }}
        />
      </div>
    </div>
  );

  // Portal to <body> so the panel escapes any transformed player ancestor and
  // truly floats above the inline webcam self-view.
  if (typeof document === "undefined") return node;
  return createPortal(node, document.body);
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
