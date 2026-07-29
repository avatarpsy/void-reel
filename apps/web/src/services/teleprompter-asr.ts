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
 * ── This runs DURING a video recording — budget accordingly ──────────────────
 * Everything here competes with the live preview and the MediaRecorder encoder.
 * Three rules follow, and all three were learned from real jank:
 *
 *  1. CAPTURE RUNS OFF THE MAIN THREAD. An AudioWorklet
 *     (teleprompter-capture.worklet.js) does the decimation + voice-activity
 *     measure on the audio rendering thread and hands us one small frame every
 *     ~64 ms, which we drop into a preallocated RING BUFFER in place. (The
 *     previous version used a ScriptProcessorNode — main-thread callback — and
 *     rebuilt a ~512 KB Float32Array on every tick, ~11×/s of allocate-and-copy
 *     plus the GC that follows, while encoding video.) ScriptProcessor remains
 *     as a fallback for browsers without AudioWorklet, now allocation-free.
 *  2. RECOGNITION IS OCCASIONAL, NOT CONTINUOUS. A Whisper encode always costs a
 *     full 30 s mel frame no matter how short the clip. Running that every
 *     second visibly starves the preview — on WebGPU it contends for the same
 *     GPU that composites the frame, on WASM it saturates cores. We transcribe
 *     every ~3 s (adaptive) and the prompter carries the scroll in between by
 *     pacing to the measured speaking rate (teleprompter-align.ts).
 *  3. THREADED WASM IS CAPPED, NOT DISABLED. /studio is crossOriginIsolated, so
 *     onnxruntime defaults to one WASM thread PER CORE — it would take the whole
 *     machine and starve the encoder. The worker pins a small pool instead, so
 *     inference is still parallel but leaves headroom for video.
 *
 * ── Truthful status ──────────────────────────────────────────────────────────
 * "listening" is reported ONLY when the model is ready AND mic audio frames are
 * actually flowing. A capture failure reports "unsupported" and STAYS that way.
 * A model that never finishes warming hits a DEADLINE and degrades to "idle"
 * rather than sitting on amber forever over a dead pipeline. We also report
 * voice ACTIVITY (simple RMS gate) so the prompter can tell "user is silent"
 * apart from "user is speaking but recognition is broken".
 *
 * ── ONE model, downloaded ONCE, silently ────────────────────────────────────
 * Same model + dtype + cache bucket as the site-wide loader
 * (Voidspace-Website/main/lib/whisperAsr.ts, used by the AI-chat microphone):
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
// Rolling window we keep + re-transcribe. Whisper pads to a 30 s frame either
// way, so a shorter window costs the same encode but decodes less text; ~6 s is
// ample context to place the reader on the script.
const WINDOW_SECONDS = 6;
const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS;
const MIN_SAMPLES = SAMPLE_RATE * 0.6; // < 0.6 s — too little to bother
// The trailing spoken words handed to the aligner each tick. A longer probe
// aligns more robustly against the script (more context to survive ASR slips).
const TAIL_WORDS = 10;
// RMS above this ≈ speech. With the recorder's AGC + noise suppression on the
// tapped track, speech sits ~0.02-0.2 and suppressed room noise ~0.001-0.003,
// so 0.008 keeps margin on both sides (quiet mics still register, noise doesn't).
const VOICE_RMS = 0.008;
// Recognition cadence. The floor is deliberately well above the ~1 s the old
// build used: at 1 s the Whisper encode never stops running, which is exactly
// what made the recording preview stutter. The prompter's voice-paced drift
// covers the gap, so a slower cadence costs accuracy nothing and buys back the
// frame budget. Ceiling keeps a pathologically slow device from drifting blind.
const TICK_MIN_MS = 2600;
const TICK_MAX_MS = 5000;
// If the model hasn't built by now, stop claiming we're "warming up" and hand
// the prompter a truthful failure so it can show its auto-scroll fallback.
const WARM_DEADLINE_MS = 25000;

