import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
        NodeJS: "readonly",
        CanvasTextAlign: "readonly",
        CanvasTextBaseline: "readonly",
        ImageBitmap: "readonly",
        OffscreenCanvas: "readonly",
        OffscreenCanvasRenderingContext2D: "readonly",
        React: "readonly",
        JSX: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "warn",
      "no-unused-vars": "off",
      "no-empty": "warn",
      "no-case-declarations": "warn",
      // ERROR, not warn. A violation of this rule is not a style opinion — it is
      // a guaranteed runtime crash the moment the render count changes, and it
      // takes a whole panel down behind its error boundary.
      //
      // It was set to "warn", and `pnpm build` runs `tsc --noEmit && vite build`
      // — never eslint. So the one tool that could see the Assets panel bug
      // reported it to nobody, for weeks, while the panel was reported as
      // "fails to load, root cause never diagnosed". (Three hooks were sitting
      // inside `renderServerTile`, a per-tile function, making LibraryPanel's
      // hook count scale with the number of assets.)
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.config.js",
      "*.config.ts",
      "vite.config.ts",
    ],
  },
];
