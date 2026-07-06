/**
 * On-device Whisper (English) speech-to-text for the teleprompter's
 * voice-follow scroll — main-thread CONTROLLER half.
 *
 * Why this exists: the recorder OWNS the microphone during a take, so the Web
 * Speech API (which opens its own capture) gets no audio on Chrome and never
 * fires. Instead we TAP the recorder's live mic track (a second AudioContext
 * consumer can share the same track), capture 16 kHz mono PCM into a rolling
 * window, and hand the trailing few seconds to a WORKER that re-transcribes it
 * with a local Whisper model. The recognized tail words are given back to the
 * teleprompter, which aligns them to the script (teleprompter-align.ts).
 *
 * ── Inference runs in a WORKER, never on the main thread ────────────────────
 * Whisper pads every input to a 30 s frame; transcribing that once a second on
 * the main thread visibly janks the live video preview and (on the WASM path —
 * dev has no cross-origin isolation) can starve the page so badly that results
 * effectively never surface. teleprompter-asr.worker.ts owns the pipeline; this
 * file only does cheap audio capture + messaging.
 *
 * ── Truthful status ──────────────────────────────────────────────────────────
 * "listening" is reported ONLY when the model is ready AND mic audio frames are
 * actually flowing. A capture failure reports "unsupported" and STAYS that way
 * (the old code let the async model-ready overwrite it back to green, showing
 * "Following your voice" over a dead pipeline). We also report voice ACTIVITY
 * (simple RMS gate) so the prompter can tell "user is silent" apart from
 * "user is speaking but recognition is broken" and fall back accordingly.
 *
 * ── ONE model, downloaded ONCE, silently ────────────────────────────────────
 * Same model + dtype + cache bucket as the AI-chat microphone
 * (Voidspace-Website/main/composables/studio/useStudioVoiceInput.ts):
 * onnx-community/whisper-base.en via @huggingface/transformers 3.1.1 into the
 * shared "transformers-cache" Cache API bucket. The worker reads that same
 * cache, so nothing is ever downloaded twice. `ensureWhisperModel()` prewarms
 * the worker in the background (skipped on constrained connections).
 */

export type AsrStatus =
  | "idle" // not tracking (stopped, or model failed → crawl fallback)
  | "warming" // mic tapped, Whisper model still downloading/initializing
  | "listening" // warm + audio flowing — speech drives the scroll
  | "unsupported"; // no AudioContext / mic track / capture failure

export interface AsrCallbacks {
  /** Latest recognized tail words (normalized lower-case, punctuation stripped). */
  onWords: (tailWords: string[]) => void;
  onStatus?: (status: AsrStatus) => void;
  /** Voice-activity gate (~4×/s): is the mic currently carrying speech energy? */
  onVoice?: (active: boolean) => void;
}

const SAMPLE_RATE = 16000;
// Rolling window we keep + re-transcribe. A few seconds is plenty of context to
// place the reader on the script without re-decoding the whole take each tick.
const WINDOW_SECONDS = 8;
const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS;
const MIN_SAMPLES = SAMPLE_RATE * 0.6; // < 0.6 s — too little to bother
// The trailing spoken words handed to the aligner each tick. A longer probe
// aligns more robustly against the script (more context to survive ASR slips).
const TAIL_WORDS = 10;
// RMS above this ≈ speech. With the recorder's AGC + noise suppression on the
// tapped track, speech sits ~0.02-0.2 and suppressed room noise ~0.001-0.003,
// so 0.008 keeps margin on both sides (quiet mics still register, noise doesn't).
const VOICE_RMS = 0.008;

// ── Worker singleton (one pipeline per page session; downloads once, ever) ──
let _worker: Worker | null = null;
let _workerReady = false;
let _workerFailed = false;
let _lastInferMs = 0;
const _resultListeners = new Set<(text: string) => void>();
const _readyListeners = new Set<() => void>();
const _failListeners = new Set<() => void>();