// Served as a STATIC file from public/workers/, not bundled.
// `new URL('./x.js', import.meta.url)` looks tidier but Vite inlines a small .js
// into a `data:text/javascript` URL, and `audioWorklet.addModule()` does not
// reliably accept data: URLs — the capture would silently fall back to the
// ScriptProcessor path in production while working in dev. A real file also
// keeps the worklet debuggable in devtools. BASE_URL is "/studio/" here; the
// `v` query is a deliberate cache-buster (the studio service worker serves .js
// cache-first, so a bare filename could survive a deploy by one load).
const CAPTURE_WORKLET_URL = `${import.meta.env.BASE_URL}workers/teleprompter-capture.worklet.js?v=1`;

// ── Worker singleton (one pipeline per page session; downloads once, ever) ──
let _worker: Worker | null = null;
let _workerReady = false;
let _workerFailed = false;
let _lastInferMs = 0;
/** Consecutive failed inferences — see the "inferError" branch below. */
let _inferErrors = 0;
/** `localStorage.voidspace.teleprompter.debug = "1"` → trace the whole pipeline. */
const TP_DEBUG = (() => {
  try {
    return localStorage.getItem("voidspace.teleprompter.debug") === "1";
  } catch {
    return false;
  }
})();
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
      _inferErrors = 0;
      if (TP_DEBUG) console.info(`[teleprompter] heard (${msg.inferMs}ms):`, JSON.stringify(text));
      _resultListeners.forEach((fn) => fn(text));
    } else if (msg.type === "inferError") {
      // Every window failing looks exactly like silence from the outside. Count
      // them, and after a few in a row stop pretending we're listening.
      _inferErrors++;
      if (_inferErrors === 1 || TP_DEBUG) {
        console.error("[teleprompter] transcription failing:", msg.message);
      }
      if (_inferErrors >= 3) _failListeners.forEach((fn) => fn());
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
  /** AudioWorklet capture node (preferred — runs on the audio thread). */
  private workletNode: AudioWorkletNode | null = null;
  /** ScriptProcessor fallback, used only when AudioWorklet is unavailable. */
  private procNode: ScriptProcessorNode | null = null;
  private sinkNode: GainNode | null = null;
  // Rolling 16 kHz PCM window as a preallocated RING BUFFER. `ringWrite` is the
  // next write index; `ringFilled` counts how much of it is real audio. Nothing
  // in the audio path allocates — see the header note.
  private ring = new Float32Array(WINDOW_SAMPLES);
  private ringWrite = 0;
  private ringFilled = 0;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** Rotating phase for decimation so we don't re-sample the same offset. */
  private decimPhase = 0;

  constructor(cb: AsrCallbacks) {
    this.cb = cb;
  }

  private setStatus(s: AsrStatus) {
    this.cb.onStatus?.(s);
  }

  /** Report "listening" only when BOTH the model and the audio path are live. */
  private maybeListening() {
    if (this.stopped) return;
    if (_workerReady && this.framesSeen > 0) {
      if (this.warmTimer) {
        clearTimeout(this.warmTimer);
        this.warmTimer = null;
      }
      this.setStatus("listening");
    }
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
    this.ringWrite = 0;
    this.ringFilled = 0;
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

    // A model that never finishes building must not leave the prompter on an
    // amber "Warming up…" for the whole take. Past the deadline we report the
    // truth (idle → the prompter shows its labelled auto-scroll fallback).
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      if (this.stopped || _workerReady) return;
      console.warn("[teleprompter] speech model did not warm in time — falling back to auto-scroll");
      this.setStatus("idle");
    }, WARM_DEADLINE_MS);

    // Capture raw mono PCM. Prefer a 16 kHz context (the browser resamples for
    // us); some platforms reject non-default rates for MediaStream sources, so
    // fall back to the device rate + our own decimation.
    if (!(await this.openCapture(Ctx, stream, SAMPLE_RATE)) &&
        !(await this.openCapture(Ctx, stream, null))) {
      this.setStatus("unsupported");
      return;
    }

    // If no audio frames arrive shortly, the capture path is dead — say so
    // instead of leaving a green light over a silent pipeline.
    window.setTimeout(() => {
      if (!this.stopped && this.framesSeen === 0) this.setStatus("unsupported");
    }, 2500);

    // Ship the rolling window to the worker on a cadence, adapting to how long
    // inference actually takes so we never queue-flood a slow device.
    // SILENCE never reaches Whisper: the model notoriously HALLUCINATES words
    // ("thank you", "thanks for watching") on empty audio, which would fake
    // matches and scroll the prompter while the user isn't speaking — so we
    // only transcribe when speech energy occurred in the recent window.
    const tickMs = () => Math.min(TICK_MAX_MS, Math.max(TICK_MIN_MS, _lastInferMs * 1.6));
    const tick = () => {
      if (this.stopped) return;
      const voicedRecently = performance.now() - this.lastVoiceTs < 2500;
      if (this.ringFilled >= MIN_SAMPLES && _workerReady && voicedRecently) {
        const pcm = this.snapshotWindow();
        getWorker()?.postMessage({ type: "pcm", pcm }, [pcm.buffer]);
      }
      this.loopTimer = setTimeout(tick, tickMs());
    };
    this.loopTimer = setTimeout(tick, TICK_MIN_MS);
  }

  /**
   * Open one capture graph at `rate` (null = device default).
   *
   * Preferred path: an AudioWorklet, so decimation + the RMS voice gate run on
   * the audio rendering thread and never touch the main thread's frame budget.
   * Fallback: ScriptProcessorNode (main-thread callback) for browsers without
   * AudioWorklet — still allocation-free thanks to the ring buffer, just not
   * free of main-thread work.
   */
  private async openCapture(
    Ctx: typeof AudioContext,
    stream: MediaStream,
    rate: number | null,
  ): Promise<boolean> {
    try {
      this.audioCtx = rate ? new Ctx({ sampleRate: rate }) : new Ctx();
      const ctx = this.audioCtx!;
      this.decimate = Math.max(1, Math.round(ctx.sampleRate / SAMPLE_RATE));
      this.decimPhase = 0;
      this.sourceNode = ctx.createMediaStreamSource(stream);
      // Muted sink: the graph only needs to be pulled, never heard. (Feeding the
      // mic back to the speakers during a take would be a howling loop.)
      this.sinkNode = ctx.createGain();
      this.sinkNode.gain.value = 0;

      let usingWorklet = false;
      if (ctx.audioWorklet) {
        try {
          await ctx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
          if (this.stopped) return false;
          const node = new AudioWorkletNode(ctx, "teleprompter-capture", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            // "explicit" mono: a stereo mic gets properly DOWNMIXED to one
            // channel. With the default "max" mode we'd silently read only the
            // left channel, halving the energy the voice gate sees.
            channelCount: 1,
            channelCountMode: "explicit",
            channelInterpretation: "speakers",
            processorOptions: { decimate: this.decimate },
          });
          node.port.onmessage = (e: MessageEvent) => {
            const d = e.data;
            if (!d || !(d.pcm instanceof Float32Array)) return;
            this.onFrame(d.pcm, typeof d.rms === "number" ? d.rms : 0);
          };
          this.workletNode = node;
          this.sourceNode.connect(node);
          node.connect(this.sinkNode);
          usingWorklet = true;
        } catch (e) {
          console.warn("[teleprompter] AudioWorklet unavailable — using ScriptProcessor:", e);
        }
      }

      if (!usingWorklet) {
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e: AudioProcessingEvent) => {
          this.onRawChunk(e.inputBuffer.getChannelData(0));
        };
        this.procNode = proc;
        this.sourceNode.connect(proc);
        proc.connect(this.sinkNode);
      }

      this.sinkNode.connect(ctx.destination);
      ctx.resume?.().catch(() => {
        /* usually already running */
      });
      return true;
    } catch (e) {
      console.warn("[teleprompter] capture setup failed at rate", rate, e);
      this.teardownAudio();
      return false;
    }
  }

  /**
   * Linearise the ring into a transferable Float32Array (oldest → newest).
   * This is the ONE allocation per recognizer tick (every ~3 s), not per audio
   * callback — the buffer is transferred to the worker, so it can't be pooled.
   */
  private snapshotWindow(): Float32Array {
    const n = this.ringFilled;
    const out = new Float32Array(n);
    if (n < WINDOW_SAMPLES) {
      // Not yet wrapped: samples are [0, ringWrite).
      out.set(this.ring.subarray(0, n));
      return out;
    }
    // Wrapped: oldest half is [ringWrite, end), newest is [0, ringWrite).
    const tail = WINDOW_SAMPLES - this.ringWrite;
    out.set(this.ring.subarray(this.ringWrite), 0);
    out.set(this.ring.subarray(0, this.ringWrite), tail);
    return out;
  }

  /**
   * A ready-made 16 kHz frame from the AudioWorklet (already decimated, RMS
   * already measured on the audio thread). Main-thread cost is one bounded
   * copy every ~64 ms and nothing else.
   */
  private onFrame(pcm: Float32Array, rms: number): void {
    if (this.stopped) return;
    this.framesSeen++;
    if (this.framesSeen === 1) this.maybeListening();

    const ring = this.ring;
    let w = this.ringWrite;
    for (let i = 0; i < pcm.length; i++) {
      ring[w] = pcm[i];
      w = w + 1 === WINDOW_SAMPLES ? 0 : w + 1;
    }
    this.ringWrite = w;
    this.ringFilled = Math.min(WINDOW_SAMPLES, this.ringFilled + pcm.length);
    this.reportVoice(rms);
  }

  /**
   * ScriptProcessor fallback ingest: decimate → RMS → ring write in ONE pass,
   * with no intermediate arrays. Only used where AudioWorklet is missing.
   */
  private onRawChunk(chunk: Float32Array): void {
    if (this.stopped) return;
    this.framesSeen++;
    if (this.framesSeen === 1) this.maybeListening();

    const dec = this.decimate;
    const ring = this.ring;
    let w = this.ringWrite;
    let sum = 0;
    let count = 0;

    for (let i = this.decimPhase; i < chunk.length; i += dec) {
      const s = chunk[i];
      sum += s * s;
      count++;
      ring[w] = s;
      w = w + 1 === WINDOW_SAMPLES ? 0 : w + 1;
    }
    // Carry the leftover phase so decimation doesn't jitter across callbacks.
    this.decimPhase = dec === 1 ? 0 : (this.decimPhase + chunk.length) % dec;
    this.ringWrite = w;
    this.ringFilled = Math.min(WINDOW_SAMPLES, this.ringFilled + count);
    this.reportVoice(Math.sqrt(sum / Math.max(1, count)));
  }

  /** Edge-triggered voice-activity reporting (the prompter only needs changes). */
  private reportVoice(rms: number): void {
    const now = performance.now();
    if (rms >= VOICE_RMS) this.lastVoiceTs = now;
    const active = now - this.lastVoiceTs < 700;
    if (active !== this.lastVoiceReported) {
      this.lastVoiceReported = active;
      this.cb.onVoice?.(active);
    }
  }

  private handleResult(text: string) {
    if (this.stopped || !text) return;
    const words = text.split(/\s+/).map(normalizeWord).filter(Boolean).slice(-TAIL_WORDS);
    if (words.length) this.cb.onWords(words);
  }

  private teardownAudio() {
    try {
      if (this.workletNode) {
        this.workletNode.port.onmessage = null;
        // Tell the processor to return false so the audio thread can drop it.
        this.workletNode.port.postMessage({ type: "close" });
        this.workletNode.disconnect();
      }
    } catch {
      /* noop */
    }
    this.workletNode = null;
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
    this.ringWrite = 0;
    this.ringFilled = 0;
  }

  stop() {
    this.stopped = true;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.warmTimer) {
      clearTimeout(this.warmTimer);
      this.warmTimer = null;
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
