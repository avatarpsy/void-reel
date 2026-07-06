/**
 * Whisper inference worker for the teleprompter.
 *
 * Runs the on-device speech model OFF the main thread. Whisper pads every
 * input to a 30-second frame, so each tick encodes a full 30s mel window —
 * on the main thread that visibly janks the live video preview and can starve
 * the UI entirely on the WASM path (no cross-origin isolation on dev = single
 * thread). In a worker the cost is invisible; WebGPU works in workers on
 * Chromium, and single-threaded WASM is fine because nothing else runs here.
 *
 * Protocol (all messages carry no callbacks — plain structured clone):
 *   in  { type: "warm" }                      — build the pipeline now
 *   in  { type: "pcm", pcm: Float32Array }    — transcribe this 16 kHz window
 *                                               (transferred, single-flight:
 *                                               dropped if inference is busy)
 *   out { type: "ready", backend }            — model built and usable
 *   out { type: "error", message }            — model failed to build
 *   out { type: "result", text, inferMs }     — one transcription finished
 *
 * Model/dtype/cache MUST stay identical to the site's composer mic
 * (useStudioVoiceInput.ts) so both share the exact same files in the
 * "transformers-cache" Cache API bucket — one download, ever, per browser.
 */

const MODEL_ID = "onnx-community/whisper-base.en";

let asrPromise: Promise<any> | null = null;
let busy = false;
let backend: "webgpu" | "wasm" = "wasm";

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    return !!(gpu?.requestAdapter && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

function getAsr(): Promise<any> {
  if (asrPromise) return asrPromise;
  const p = (async () => {
    const tf: any = await import("@huggingface/transformers");
    const { pipeline, env } = tf;
    env.allowLocalModels = false;
    if (env.useBrowserCache !== undefined) env.useBrowserCache = true;
    try {
      env.backends.onnx.wasm.proxy = false; // we ARE the worker
    } catch {
      /* shape varies by version */
    }
    const build = (device: "webgpu" | "wasm") =>
      pipeline("automatic-speech-recognition", MODEL_ID, {
        device,
        dtype:
          device === "webgpu"
            ? { encoder_model: "fp32", decoder_model_merged: "q4" }
            : { encoder_model: "fp32", decoder_model_merged: "q8" },
      });
    let asr: any;
    if (await hasWebGPU()) {
      try {
        asr = await build("webgpu");
        backend = "webgpu";
      } catch (e) {
        console.warn("[teleprompter-worker] WebGPU failed — falling back to WASM:", e);
        asr = await build("wasm");
        backend = "wasm";
      }
    } else {
      asr = await build("wasm");
      backend = "wasm";
    }
    try {
      void (navigator as any).storage?.persist?.();
    } catch {
      /* optional */
    }
    return asr;
  })();
  asrPromise = p;
  p.then(
    () => postMessage({ type: "ready", backend }),
    (e) => {
      if (asrPromise === p) asrPromise = null; // never cache a rejection
      postMessage({ type: "error", message: String((e as any)?.message ?? e) });
    },
  );
  return p;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "warm") {
    void getAsr().catch(() => {
      /* error already posted */
    });
    return;
  }

  if (msg.type === "pcm") {
    if (busy) return; // single-flight — the next window supersedes this one
    const pcm: Float32Array = msg.pcm;
    if (!(pcm instanceof Float32Array) || pcm.length < 1000) return;
    busy = true;
    const t0 = performance.now();
    try {
      const asr = await getAsr();
      const out: any = await asr(pcm, { chunk_length_s: 30, stride_length_s: 5 });
      const text = (typeof out?.text === "string" ? out.text : "").trim();
      postMessage({ type: "result", text, inferMs: Math.round(performance.now() - t0) });
    } catch {
      /* transient — next window recovers */
    } finally {
      busy = false;
    }
  }
};
