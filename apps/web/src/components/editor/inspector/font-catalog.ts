/**
 * Shared font catalog for the editor inspector.
 *
 * Single source of truth for the font list so the generic text editor
 * (TextSection) and the caption editor (CaptionStylePanel) never drift.
 * Every family here is preloaded as a Google webfont in apps/web/index.html,
 * so canvas rendering (preview + export) can use them immediately.
 */
export const FONT_CATEGORIES: Record<string, string[]> = {
  Popular: [
    "Inter",
    "Poppins",
    "Montserrat",
    "Roboto",
    "Open Sans",
    "Lato",
    "Outfit",
    "DM Sans",
  ],
  "Display & Headlines": [
    "Bebas Neue",
    "Anton",
    "Oswald",
    "Teko",
    "Staatliches",
    "Alfa Slab One",
    "Archivo Black",
    "Black Ops One",
    "Titan One",
    "Righteous",
    "Concert One",
    "Fredoka One",
    "Bungee",
  ],
  "Elegant & Serif": [
    "Playfair Display",
    "Cinzel",
    "Lora",
    "Merriweather",
    "DM Serif Display",
    "Abril Fatface",
    "Roboto Slab",
    "Zilla Slab",
  ],
  "Modern & Clean": [
    "Lexend",
    "Quicksand",
    "Nunito",
    "Rubik",
    "Work Sans",
    "Raleway",
    "Ubuntu",
    "Space Grotesk",
    "Comfortaa",
  ],
  "Handwritten & Script": [
    "Pacifico",
    "Lobster",
    "Dancing Script",
    "Great Vibes",
    "Caveat",
    "Sacramento",
    "Satisfy",
    "Yellowtail",
    "Rock Salt",
    "Permanent Marker",
  ],
  "Fun & Creative": ["Bangers", "Creepster", "Press Start 2P"],
  Monospace: ["Roboto Mono", "Space Mono"],
  System: ["Arial", "Helvetica", "Times New Roman", "Georgia", "Verdana"],
};

/** Flat list of every catalog font. */
export const ALL_FONTS: string[] = Object.values(FONT_CATEGORIES).flat();

/**
 * Best-effort ensure a family is ready before we paint it to canvas.
 * The font is already declared via index.html, so this just forces the
 * browser to fetch/activate it. Races a short timeout so the UI never blocks.
 */
export async function ensureFontReady(
  fontFamily: string,
  fontSize = 48,
): Promise<void> {
  try {
    await Promise.race([
      document.fonts.load(`${fontSize}px "${fontFamily}"`),
      new Promise((resolve) => setTimeout(resolve, 120)),
    ]);
  } catch {
    /* fall back to browser default */
  }
}
