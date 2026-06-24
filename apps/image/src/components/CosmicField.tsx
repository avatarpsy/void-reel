import { useMemo } from "react";

/**
 * CosmicField — the Voidspace global "stars + moon" particle field, ported
 * 1:1 from the website's `components/voidspace/global-particles.vue` so the
 * Studio editor surfaces match the rest of voidspace.ai.
 *
 *   • dots (60%)      — round pinpricks, the bulk of the field
 *   • stars (28%)     — 4-point ✦ glyph sparkle accents
 *   • crescents (12%) — slim SVG moons ("Lord Shiva mauli"), horns-up
 *
 * Pure CSS animation, no JS loop. Deterministic seeded random so the layout
 * is stable across renders. pointer-events:none — never blocks the editor.
 * prefers-reduced-motion respected. Render it as the first child of a
 * positioned container; it fills that container (absolute inset-0).
 */

// Deterministic pseudo-random — same (seed, salt) always yields the same
// value, mirroring the Vue component so the look is identical.
function rand(seed: number, salt: number, range: number): number {
  const v = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return (v - Math.floor(v)) * range;
}

type ParticleKind = "dot" | "star" | "crescent";
const COUNT = 58;

interface Particle {
  id: number;
  kind: ParticleKind;
  style: React.CSSProperties;
}

export const CosmicField: React.FC<{ className?: string }> = ({ className }) => {
  const particles = useMemo<Particle[]>(() => {
    const out: Particle[] = [];
    for (let i = 0; i < COUNT; i++) {
      const kindRoll = rand(i, 1, 100);
      const kind: ParticleKind =
        kindRoll < 60 ? "dot" : kindRoll < 88 ? "star" : "crescent";

      // Stratified 10×6 grid placement for an even spread.
      const COLS = 10;
      const ROWS = 6;
      const col = i % COLS;
      const row = Math.floor(i / COLS) % ROWS;
      const cellLeft = (col / COLS) * 100;
      const cellTop = -10 + (row / ROWS) * 120;
      const jitterX = rand(i, 2, 8) - 4;
      const jitterY = rand(i, 3, 16) - 8;
      const left = Math.max(0, Math.min(98, cellLeft + jitterX));
      const top = cellTop + jitterY;

      const duration = 36 + rand(i, 4, 36);
      const delay = -rand(i, 5, duration);

      const baseSize =
        kind === "dot"
          ? 1.4 + rand(i, 6, 1.8)
          : kind === "star"
            ? 9 + rand(i, 6, 5)
            : 16 + rand(i, 6, 10);

      const colorRoll = rand(i, 7, 100);
      const tint =
        colorRoll < 65 ? "#e8edff" : colorRoll < 90 ? "#7eb6ff" : "#ff9ad0";

      const peakBase =
        kind === "star"
          ? 0.28 + rand(i, 8, 0.12)
          : kind === "crescent"
            ? 0.18 + rand(i, 8, 0.12)
            : 0.22 + rand(i, 8, 0.18);

      const drift = rand(i, 9, 28) - 14;
      const crescentTilt = -120 + rand(i, 10, 60);

      const style: React.CSSProperties & Record<string, string> = {
        left: `${left}%`,
        top: `${top}%`,
        color: tint,
        ["--p-color"]: tint,
        ["--p-peak"]: peakBase.toFixed(2),
        ["--p-drift"]: `${drift.toFixed(1)}px`,
        animationDuration: `${duration.toFixed(2)}s`,
        animationDelay: `${delay.toFixed(2)}s`,
      };
      if (kind === "dot") {
        style.width = `${baseSize.toFixed(2)}px`;
        style.height = `${baseSize.toFixed(2)}px`;
      } else if (kind === "star") {
        style.fontSize = `${baseSize.toFixed(2)}px`;
      } else {
        style.width = `${baseSize.toFixed(2)}px`;
        style.height = `${baseSize.toFixed(2)}px`;
        style["--p-tilt"] = `${crescentTilt.toFixed(1)}deg`;
      }

      out.push({ id: i, kind, style });
    }
    return out;
  }, []);

  return (
    <div className={`vs-cosmos ${className ?? ""}`} aria-hidden="true">
      <style>{COSMOS_CSS}</style>
      {particles.map((p) => (
        <span
          key={p.id}
          className={`vs-cosmos__p vs-cosmos__p--${p.kind}`}
          style={p.style}
        >
          {p.kind === "star" ? (
            "✦"
          ) : p.kind === "crescent" ? (
            <svg className="vs-cosmos__moon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M 17 5 A 8.5 8.5 0 1 0 17 19 A 8 8 0 1 1 17 5 Z" fill="currentColor" />
            </svg>
          ) : null}
        </span>
      ))}
    </div>
  );
};

const COSMOS_CSS = `
.vs-cosmos { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 0; }
.vs-cosmos__p {
  position: absolute; display: inline-block; will-change: transform, opacity;
  animation-name: vs-cosmos-drift; animation-timing-function: linear;
  animation-iteration-count: infinite; animation-fill-mode: both; opacity: 0;
  mix-blend-mode: screen;
}
.vs-cosmos__p--dot {
  border-radius: 50%; background: var(--p-color, #e8edff);
  box-shadow: 0 0 3px 0 var(--p-color, rgba(232,237,255,0.5)), 0 0 6px 0 rgba(255,255,255,0.12);
}
.vs-cosmos__p--star {
  font-family: 'Segoe UI Symbol', 'Apple Symbols', 'Noto Sans Symbols 2', sans-serif;
  font-weight: 100; line-height: 1; text-shadow: 0 0 5px var(--p-color, rgba(232,237,255,0.5));
}
.vs-cosmos__p--crescent { position: absolute; background: transparent; border-radius: 0; box-shadow: none; }
.vs-cosmos__moon {
  display: block; width: 100%; height: 100%; color: var(--p-color, #e8edff);
  filter: drop-shadow(0 0 2px var(--p-color, rgba(232,237,255,0.55)));
  transform: rotate(var(--p-tilt, -90deg));
}
@keyframes vs-cosmos-drift {
  0%   { transform: translate3d(0,0,0) scale(0.85); opacity: 0; }
  8%   { opacity: var(--p-peak, 0.30); }
  92%  { opacity: var(--p-peak, 0.30); }
  100% { transform: translate3d(var(--p-drift, 0px), -110vh, 0) scale(1); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .vs-cosmos__p { animation: none; opacity: var(--p-peak, 0.30); }
}
@media (min-width: 381px) and (max-width: 768px) {
  .vs-cosmos__p:nth-child(2n) { display: none; }
  .vs-cosmos__p--star { text-shadow: none; }
  .vs-cosmos__moon { filter: none; }
}
@media (max-width: 380px) {
  .vs-cosmos__p:not(:nth-child(5n)) { display: none; }
  .vs-cosmos__p--star { text-shadow: none; }
  .vs-cosmos__moon { filter: none; }
}
`;

export default CosmicField;
