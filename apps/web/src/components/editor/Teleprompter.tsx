import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Minus, Plus, X, Move, RotateCcw } from "lucide-react";

/**
 * Teleprompter — a professional, speech-tracked prompter overlaid on the
 * recording surface. The user writes their script up front; when recording
 * starts it projects on screen and auto-scrolls to match the words they speak.
 *
 * Tracking logic (the "pro" part):
 *   • The script is tokenized into normalized words.
 *   • Live speech (Web Speech API, continuous + interim) is tokenized the same
 *     way; the last few recognized words form a "probe".
 *   • The probe is fuzzily aligned against a FORWARD window of the script from
 *     the current position, tolerating skipped / misrecognized / extra words.
 *   • The read pointer only advances (monotonic, with a tiny back-tolerance) so
 *     interim corrections never cause jitter. A missed word just means the next
 *     match jumps ahead — tracking stays accurate.
 *   • Scrolling is eased every frame (lerp) so motion is smooth, never jumpy.
 *   • If speech recognition is unavailable, it falls back to a gentle constant
 *     crawl so the prompter still moves.
 *
 * The panel is draggable (x/y) and the text scale is adjustable; both persist.
 */

interface TeleprompterProps {
  script: string;
  /** True while actively recording (drives speech tracking + scroll). */
  active: boolean;
  onClose?: () => void;
}