function getWorker(): Worker | null {
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL("./teleprompter-asr.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (e) {
    console.error("[teleprompter] could not start speech worker:", e);
    _workerFailed = true;
    return null;
  }
  _worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      _workerReady = true;
      _workerFailed = false;
      _readyListeners.forEach((fn) => fn());
    } else if (msg.type === "error") {
      console.error("[teleprompter] speech model failed to load:", msg.message);
      _workerFailed = true;
      _workerReady = false;
      _failListeners.forEach((fn) => fn());
    } else if (msg.type === "result") {
      if (typeof msg.inferMs === "number") _lastInferMs = msg.inferMs;
      const text = typeof msg.text === "string" ? msg.text : "";
      _resultListeners.forEach((fn) => fn(text));
    }
  };
  _worker.onerror = (e) => {
    console.error("[teleprompter] speech worker crashed:", e?.message ?? e);
    _workerFailed = true;
    _workerReady = false;
    _failListeners.forEach((fn) => fn());
  };
  return _worker;
}

/**
 * True when PROACTIVELY downloading the ~80–140 MB model would be inappropriate
 * on this connection: data-saver on, an explicitly cellular link, or a slow
 * effective type (2g/3g). On such links we DON'T prewarm — the model downloads
 * on demand when the user actually records, so mobile still works, it just
 * never spends cellular data on a model that may go unused.
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

let _ensured = false;

/**
 * Silently ensure the Whisper model is downloaded + built IN THE WORKER, in the
 * background. Idempotent and safe to call from anywhere, any number of times —
 * it coalesces onto the worker singleton and the shared browser cache, so it
 * can NEVER cause a redundant download. No UI, no progress: pure background.
 */
