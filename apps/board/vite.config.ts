import { defineConfig } from 'vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import fs from 'node:fs';
import path from 'path';

/**
 * Pre-bundle every dependency BlockSuite pulls in at runtime.
 *
 * WHY THESE ARE DECLARED IN OUR package.json
 * BlockSuite ships TypeScript SOURCE, so its imports happen from files inside
 * node_modules. Vite does not auto-discover dependencies through that path, so
 * a bare specifier there resolves to the raw file — and any CommonJS one then
 * dies in the browser with "does not provide an export named 'x'". We hit that
 * with lodash.ismatch, then bind-event-listener; there are ~62 candidates.
 *
 * Two other routes were tried and do not work under pnpm:
 *   • `optimizeDeps.exclude` for @blocksuite — kills the CJS interop entirely.
 *   • the `importer > dep` form — needs the IMPORTER resolvable from this app,
 *     and 65 of the 70 @blocksuite packages are transitive here.
 *
 * So the deps are declared in this app's package.json (pinned to the versions
 * BlockSuite already resolved, so pnpm dedupes to one copy) and listed here.
 * Regenerate both on a BlockSuite upgrade — `scripts/sync-blocksuite-deps.mjs`.
 */
function blocksuiteDepIncludes(): string[] {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const own = new Set(['lit', 'yjs', 'y-indexeddb', 'y-protocols', 'rxjs']);
  return Object.keys(pkg.dependencies ?? {}).filter(
    d => !d.startsWith('@blocksuite/') && !own.has(d) && d !== '@toeverything/theme',
  );
}

export default defineConfig({
  // REQUIRED, and documented nowhere: BlockSuite authors its styles as
  // vanilla-extract `.css.ts` modules. Without this plugin every block that has
  // one throws "Styles were unable to be assigned to a file" at IMPORT time —
  // which surfaces as a suite that collects zero tests, not as a style bug.
  // It must be present for the app build and the test run alike.
  // `unstable_mode: 'transform'` matters. The plugin's DEFAULT mode evaluates
  // each `.css.ts` in a separate vite-node context to collect its styles — and
  // BlockSuite's stylesheets import BlockSuite TypeScript source, which that
  // sub-compiler does not transform, so every one dies on "Invalid or
  // unexpected token". Transform mode extracts the CSS in-place through the
  // main pipeline instead, where the source is already being handled.
  plugins: [vanillaExtractPlugin({ unstable_mode: 'transform' })],
  // Served from Voidspace-Website/main/public/board, so every asset URL must be
  // relative to /board/ — the same arrangement apps/web and apps/image use.
  base: '/board/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // SHIKI, REPLACED. `affine-inline-latex` imports it to colour a popup we
      // never show, and the real package ships every language grammar as a
      // dynamic import — ~10 MB across 300 chunk files, all of which end up in
      // `main/public/board` and in the Nuxt build's scan. The shim keeps the
      // one function that module calls. See src/shims/shiki.ts.
      shiki: path.resolve(__dirname, './src/shims/shiki.ts'),
    },
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
    // The flip side of excluding BlockSuite: its own CommonJS dependencies stop
    // being converted to ESM, and the browser fails with "does not provide an
    // export named 'default'". These are the CJS packages in BlockSuite's
    // dependency set, pre-bundled explicitly so the interop still happens.
    // BlockSuite ships TypeScript SOURCE, so its own dependencies are imported
    // from files that live under node_modules. Vite does not auto-discover deps
    // through that path, so their bare specifiers resolve to raw files — and any
    // CommonJS one then fails in the browser with "does not provide an export
    // named 'x'" (hit with lodash.ismatch, then bind-event-listener).
    //
    // Listing BlockSuite's full runtime dependency set forces each through the
    // pre-bundler, where CJS->ESM interop actually happens. Generated from the
    // `dependencies` of all 70 @blocksuite packages — see bsdeps.txt and
    // regenerate on upgrade.
    include: blocksuiteDepIncludes(),
  },
  // Downlevel DECORATORS. BlockSuite's Lit components use standard (stage-3)
  // decorators — `@requiredProperties({...})`, `@customElement(...)`. V8 does
  // not implement those yet, so if esbuild is told the target is `esnext` it
  // leaves them in place and the browser throws a bare "Invalid or unexpected
  // token" with no file, no line and no stack. `es2022` makes esbuild compile
  // them away. This applies to dev transform, dep pre-bundling AND the build,
  // hence all three below.
  esbuild: { target: 'es2022' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // BlockSuite ships as one chunk (see below). Everything else is split
        // so a version bump's size delta stays legible in the build output.
        manualChunks: (id: string) => {
          // ONE chunk for ALL of BlockSuite — do not split it.
          // Splitting by package group (core / blocks / gfx) looks tidy and
          // breaks at runtime: BlockSuite has circular imports across those
          // groups, so the chunks initialise out of order and the app dies with
          // "Cannot access 'Vx' before initialization" — a minified TDZ error
          // that points at neither the real module nor the real cause.
          if (id.includes('node_modules/@blocksuite')) return 'blocksuite';
          if (id.includes('node_modules/yjs') || id.includes('node_modules/y-')) return 'vendor-yjs';
          if (id.includes('node_modules/lit')) return 'vendor-lit';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    server: {
      deps: {
        // BlockSuite publishes TYPESCRIPT SOURCE — its exports map points at
        // `./src/index.ts`, not a built `dist`. Vitest externalises node_modules
        // by default and hands them straight to Node, which chokes on the first
        // `.ts` (and on the vanilla-extract `.css.ts` behind it). Inlining
        // routes them back through Vite's transform pipeline, where the plugin
        // above can do its job.
        inline: [/@blocksuite/],
      },
    },
  },
} as never);