interface PrompterSettings {
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

const DEFAULTS: PrompterSettings = { x: 0, y: 80, width: 720, fontSize: 40 };
const LS_KEY = "voidspace.teleprompter.settings";
// Keep the active word at this fraction down the panel ("reading line").
const READ_LINE = 0.38;

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function loadSettings(): PrompterSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export const Teleprompter: React.FC<TeleprompterProps> = ({
  script,
  active,
  onClose,
}) => {
  const [settings, setSettings] = useState<PrompterSettings>(loadSettings);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [listening, setListening] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const targetScrollRef = useRef(0);
  const currentIndexRef = useRef(0);
  currentIndexRef.current = currentIndex;

  // Tokenize the script once: display token + normalized form for matching.
  const tokens = useMemo(() => {
    const out: { display: string; norm: string }[] = [];
    for (const raw of script.split(/\s+/)) {
      if (!raw) continue;
      out.push({ display: raw, norm: normalizeWord(raw) });
    }
    return out;
  }, [script]);
  const normWords = useMemo(() => tokens.map((t) => t.norm), [tokens]);

  // Persist settings (debounced via effect).
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  // ── Forward fuzzy matcher ────────────────────────────────────────────────
  // Align the probe (recent spoken words) to the script ahead of the current
  // pointer, tolerating script-side skips. Returns the best end position or -1.
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
        // Align probe so its LAST word lands on `pos`, walking backwards and
        // allowing the script side to skip words the speaker dropped.
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
            s--; // tolerate a skipped/extra script word
          }
          scanned++;
        }
        // Reward an exact landing on the last spoken word + closeness ahead.
        const endBonus = normWords[pos] === cleanProbe[cleanProbe.length - 1] ? 0.6 : 0;
        const total = score + endBonus;
        if (total > bestScore) {
          bestScore = total;
          bestPos = pos;
        }
      }
      // Require a minimum confidence so noise doesn't fling the pointer.
      if (bestPos >= 0 && bestScore >= 1.4 && bestPos >= currentIndexRef.current - 1) {
        return bestPos;
      }
      return -1;
    },
    [normWords],
  );

  // ── Speech recognition (Web Speech API) ──────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const SR: any =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      // No speech API → gentle constant crawl fallback.
      let raf = 0;
      const start = performance.now();
      const wordsPerSec = 2.2;
      const crawl = (now: number) => {
        const elapsed = (now - start) / 1000;
        const idx = Math.min(tokens.length - 1, Math.floor(elapsed * wordsPerSec));
        if (idx !== currentIndexRef.current) setCurrentIndex(idx);
        raf = requestAnimationFrame(crawl);
      };
      raf = requestAnimationFrame(crawl);
      return () => cancelAnimationFrame(raf);
    }

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
      if (next >= 0 && next !== currentIndexRef.current) setCurrentIndex(next);
    };
    recognition.onerror = () => {
      /* transient (no-speech / aborted) — onend restarts */
    };
    recognition.onend = () => {
      // Keep listening for the whole take; the API stops itself periodically.
      if (active) {
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
      setListening(false);
      try {
        recognition.onend = null;
        recognition.stop();
      } catch {
        /* ignore */
      }
    };
  }, [active, matchProbe, tokens.length]);

  // ── Compute scroll target when the pointer moves ─────────────────────────
  useEffect(() => {
    const container = scrollRef.current;
    const el = wordRefs.current[currentIndex];
    if (!container || !el) return;
    targetScrollRef.current = Math.max(
      0,
      el.offsetTop - container.clientHeight * READ_LINE,
    );
  }, [currentIndex, settings.fontSize, settings.width]);

  // ── Eased scroll loop (smooth, never jumpy) ──────────────────────────────
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const container = scrollRef.current;
      if (container) {
        const cur = container.scrollTop;
        const target = targetScrollRef.current;
        const delta = target - cur;
        if (Math.abs(delta) > 0.5) container.scrollTop = cur + delta * 0.12;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Reset the read pointer whenever a new take begins.
  useEffect(() => {
    if (active) {
      setCurrentIndex(0);
      targetScrollRef.current = 0;
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [active]);

  // ── Drag to reposition ───────────────────────────────────────────────────
  const dragState = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const onDragStart = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, ox: settings.x, oy: settings.y };
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragState.current;
    if (!d) return;
    setSettings((s) => ({ ...s, x: d.ox + (e.clientX - d.startX), y: d.oy + (e.clientY - d.startY) }));
  };
  const onDragEnd = () => {
    dragState.current = null;
  };

  const bump = (key: keyof PrompterSettings, delta: number, min: number, max: number) =>
    setSettings((s) => ({ ...s, [key]: Math.max(min, Math.min(max, s[key] + delta)) }));

  return (
    <div
      className="teleprompter-overlay"
      style={{
        position: "fixed",
        left: "50%",
        top: 0,
        transform: `translateX(calc(-50% + ${settings.x}px)) translateY(${settings.y}px)`,
        width: settings.width,
        maxWidth: "94vw",
        zIndex: 190, // above the webcam preview (100), below the recording controls (200)
        background: "rgba(8, 11, 22, 0.82)",
        backdropFilter: "blur(6px)",
        borderRadius: 14,
        border: "1px solid rgba(120,140,200,0.35)",
        boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      {/* Control bar (also the drag handle) */}
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: "move",
          background: "rgba(255,255,255,0.05)",
          borderBottom: "1px solid rgba(120,140,200,0.25)",
          touchAction: "none",
        }}
      >
        <Move size={14} style={{ color: "rgba(241,244,255,0.55)" }} />
        <span style={{ fontSize: 11, color: "rgba(241,244,255,0.7)", fontWeight: 600 }}>
          Teleprompter{listening ? " · listening" : ""}
        </span>
        <div style={{ flex: 1 }} />
        {/* Font scale */}
        <button type="button" onClick={() => bump("fontSize", -4, 18, 120)} style={ctrlBtn} title="Smaller text">
          <Minus size={14} />
        </button>
        <span style={{ fontSize: 11, color: "rgba(241,244,255,0.6)", width: 30, textAlign: "center" }}>
          {settings.fontSize}
        </span>
        <button type="button" onClick={() => bump("fontSize", 4, 18, 120)} style={ctrlBtn} title="Bigger text">
          <Plus size={14} />
        </button>
        {/* Width */}
        <button type="button" onClick={() => bump("width", -60, 280, 1400)} style={ctrlBtn} title="Narrower">
          <span style={{ fontSize: 12, fontWeight: 700 }}>[</span>
        </button>
        <button type="button" onClick={() => bump("width", 60, 280, 1400)} style={ctrlBtn} title="Wider">
          <span style={{ fontSize: 12, fontWeight: 700 }}>]</span>
        </button>
        <button type="button" onClick={() => setSettings({ ...DEFAULTS })} style={ctrlBtn} title="Reset position & size">
          <RotateCcw size={13} />
        </button>
        {onClose && (
          <button type="button" onClick={onClose} style={ctrlBtn} title="Hide teleprompter">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Reading-line guide */}
      <div style={{ position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: `${READ_LINE * 100}%`,
            left: 0,
            right: 0,
            height: 2,
            background: "linear-gradient(90deg, transparent, rgba(91,157,255,0.55), transparent)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
        <div
          ref={scrollRef}
          style={{
            height: "42vh",
            overflow: "hidden",
            padding: "0 28px",
            // generous top/bottom pad so first/last words can reach the line
            maskImage: "linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent)",
          }}
        >
          <div style={{ height: `${READ_LINE * 42}vh` }} />
          <p
            style={{
              fontSize: settings.fontSize,
              lineHeight: 1.5,
              fontWeight: 600,
              color: "rgba(241,244,255,0.45)",
              margin: 0,
              textAlign: "center",
            }}
          >
            {tokens.map((t, i) => (
              <span
                key={i}
                ref={(el) => (wordRefs.current[i] = el)}
                style={{
                  color:
                    i < currentIndex
                      ? "rgba(241,244,255,0.32)"
                      : i === currentIndex
                        ? "#ffffff"
                        : "rgba(241,244,255,0.82)",
                  transition: "color 120ms linear",
                }}
              >
                {t.display}{" "}
              </span>
            ))}
          </p>
          <div style={{ height: "42vh" }} />
        </div>
      </div>
    </div>
  );
};

const ctrlBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 22,
  borderRadius: 6,
  border: "1px solid rgba(120,140,200,0.3)",
  background: "rgba(28,36,64,0.6)",
  color: "rgba(241,244,255,0.8)",
  cursor: "pointer",
};
