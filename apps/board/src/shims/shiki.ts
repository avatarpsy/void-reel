/**
 * A stand-in for `shiki`, aliased at build time.
 *
 * WHY: `@blocksuite/affine-inline-latex` imports `codeToTokensBase` to
 * syntax-colour the LaTeX editor's popup. The real `shiki` ships EVERY language
 * grammar as a dynamic import, so pulling it in added **~10 MB across 300 chunk
 * files** to `dist` — which then get synced into `main/public/board` and scanned
 * by the Nuxt build. (The dev-watcher OOM in §17.2 of the build plan was caused
 * by exactly this class of bulk in `public/`.)
 *
 * WHY IT IS SAFE TO REPLACE: the latex inline spec is registered because
 * `DefaultInlineManager` resolves EVERY inline spec at construction — miss one
 * and rich text stops working ANYWHERE (that was 181 identical console errors and
 * a canvas you could not type on). It is registered to satisfy that dependency,
 * not because a board has LaTeX in it: nothing on this surface inserts one, and
 * no toolbar offers it.
 *
 * So the only thing given up is syntax colouring inside a popup that cannot be
 * reached. The text still renders — one unstyled token instead of coloured ones —
 * so if a future build DOES expose LaTeX, it degrades rather than breaks.
 */

export interface ThemedToken {
  content: string;
  color?: string;
  fontStyle?: number;
  offset: number;
}

/** One token for the whole line: correct text, no colours. */
export function codeToTokensBase(code: string): Promise<ThemedToken[][]> {
  return Promise.resolve(
    String(code ?? '')
      .split('\n')
      .map(line => (line ? [{ content: line, offset: 0 }] : [])),
  );
}

export default { codeToTokensBase };
