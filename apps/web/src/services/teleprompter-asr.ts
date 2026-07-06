/**
 * On-device Whisper (English) speech-to-text for the teleprompter's auto-scroll.
 *
 * Why this exists: the recorder OWNS the microphone during a take, so the Web
 * Speech API (webkitSpeechRecognition) — which opens its own capture — gets no
 * audio on Chrome and never fires. Instead we TAP the recorder's live mic track
 * (a second AudioContext consumer can share the same track), capture 16 kHz mono
 * PCM into a rolling window, and re-transcribe the trailing few seconds ~once a
 * second with a local Whisper model. The recognized tail words are handed back
 * so the teleprompter can fuzzily align them to the script and snap the scroll
 * to where the speaker actually is.
 *
 * ── ONE model, downloaded ONCE, in the background, silently ──────────────────
 * Same model + config as the AI-chat microphone
 * (Voidspace-Website/main/composables/studio/useStudioVoiceInput.ts):
 *   • model    onnx-community/whisper-base.en
 *   • version  @huggingface/transformers 3.1.1 (identical pin)
 *   • cache    transformers.js `useBrowserCache` → the browser Cache API bucket
 *              "transformers-cache".
 * The editor is served SAME-ORIGIN as the rest of voidspace.ai (static at
 * /studio/), so that cache bucket is SHARED with every other page. The site
 * prewarms the model in the background the moment a visitor first lands, so by
 * the time anyone opens the editor the ~60 MB weights are already installed and
 * reused with ZERO re-download. `ensureWhisperModel()` here is the editor's own
 * idempotent trigger for the same download (for a visitor who deep-links
 * straight into /studio/ without touching another page first).
 *
 * There is intentionally NO user-facing "downloading / setting up model" UI:
 * the download is a silent background concern, and the teleprompter's time-based
 * crawl carries the scroll until Whisper is warm, so speech-tracking is a pure
 * ENHANCEMENT that simply switches on when the model is ready.
 *
 * WebGPU when available, WASM fallback.
 */

export type AsrStatus =
  | "idle" // not tracking (stopped, or model failed → crawl fallback)
  | "warming" // mic tapped, Whisper model still downloading/initializing
  | "listening" // warm, transcribing live — speech drives the scroll
  | "unsupported"; // no AudioContext / mic track

export interface AsrCallbacks {
  /** Latest recognized tail words (normalized lower-case, punctuation stripped). */
  onWords: (tailWords: string[]) => void;
  onStatus?: (status: AsrStatus) => void;
}

const MODEL_ID = "onnx-community/whisper-base.en";
const SAMPLE_RATE = 16000;
// Rolling window we keep + re-transcribe. A few seconds is plenty of context to
// place the reader on the script without re-decoding the whole take each tick.
const WINDOW_SECONDS = 8;
const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS;
const MIN_SAMPLES = SAMPLE_RATE * 0.6; // < 0.6 s — too little to bother
// The trailing spoken words handed to the aligner each tick. A longer probe
// aligns more robustly against the script (more context to survive ASR slips).
const TAIL_WORDS = 10;

// ── Whisper pipeline singleton (loads once per page session; downloads once ──
// per browser, into the shared "transformers-cache" bucket) ──────────────────
let _asrPromise: Promise<any> | null = null;
let _asrReady = false;
let _webgpu: boolean | null = null;
let _ensured = false;

async function hasWebGPU(): Promise<boolean> {
  if (_webgpu !== null) return _webgpu;
  try {
    const gpu = (navigator as any).gpu;
    _webgpu = !!(gpu?.requestAdapter && (await gpu.requestAdapter()));
  } catch {
    _webgpu = false;
  }
  return _webgpu;
}

