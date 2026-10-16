import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  base: "/studio/",
  plugins: [react()],
  assetsInclude: ["**/*.wasm"],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@openreel/core": path.resolve(__dirname, "../../packages/core/src"),
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // transformers.js (on-device Whisper for the teleprompter) ships its own
    // WASM + worker glue — pre-bundling it breaks those; load it as-is, lazily.
    exclude: [
      "@ffmpeg/ffmpeg",
      "@ffmpeg/util",
      "@ffmpeg/core",
      "@ffmpeg/core-mt",
      "@huggingface/transformers",
    ],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      // Two pages in one dist: the editor (index.html) and the board's one-shot
      // recorder (record.html → /studio/record.html), which must stay light —
      // it imports the recorder and teleprompter modules, never the editor App.
      input: {
        index: path.resolve(__dirname, "index.html"),
        record: path.resolve(__dirname, "record.html"),
      },
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "react";
          }
          if (id.includes("node_modules/zustand")) {
            return "zustand";
          }
          if (id.includes("node_modules/three")) {
            return "three";
          }
          if (id.includes("node_modules/@radix-ui")) {
            return "radix";
          }
          // Keep the Whisper stack (transformers.js + onnxruntime-web) in its
          // own lazily-loaded chunk so it never weighs down the editor's initial
          // load — it's fetched only when the teleprompter starts recording.
          if (
            id.includes("node_modules/@huggingface/transformers") ||
            id.includes("node_modules/onnxruntime")
          ) {
            return "whisper";
          }
        },
      },
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