export function ensureWhisperModel(): void {
  if (_ensured || _workerReady) return;
  _ensured = true;
  if (shouldSkipProactiveDownload()) {
    _ensured = false; // let the first record trigger + retry the download
    return;
  }
  const kick = () => {
    const w = getWorker();
    if (w) w.postMessage({ type: "warm" });
    else _ensured = false;
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
 * start(stream), and stop() when the take ends. The worker (and its warm model)
 * outlives sessions, so retakes never re-download or re-initialize anything.
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
  private stopped = false;
  private framesSeen = 0;
  private lastVoiceTs = 0;
  private lastVoiceReported: boolean | null = null;
  private onResult = (text: string) => this.handleResult(text);
  private onReady = () => this.maybeListening();
  // Model/worker died → tell the prompter to fall back to the crawl (idle),
  // instead of leaving it stuck on "Warming up…" forever.
  private onFail = () => {
    if (!this.stopped) this.setStatus("idle");
  };
  /** Downsample factor when the context couldn't be opened at 16 kHz. */
  private decimate = 1;

  constructor(cb: AsrCallbacks) {
    this.cb = cb;
  }

  private setStatus(s: AsrStatus) {
    this.cb.onStatus?.(s);
  }

  /** Report "listening" only when BOTH the model and the audio path are live. */
  private maybeListening() {
    if (this.stopped) return;
    if (_workerReady && this.framesSeen > 0) this.setStatus("listening");
  }

  /** Begin capturing + transcribing from a live mic stream. */
  async start(stream: MediaStream): Promise<void> {
    this.stopped = false;
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx || !stream.getAudioTracks().length) {
      this.setStatus("unsupported");
      return;
    }

    this.setStatus("warming");
    _resultListeners.add(this.onResult);
    _readyListeners.add(this.onReady);
    _failListeners.add(this.onFail);
    const w = getWorker();
    if (!w || _workerFailed) {
      this.setStatus("idle"); // no worker / dead model → crawl carries the scroll
      if (!w) return;
    }
    w.postMessage({ type: "warm" });
    if (_workerReady) this.maybeListening();

    // Capture raw mono PCM. Prefer a 16 kHz context (the browser resamples for
    // us); some platforms reject non-default rates for MediaStream sources, so
    // fall back to the device rate + our own decimation. ScriptProcessor is
    // deprecated but universal, and each tick is just a small copy.
    const openCapture = (rate: number | null): boolean => {
      try {
        this.audioCtx = rate ? new Ctx({ sampleRate: rate }) : new Ctx();
        const actualRate: number = this.audioCtx!.sampleRate;
        this.decimate = Math.max(1, Math.round(actualRate / SAMPLE_RATE));
        this.sourceNode = this.audioCtx!.createMediaStreamSource(stream);
        this.procNode = this.audioCtx!.createScriptProcessor(4096, 1, 1);
        this.sinkNode = this.audioCtx!.createGain();
        this.sinkNode.gain.value = 0; // mute — we only need the processor to tick
        this.procNode.onaudioprocess = (e: AudioProcessingEvent) => {
          this.onAudio(e.inputBuffer.getChannelData(0));
        };
        this.sourceNode.connect(this.procNode);
        this.procNode.connect(this.sinkNode);
        this.sinkNode.connect(this.audioCtx!.destination);
        this.audioCtx!.resume?.().catch(() => {
          /* usually already running */
        });
        return true;
      } catch (e) {
        console.warn("[teleprompter] capture setup failed at rate", rate, e);
        this.teardownAudio();
        return false;
      }
    };
    if (!openCapture(SAMPLE_RATE) && !openCapture(null)) {
      this.setStatus("unsupported");
      return;
    }

    // If no audio frames arrive shortly, the capture path is dead — say so
    // instead of leaving a green light over a silent pipeline.
    window.setTimeout(() => {
      if (!this.stopped && this.framesSeen === 0) this.setStatus("unsupported");
    }, 2500);

    // Ship the rolling window to the worker on a cadence, adapting to how long
    // inference actually takes so we never queue-flood a slow (WASM) device.
    // SILENCE never reaches Whisper: the model notoriously HALLUCINATES words
    // ("thank you", "thanks for watching") on empty audio, which would fake
    // matches and scroll the prompter while the user isn't speaking — so we
    // only transcribe when speech energy occurred in the recent window.
    const tickMs = () => Math.min(4000, Math.max(900, _lastInferMs * 1.3));
    const tick = () => {
      if (this.stopped) return;
      const voicedRecently = performance.now() - this.lastVoiceTs < 2500;
      if (this.buffer.length >= MIN_SAMPLES && _workerReady && voicedRecently) {
        // Copy → transfer, so the rolling buffer stays intact on our side.
        const snap = this.buffer.slice();
        getWorker()?.postMessage({ type: "pcm", pcm: snap }, [snap.buffer]);
      }
      this.loopTimer = setTimeout(tick, tickMs()) as unknown as ReturnType<typeof setInterval>;
    };
    this.loopTimer = setTimeout(tick, 900) as unknown as ReturnType<typeof setInterval>;
  }

  /** Append a PCM chunk (decimating if needed), track voice activity. */
  private onAudio(chunk: Float32Array) {
    if (this.stopped) return;
    this.framesSeen++;
    if (this.framesSeen === 1) this.maybeListening();

    let mono = chunk;
    if (this.decimate > 1) {
      const out = new Float32Array(Math.floor(chunk.length / this.decimate));
      for (let i = 0; i < out.length; i++) out[i] = chunk[i * this.decimate];
      mono = out;
    }

    // RMS voice-activity gate (cheap — reuses the chunk we already have).
    let sum = 0;
    for (let i = 0; i < mono.length; i++) sum += mono[i] * mono[i];
    const rms = Math.sqrt(sum / Math.max(1, mono.length));
    const now = performance.now();
    if (rms >= VOICE_RMS) this.lastVoiceTs = now;
    const active = now - this.lastVoiceTs < 700;
    if (active !== this.lastVoiceReported) {
      this.lastVoiceReported = active;
      this.cb.onVoice?.(active);
    }

    const merged = new Float32Array(this.buffer.length + mono.length);
    merged.set(this.buffer, 0);
    merged.set(mono, this.buffer.length);
    this.buffer =
      merged.length > WINDOW_SAMPLES ? merged.subarray(merged.length - WINDOW_SAMPLES) : merged;
  }

  private handleResult(text: string) {
    if (this.stopped || !text) return;
    const words = text.split(/\s+/).map(normalizeWord).filter(Boolean).slice(-TAIL_WORDS);
    if (words.length) this.cb.onWords(words);
  }

  private teardownAudio() {
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
    if (this.loopTimer) {
      clearTimeout(this.loopTimer as unknown as number);
      this.loopTimer = null;
    }
    _resultListeners.delete(this.onResult);
    _readyListeners.delete(this.onReady);
    _failListeners.delete(this.onFail);
    this.teardownAudio();
    this.framesSeen = 0;
    this.setStatus("idle");
    // The worker (and its warm model) deliberately stays alive for the next take.
  }
}