function getAsr(): Promise<any> {
  if (_asrPromise) return _asrPromise;
  const p = (async () => {
    const tf: any = await import("@huggingface/transformers");
    const { pipeline, env } = tf;
    // Go straight to the HF-hosted model (skip local-path probing) and keep the
    // browser cache on so weights download exactly once, ever, into the shared
    // "transformers-cache" bucket that every voidspace.ai surface reuses.
    env.allowLocalModels = false;
    if (env.useBrowserCache !== undefined) env.useBrowserCache = true;
    try {
      env.backends.onnx.wasm.proxy = false;
    } catch {
      /* shape varies by version */
    }
    const build = (device: "webgpu" | "wasm") =>
      pipeline("automatic-speech-recognition", MODEL_ID, {
        device,
        // MUST match the composer's dtype so both request — and cache — the SAME
        // files (q4 decoder on WebGPU, q8 on WASM; fp32 encoder for accuracy).
        dtype:
          device === "webgpu"
            ? { encoder_model: "fp32", decoder_model_merged: "q4" }
            : { encoder_model: "fp32", decoder_model_merged: "q8" },
      });
    let asr: any;
    if (await hasWebGPU()) {
      try {
        asr = await build("webgpu");
      } catch (e) {
        console.warn(
          "[teleprompter] WebGPU speech pipeline failed — falling back to WASM:",
          e,
        );
        _webgpu = false;
        asr = await build("wasm");
      }
    } else {
      asr = await build("wasm");
    }
    _asrReady = true;
    // Ask the browser to keep the ~60 MB cache persistent so eviction doesn't
    // force a surprise re-download later.
    try {
      void (navigator as any).storage?.persist?.();
    } catch {
      /* optional */
    }
    return asr;
  })();
  _asrPromise = p;
  // Never cache a REJECTED promise — a one-off failure would poison every later
  // use. Clear the singleton on failure so a retry rebuilds cleanly.
  p.catch(() => {
    if (_asrPromise === p) {
      _asrPromise = null;
      _asrReady = false;
    }
  });
  return p;
}

/**
 * True when PROACTIVELY downloading the ~80–140 MB model would be inappropriate
 * on this connection: data-saver on, an explicitly cellular link, or a slow
 * effective type (2g/3g). On such links we DON'T prewarm — the model downloads
 * on demand when the user actually records (TeleprompterAsr.start() calls getAsr
 * directly and is never gated), so mobile still works, it just never spends
 * cellular data on a model that may go unused.
 */
function shouldSkipProactiveDownload(): boolean {
  try {
    const conn = (navigator as any).connection;
    if (!conn) return false; // no NetworkInformation (Safari/iOS) — allow prewarm
    if (conn.saveData) return true;
    if (conn.type === "cellular") return true;
    if (/(^|\b)(slow-2g|2g|3g)$/.test(conn.effectiveType || "")) return true;
  } catch {
    /* proceed */
  }
  return false;
}

/**
 * Silently ensure the Whisper model is downloaded + built, in the background,
 * during idle. Idempotent and safe to call from anywhere, any number of times —
 * it coalesces onto the single module singleton and the shared browser cache, so
 * it can NEVER cause a redundant download. No UI, no progress: pure background.
 * On constrained mobile links it defers to on-demand (see
 * shouldSkipProactiveDownload).
 */
export function ensureWhisperModel(): void {
  if (_ensured || _asrPromise) return;
  _ensured = true;
  if (shouldSkipProactiveDownload()) {
    _ensured = false; // let the first record trigger + retry the download
    return;
  }
  const kick = () => {
    getAsr().catch(() => {
      // Reset so a later real use (first record) retries cleanly.
      _ensured = false;
    });
  };
  const ric = (window as any).requestIdleCallback;
  if (typeof ric === "function") ric(kick, { timeout: 8000 });
  else setTimeout(kick, 1500);
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

/**
 * Controller for one live listening session. Create it when a take starts, call
 * start(stream), and stop() when the take ends. Reuses the module singleton (and
 * the shared browser cache), so no session ever triggers a redundant download.
 */
export class TeleprompterAsr {
  private cb: AsrCallbacks;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private procNode: ScriptProcessorNode | null = null;
  private sinkNode: GainNode | null = null;
  // Rolling 16 kHz PCM window (kept trimmed to WINDOW_SAMPLES).
  private buffer = new Float32Array(0);
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = false;

  constructor(cb: AsrCallbacks) {
    this.cb = cb;
  }

  private setStatus(s: AsrStatus) {
    this.cb.onStatus?.(s);
  }

  /** Begin capturing + transcribing from a live mic stream. */
  async start(stream: MediaStream): Promise<void> {
    this.stopped = false;
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx || !stream.getAudioTracks().length) {
      this.setStatus("unsupported");
      return;
    }

    // Warm the model (already cached + prewarmed in the common case, so this is
    // usually instant). Speech-tracking flips to "listening" once it's ready;
    // until then we report "warming" so the UI can say so (and fall back to a
    // gentle crawl). On failure → "idle" (crawl-only).
    this.setStatus("warming");
    void getAsr()
      .then(() => {
        if (!this.stopped) this.setStatus("listening");
      })
      .catch((e) => {
        console.error("[teleprompter] Speech model failed to load:", e);
        if (!this.stopped) this.setStatus("idle");
      });

    // Capture raw 16 kHz mono PCM directly (an AudioContext fixed at 16 kHz
    // resamples for us — no decode step). ScriptProcessor is deprecated but
    // universal and dodges the AudioWorklet CSP wrinkles; each tick is a copy.
    try {
      this.audioCtx = new Ctx({ sampleRate: SAMPLE_RATE });
      this.sourceNode = this.audioCtx!.createMediaStreamSource(stream);
      this.procNode = this.audioCtx!.createScriptProcessor(4096, 1, 1);
      this.sinkNode = this.audioCtx!.createGain();
      this.sinkNode.gain.value = 0; // mute — we only need the processor to tick
      this.procNode.onaudioprocess = (e: AudioProcessingEvent) => {
        const ch = e.inputBuffer.getChannelData(0);
        this.append(ch);
      };
      this.sourceNode.connect(this.procNode);
      this.procNode.connect(this.sinkNode);
      this.sinkNode.connect(this.audioCtx!.destination);
      this.audioCtx!.resume?.().catch(() => {
        /* usually already running */
      });
    } catch (e) {
      console.error("[teleprompter] Audio capture setup failed:", e);
      this.setStatus("unsupported");
      this.teardown();
      return;
    }

    // Re-transcribe the rolling window on a cadence. WebGPU keeps up ~every 0.9 s;
    // WASM is slower so we give it more room. Single-flight guards against pileup.
    const webgpu = await hasWebGPU();
    if (this.stopped) return;
    const intervalMs = webgpu ? 900 : 1600;
    this.loopTimer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  /** Append a PCM chunk to the rolling window, trimming to WINDOW_SAMPLES. */
  private append(chunk: Float32Array) {
    const merged = new Float32Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer =
      merged.length > WINDOW_SAMPLES ? merged.subarray(merged.length - WINDOW_SAMPLES) : merged;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy || !_asrReady) return;
    if (this.buffer.length < MIN_SAMPLES) return;
    this.busy = true;
    // Snapshot the window so incoming audio during inference doesn't mutate it.
    const pcm = this.buffer.slice();
    try {
      const asr = await getAsr();
      const out: any = await asr(pcm, { chunk_length_s: 30, stride_length_s: 5 });
      const text = (typeof out?.text === "string" ? out.text : "").trim();
      if (text && !this.stopped) {
        const words = text.split(/\s+/).map(normalizeWord).filter(Boolean).slice(-TAIL_WORDS);
        if (words.length) this.cb.onWords(words);
      }
    } catch {
      /* transient — next tick recovers */
    } finally {
      this.busy = false;
    }
  }

  private teardown() {
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    try {
      if (this.procNode) this.procNode.onaudioprocess = null as any;
    } catch {
      /* noop */
    }
    try {
      this.procNode?.disconnect();
    } catch {
      /* noop */
    }
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* noop */
    }
    try {
      this.sinkNode?.disconnect();
    } catch {
      /* noop */
    }
    this.procNode = null;
    this.sourceNode = null;
    this.sinkNode = null;
    try {
      void this.audioCtx?.close();
    } catch {
      /* noop */
    }
    this.audioCtx = null;
    this.buffer = new Float32Array(0);
  }

  stop() {
    this.stopped = true;
    this.teardown();
    this.setStatus("idle");
  }
}
