/**
 * SunoAudioPanel — AI audio operations for a selected audio clip.
 *
 * Surfaces the Suno (via Kie) audio toolkit in the inspector. Every op
 * runs server-side through /api/studio/suno-op, which charges Voidspace
 * credits on success and returns the produced track(s). Results download
 * through the same-origin media proxy, import into the media library, and
 * drop onto a fresh audio track (new-track placement) — and carry their
 * Suno lineage so the Suno-native ops (separate / WAV / lyrics) light up.
 *
 *   Works on ANY audio (uploads the clip first):
 *     • Cover            – re-sing the melody in a new style (AI voice)
 *     • Extend           – continue past its end
 *     • Add Vocals       – sing over an instrumental
 *     • Add Instrumental – back an acapella
 *   Needs a Suno-origin source (taskId + audioId on the media item):
 *     • Convert to WAV   – lossless export
 *     • Timestamped Lyrics – word-synced captions
 *     • Artist Persona   – reusable identity for later releases
 */

import React, { useCallback, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  ChevronDown,
  Loader2,
  Music2,
  Mic2,
  Music4,
  Scissors,
  FileAudio2,
  Captions,
  Sparkles,
  Coins,
  Lock,
  AlertTriangle,
  Plus,
  CornerDownRight,
  Library,
  X,
  Play,
  Pause,
  Check,
  Replace,
  Piano,
  UserRoundPen,
  Layers,
  Wand2,
} from "lucide-react";
import { Input, Switch } from "@openreel/ui";
import { useProjectStore } from "../../../stores/project-store";
import { transcribeViaVoidspace } from "../../../services/voidspace-transcribe";
import { loadMediaBlob } from "../../../services/media-storage";
import { toast } from "../../../stores/notification-store";
import {
  SUNO_OP_COST,
  separateCost,
  ADVANCED_STEM_NAMES,
  uploadClipAudio,
  coverClip,
  extendClipUpload,
  extendClipNative,
  addVocalsToClip,
  addInstrumentalToClip,
  separateClipStems,
  replaceClipSection,
  transcribeToMidi,
  createPersona,
  convertClipToWav,
  getClipTimestampedLyrics,
  boostStyleText,
  importResultToLibrary,
  placeMedia,
  clipPlacementContext,
  proxiedMediaUrl,
  type SunoOp,
  type SeparateType,
  type PlacementMode,
} from "../../../services/suno";

/** One produced audio take (a variation or a stem). */
interface Take {
  id: string;
  url: string;
  name: string;
  /** Suno per-track id — becomes the placed clip's sunoAudioId lineage. */
  audioId?: string;
  /** Library media id, set as soon as the take is saved (see runTracksOp). */
  mediaId?: string;
}

/** A group of produced takes awaiting a user placement decision. */
interface PendingGroup {
  id: string;
  op: SunoOp;
  /** true → variations of the SAME thing: audition + pick ONE. false → place each (stems / single WAV). */
  pickOne: boolean;
  /** Suno task id that owns these takes (lineage for the placed clip). */
  taskId?: string;
  takes: Take[];
  /** Selected take id (pickOne groups only). */
  selectedTakeId?: string;
  /** Placement in progress. */
  placing?: boolean;
}

/**
 * Default `audioWeight` for the ops that exist to transform the user's OWN
 * recording (cover / extend-from-upload). 0.78 keeps the sung melody and
 * phrasing clearly recognisable while still letting the new style land.
 */
const SOURCE_LED_AUDIO_WEIGHT = 0.78;

/**
 * The Suno models still served upstream. Suno discontinued the entire pre-V6
 * line (V4 · V4_5 · V4_5PLUS · V4_5ALL · V5 · V5_5), so offering one here would
 * hand the user a button that 422s. The server normalises any retired id it
 * receives, which is what keeps an older loaded bundle working mid-deploy.
 */
const SUNO_MODELS = ["V6", "V6_MINI", "V6_WILD"] as const;
type SunoModel = (typeof SUNO_MODELS)[number];

/** Button labels. Spelled out rather than derived: the old string-munging
 *  (`V`→`v`, `_`→`.`, `PLUS`→`+`) turned "V6_MINI" into "v6.MINI". */
const SUNO_MODEL_LABELS: Record<SunoModel, string> = {
  V6: "v6",
  V6_MINI: "v6 Mini",
  V6_WILD: "v6 Wild",
};

interface SunoAudioPanelProps {
  clipId: string;
}

interface OpRowProps {
  id: SunoOp;
  icon: React.ElementType;
  title: string;
  cost: number;
  open: boolean;
  busy: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onToggle: () => void;
  children: React.ReactNode;
}

const OpRow: React.FC<OpRowProps> = ({
  id,
  icon: Icon,
  title,
  cost,
  open,
  busy,
  disabled,
  disabledHint,
  onToggle,
  children,
}) => (
  <div className="rounded-lg border border-border bg-background-tertiary overflow-hidden">
    <button
      onClick={onToggle}
      disabled={disabled}
      title={disabled ? disabledHint : undefined}
      className={`w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors ${
        disabled
          ? "opacity-50 cursor-not-allowed"
          : "hover:bg-background-elevated"
      }`}
      data-suno-op={id}
    >
      <Icon size={13} className="text-primary shrink-0" />
      <span className="text-[11px] font-medium text-text-primary flex-1 truncate">
        {title}
      </span>
      {busy ? (
        <Loader2 size={12} className="animate-spin text-primary" />
      ) : disabled ? (
        <Lock size={11} className="text-text-muted" />
      ) : (
        <span className="flex items-center gap-0.5 text-[9px] text-text-muted">
          <Coins size={9} />
          {cost}
        </span>
      )}
      {!disabled && (
        <ChevronDown
          size={12}
          className={`text-text-muted transition-transform ${open ? "" : "-rotate-90"}`}
        />
      )}
    </button>
    {open && !disabled && (
      <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-border">
        {children}
      </div>
    )}
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="space-y-1">
    <label className="text-[9px] text-text-secondary block">{label}</label>
    {children}
  </div>
);

const RunButton: React.FC<{
  busy: boolean;
  disabled?: boolean;
  cost: number;
  label: string;
  onClick: () => void;
}> = ({ busy, disabled, cost, label, onClick }) => (
  <button
    onClick={onClick}
    disabled={busy || disabled}
    className="w-full py-2 bg-primary hover:bg-primary/80 text-black rounded-lg text-[11px] font-medium transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
  >
    {busy ? (
      <>
        <Loader2 size={12} className="animate-spin" /> Working…
      </>
    ) : (
      <>
        <Sparkles size={12} /> {label} · {cost}cr
      </>
    )}
  </button>
);

const inputCls =
  "w-full px-2 py-1.5 text-[11px] bg-background-secondary rounded-md border border-border focus:border-primary focus:outline-none";

type Weight = number | "";

/** A 0–1 tuning slider that can be left UNSET (empty → param omitted). */
const WeightSlider: React.FC<{ label: string; value: Weight; onChange: (v: Weight) => void }> = ({
  label,
  value,
  onChange,
}) => (
  <Field label={label}>
    <div className="flex items-center gap-1.5">
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value === "" ? 0.65 : value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-primary h-1"
      />
      <span className="text-[9px] text-text-secondary w-7 text-right tabular-nums">
        {value === "" ? "auto" : Number(value).toFixed(2)}
      </span>
      <button
        onClick={() => onChange("")}
        title="Reset to auto"
        className="text-text-muted hover:text-text-primary shrink-0"
      >
        <X size={10} />
      </button>
    </div>
  </Field>
);

/** Shared "Advanced (optional)" controls — negativeTags, voice, and the three
 *  0–1 weights. Kie accepts these on cover / extend / add-vocals /
 *  add-instrumental; values left at "auto" are omitted from the request. */
const AdvancedFields: React.FC<{
  negativeTags: string;
  setNegativeTags: (v: string) => void;
  vocalGender: "" | "m" | "f";
  setVocalGender: (v: "" | "m" | "f") => void;
  styleWeight: Weight;
  setStyleWeight: (v: Weight) => void;
  weirdness: Weight;
  setWeirdness: (v: Weight) => void;
  audioWeight: Weight;
  setAudioWeight: (v: Weight) => void;
  negativeHint?: string;
}> = (p) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border/60 bg-background-secondary/30 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-2 py-1.5 text-[9px] text-text-secondary hover:text-text-primary transition-colors"
      >
        <span>Advanced{p.negativeTags.trim() ? " · negative tags set" : " (optional)"}</span>
        <ChevronDown size={11} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="px-2 pb-2 pt-0.5 space-y-2 border-t border-border/60">
          <Field label="Avoid (negative tags)">
            <Input
              value={p.negativeTags}
              onChange={(e) => p.setNegativeTags(e.target.value)}
              placeholder={p.negativeHint ?? "styles to exclude — e.g. heavy metal, autotune"}
              className="h-7 text-[11px] bg-background-secondary border-border"
            />
          </Field>
          <Field label="Voice">
            <div className="flex gap-1">
              {([
                ["", "Any"],
                ["f", "Female"],
                ["m", "Male"],
              ] as const).map(([v, label]) => (
                <button
                  key={label}
                  onClick={() => p.setVocalGender(v)}
                  className={`flex-1 py-1 rounded text-[9px] transition-colors ${
                    p.vocalGender === v
                      ? "bg-primary text-black font-medium"
                      : "bg-background-secondary text-text-muted hover:text-text-primary border border-border"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <WeightSlider label="Style weight" value={p.styleWeight} onChange={p.setStyleWeight} />
          <WeightSlider label="Weirdness" value={p.weirdness} onChange={p.setWeirdness} />
          <WeightSlider label="Audio weight" value={p.audioWeight} onChange={p.setAudioWeight} />
        </div>
      )}
    </div>
  );
};

export const SunoAudioPanel: React.FC<SunoAudioPanelProps> = ({ clipId }) => {
  const getClip = useProjectStore((s) => s.getClip);
  const getMediaItem = useProjectStore((s) => s.getMediaItem);
  const addSubtitle = useProjectStore((s) => s.addSubtitle);

  const clip = getClip(clipId);
  const mediaItem = clip ? getMediaItem(clip.mediaId) : undefined;

  const hasLineage = !!(mediaItem?.sunoTaskId && mediaItem?.sunoAudioId);

  const [openOp, setOpenOp] = useState<SunoOp | null>(null);
  const [busy, setBusy] = useState<SunoOp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingGroup[]>([]);
  const [playingTakeId, setPlayingTakeId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Audition a take through the same-origin proxy (CORS/CSP-safe).
  const togglePlay = useCallback((take: Take) => {
    const el = audioRef.current;
    if (!el) return;
    if (playingTakeId === take.id) {
      el.pause();
      setPlayingTakeId(null);
      return;
    }
    el.src = proxiedMediaUrl(take.url);
    el.play().then(() => setPlayingTakeId(take.id)).catch(() => setPlayingTakeId(null));
  }, [playingTakeId]);

  // Shared model + per-op fields
  const [model, setModel] = useState<SunoModel>("V6");
  const [coverPrompt, setCoverPrompt] = useState("");
  const [coverStyle, setCoverStyle] = useState("");
  const [coverTitle, setCoverTitle] = useState("");
  const [coverInstrumental, setCoverInstrumental] = useState(false);
  /** false = "keep my melody, I'm not supplying lyrics" (the common case);
   *  true  = the big field holds the actual lyrics to sing. */
  const [coverLyricsMode, setCoverLyricsMode] = useState(false);
  /** True while we read the sung words out of the recording. */
  const [transcribing, setTranscribing] = useState(false);
  /** What we heard — shown back so the user can correct a bad transcript. */
  const [detectedLyrics, setDetectedLyrics] = useState<string | null>(null);
  const clipDuration = clip?.duration ?? 0;
  const [extendAt, setExtendAt] = useState<number>(
    Math.max(0, Math.round(clipDuration * 10) / 10),
  );
  const [extendPrompt, setExtendPrompt] = useState("");
  const [extendInstrumental, setExtendInstrumental] = useState(false);

  const [vocalPrompt, setVocalPrompt] = useState("");
  const [vocalStyle, setVocalStyle] = useState("");
  const [vocalTitle, setVocalTitle] = useState("");
  const [vocalGender, setVocalGender] = useState<"" | "m" | "f">("");

  const [instTags, setInstTags] = useState("");
  const [instTitle, setInstTitle] = useState("");

  // Separation depth. separate_vocal is the cheap 2-stem split; split_stem
  // returns up to 12 instrument stems; split_stem_advanced pulls ONE named part.
  const [separateType, setSeparateType] = useState<SeparateType>("separate_vocal");
  const [stemName, setStemName] = useState<string>("Bass");
  /** Separation task id from the last split — MIDI transcription needs it. */
  const [separationTaskId, setSeparationTaskId] = useState<string | null>(null);

  // Replace-section
  const [rsStart, setRsStart] = useState<number>(0);
  const [rsEnd, setRsEnd] = useState<number>(0);
  const [rsPrompt, setRsPrompt] = useState("");
  const [rsTags, setRsTags] = useState("");
  const [rsTitle, setRsTitle] = useState("");
  const [rsLyrics, setRsLyrics] = useState("");

  // Persona
  const [personaName, setPersonaName] = useState("");
  const [personaDesc, setPersonaDesc] = useState("");
  const [personaStart, setPersonaStart] = useState<number>(0);
  const [personaEnd, setPersonaEnd] = useState<number>(30);
  const [personaId, setPersonaId] = useState<string | null>(null);

  const [extendStyle, setExtendStyle] = useState("");
  const [extendTitle, setExtendTitle] = useState("");

  // Shared "Advanced" tuning — applies to whichever track op is run. Kie
  // accepts these on cover / extend / add-vocals / add-instrumental; values
  // left unset are omitted from the request.
  const [negativeTags, setNegativeTags] = useState("");
  const [styleWeight, setStyleWeight] = useState<Weight>("");
  const [weirdness, setWeirdness] = useState<Weight>("");
  const [audioWeight, setAudioWeight] = useState<Weight>("");

  /** The advanced params to spread into a track op's request. */
  const advancedParams = useCallback(
    (): Record<string, unknown> => ({
      negativeTags: negativeTags.trim() || undefined,
      vocalGender: vocalGender || undefined,
      styleWeight: styleWeight === "" ? undefined : Number(styleWeight),
      weirdnessConstraint: weirdness === "" ? undefined : Number(weirdness),
      audioWeight: audioWeight === "" ? undefined : Number(audioWeight),
    }),
    [negativeTags, vocalGender, styleWeight, weirdness, audioWeight],
  );

  /**
   * Params for the ops whose whole point is "keep MY performance".
   *
   * `audioWeight` is what tells Suno how much the uploaded audio should drive
   * the result. Leaving it unset (our old "auto") let Suno weight the text
   * prompt far above the recording, so a cover came back as a track built from
   * the description with the singer's take ignored. These ops are meaningless
   * without the source, so they default the knob HIGH; an explicit user value
   * still wins.
   */
  const sourceLedParams = useCallback(
    (): Record<string, unknown> => ({
      ...advancedParams(),
      audioWeight: audioWeight === "" ? SOURCE_LED_AUDIO_WEIGHT : Number(audioWeight),
    }),
    [advancedParams, audioWeight],
  );

  /** Shared <AdvancedFields> bound to the panel's advanced state. */
  const renderAdvanced = (negativeHint?: string) => (
    <AdvancedFields
      negativeTags={negativeTags}
      setNegativeTags={setNegativeTags}
      vocalGender={vocalGender}
      setVocalGender={setVocalGender}
      styleWeight={styleWeight}
      setStyleWeight={setStyleWeight}
      weirdness={weirdness}
      setWeirdness={setWeirdness}
      audioWeight={audioWeight}
      setAudioWeight={setAudioWeight}
      negativeHint={negativeHint}
    />
  );

  const toggle = useCallback(
    (op: SunoOp) => setOpenOp((cur) => (cur === op ? null : op)),
    [],
  );

  const fail = useCallback((e: unknown) => {
    if (e instanceof DOMException && e.name === "AbortError") return;
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    toast.error("AI audio failed", msg.slice(0, 140));
  }, []);

  /** Run a track-producing op (returns tracks + taskId), import each result. */
  const runTracksOp = useCallback(
    async (
      op: SunoOp,
      label: string,
      call: (
        signal: AbortSignal,
      ) => Promise<{
        result: { tracks: Array<{ url: string; audioId: string; title?: string }>; taskId: string };
        charged: number;
        balance: number;
      }>,
    ) => {
      if (busy) return;
      setBusy(op);
      setError(null);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const r = await call(ac.signal);
        const tracks = r.result.tracks || [];
        if (!tracks.length) throw new Error("No audio was produced.");
        const takes: Take[] = tracks.map((t, i) => ({
          id: uuidv4(),
          url: t.url,
          name: t.title ? `${t.title}${tracks.length > 1 ? ` (v${i + 1})` : ""}` : `${label} v${i + 1}`,
          audioId: t.audioId,
        }));

        // SAVE EVERY TAKE IMMEDIATELY, before asking where to put it.
        //
        // These are paid generations and Suno's URLs expire in ~14 days. The
        // panel used to hold them in component state only, so selecting a
        // different clip unmounted it and silently threw away work the user
        // had just paid for. Importing here writes them to the media library +
        // local disk, so they survive deselect, reload and URL expiry, and the
        // placement chooser below becomes a convenience rather than the only
        // chance to keep them. Best-effort: a failed import must not lose the
        // audition URLs we already have.
        await Promise.all(
          takes.map(async (take) => {
            try {
              const lineage = r.result.taskId
                ? { sunoTaskId: r.result.taskId, sunoAudioId: take.audioId }
                : {};
              take.mediaId = await importResultToLibrary(take.url, take.name, lineage, ac.signal);
            } catch (e) {
              console.warn("[suno] library save failed for", take.name, e);
            }
          }),
        );
        // Multiple tracks from one op = variations of the SAME thing → pick one.
        const group: PendingGroup = {
          id: uuidv4(),
          op,
          pickOne: takes.length > 1,
          taskId: r.result.taskId,
          takes,
          selectedTakeId: takes.length === 1 ? takes[0].id : undefined,
        };
        setPending((p) => [...p, group]);
        setBalance(r.balance);
        const saved = takes.filter((t) => t.mediaId).length;
        toast.success(
          `${label} ready`,
          `${takes.length > 1 ? `${takes.length} versions · ` : ""}` +
            `${saved === takes.length ? "saved to your library" : `${saved}/${takes.length} saved`}` +
            ` · ${r.charged} credits`,
        );
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [busy, fail],
  );

  const dismissGroup = useCallback((groupId: string) => {
    if (audioRef.current) audioRef.current.pause();
    setPlayingTakeId(null);
    setPending((p) => p.filter((g) => g.id !== groupId));
  }, []);

  const selectTake = useCallback((groupId: string, takeId: string) => {
    setPending((p) => p.map((g) => (g.id === groupId ? { ...g, selectedTakeId: takeId } : g)));
  }, []);

  /**
   * Place one take from a group per the chosen mode (lazy download).
   * For pickOne groups the whole group is consumed (other takes discarded).
   * For place-each groups only that take is removed.
   */
  const placeTake = useCallback(
    async (group: PendingGroup, take: Take, mode: PlacementMode) => {
      if (audioRef.current) audioRef.current.pause();
      setPlayingTakeId(null);
      setPending((p) => p.map((g) => (g.id === group.id ? { ...g, placing: true } : g)));
      try {
        // Already saved by runTracksOp — reuse it instead of downloading and
        // importing the same audio a second time.
        const lineage = group.taskId ? { sunoTaskId: group.taskId, sunoAudioId: take.audioId } : {};
        const mediaId = take.mediaId ?? (await importResultToLibrary(take.url, take.name, lineage));
        const ctx = clipPlacementContext(clipId);
        if (mode === "after-clip" && ctx) {
          await placeMedia(mediaId, "after-clip", { trackId: ctx.trackId, startTime: ctx.endTime });
        } else if (mode === "library") {
          await placeMedia(mediaId, "library");
        } else {
          await placeMedia(mediaId, "new-track", { startTime: ctx?.startTime });
        }
        // pickOne → consume the whole group; place-each → drop just this take.
        setPending((p) =>
          p.flatMap((g) => {
            if (g.id !== group.id) return [g];
            if (group.pickOne) return [];
            const takes = g.takes.filter((t) => t.id !== take.id);
            return takes.length ? [{ ...g, takes, placing: false }] : [];
          }),
        );
        toast.success(
          mode === "library" ? "Saved to library" : mode === "after-clip" ? "Placed after clip" : "Placed on new track",
          take.name,
        );
      } catch (e) {
        setPending((p) => p.map((g) => (g.id === group.id ? { ...g, placing: false } : g)));
        fail(e);
      }
    },
    [clipId, fail],
  );

  /**
   * Drop EVERY take in a group onto its own new audio track, all aligned to
   * the source clip's start. This is what makes a 12-stem split usable: the
   * one-at-a-time flow would be a dozen manual placements, and the stems have
   * to stay time-aligned or the track no longer reassembles.
   *
   * Sequential on purpose — each placement mutates the project store, and
   * firing them together races the track-creation step.
   */
  const placeAllStems = useCallback(
    async (group: PendingGroup) => {
      if (audioRef.current) audioRef.current.pause();
      setPlayingTakeId(null);
      setPending((p) => p.map((g) => (g.id === group.id ? { ...g, placing: true } : g)));
      const ctx = clipPlacementContext(clipId);
      let placed = 0;
      try {
        for (const take of group.takes) {
          const mediaId = await importResultToLibrary(take.url, take.name);
          await placeMedia(mediaId, "new-track", { startTime: ctx?.startTime });
          placed++;
        }
        setPending((p) => p.filter((g) => g.id !== group.id));
        toast.success("Stems placed", `${placed} track${placed === 1 ? "" : "s"}, aligned to the original`);
      } catch (e) {
        // Keep whatever is left so a mid-way failure doesn't lose the results
        // the user already paid for.
        setPending((p) =>
          p.map((g) => (g.id === group.id ? { ...g, takes: g.takes.slice(placed), placing: false } : g)),
        );
        fail(e);
      }
    },
    [clipId, fail],
  );

  // ── op handlers ──────────────────────────────────────────────────────────
  /**
   * Re-sing the take in a new style.
   *
   * CUSTOM MODE IS MANDATORY HERE, and that is not a detail. Suno's non-custom
   * upload-cover documents that "lyrics will be auto-generated (not strictly
   * matching the input)" — it discards what the singer actually sang — and it
   * ignores `duration`, which is how a 55s take came back as a 4-minute track
   * about nothing. Custom mode needs real lyrics, so when the user asked to
   * KEEP THEIR WORDS we go and get them: transcribe the recording first and
   * feed that transcript in as the lyrics.
   */
  const handleCover = useCallback(() => {
    if (!mediaItem) return;
    const style = coverStyle.trim() || coverPrompt.trim();
    if (!style) {
      setError("Describe the style you want.");
      return;
    }
    if (coverLyricsMode && !coverPrompt.trim()) {
      setError("Type the lyrics to sing, or switch to “Keep my words”.");
      return;
    }
    runTracksOp("cover", "Cover", async (signal) => {
      const uploadUrl = await uploadClipAudio(mediaItem, signal);

      let lyrics = coverPrompt.trim();
      if (!coverLyricsMode) {
        // Keep-my-words: the lyrics live in the audio, so read them out of it.
        setTranscribing(true);
        try {
          const blob =
            mediaItem.blob instanceof Blob
              ? mediaItem.blob
              : await loadMediaBlob(mediaItem.id);
          if (!blob) throw new Error("no local audio");
          const r = await transcribeViaVoidspace(blob);
          lyrics = (r.text || "").trim();
        } catch (e) {
          console.warn("[suno] lyric transcription failed:", e);
          lyrics = "";
        } finally {
          setTranscribing(false);
        }
        if (!lyrics) {
          throw new Error(
            "Could not make out any words in this recording, so a cover would invent its own. " +
              "Switch to “New lyrics” and type them, or turn on “Instrumental only”.",
          );
        }
        setDetectedLyrics(lyrics);
      }

      return coverClip(
        uploadUrl,
        {
          prompt: lyrics,
          model,
          instrumental: coverInstrumental,
          style,
          // Custom mode needs a title; the clip name is a fine default and
          // saves the user a required field they do not care about.
          title: coverTitle.trim() || mediaItem.name || "Cover",
          // We are always supplying real lyrics now, so this is always custom.
          lyricsMode: true,
          // Without this a cover comes back 20 seconds long — that is the
          // upstream default when `duration` is omitted, not the source length.
          sourceDurationSec:
            mediaItem.metadata?.duration || clip?.duration || undefined,
          ...sourceLedParams(),
        },
        signal,
      );
    });
  }, [mediaItem, clip, coverPrompt, coverStyle, coverTitle, coverInstrumental, coverLyricsMode, model, runTracksOp, sourceLedParams]);

  const handleExtend = useCallback(() => {
    if (!mediaItem) return;
    runTracksOp("extend", "Extension", async (signal) => {
      const params = {
        continueAt: Number(extendAt) || 0,
        model,
        prompt: extendPrompt.trim() || undefined,
        instrumental: extendInstrumental,
        style: extendStyle.trim() || undefined,
        title: extendTitle.trim() || undefined,
        ...advancedParams(),
      };
      if (mediaItem.sunoTaskId && mediaItem.sunoAudioId) {
        // Native extend gives the cleanest seam — reuse Suno's own track.
        return extendClipNative(mediaItem.sunoAudioId, params, signal);
      }
      const uploadUrl = await uploadClipAudio(mediaItem, signal);
      return extendClipUpload(uploadUrl, params, signal);
    });
  }, [mediaItem, extendAt, extendPrompt, extendInstrumental, extendStyle, extendTitle, model, runTracksOp, advancedParams]);

  const handleAddVocals = useCallback(() => {
    if (!mediaItem) return;
    if (!vocalPrompt.trim()) {
      setError("Add a lyric direction or the lyrics to sing.");
      return;
    }
    runTracksOp("add_vocals", "Vocals", async (signal) => {
      const uploadUrl = await uploadClipAudio(mediaItem, signal);
      return addVocalsToClip(
        uploadUrl,
        {
          prompt: vocalPrompt.trim(),
          model,
          style: vocalStyle.trim() || undefined,
          title: vocalTitle.trim() || undefined,
          ...advancedParams(),
        },
        signal,
      );
    });
  }, [mediaItem, vocalPrompt, vocalStyle, vocalTitle, model, runTracksOp, advancedParams]);

  const handleAddInstrumental = useCallback(() => {
    if (!mediaItem) return;
    if (!instTags.trim()) {
      setError("Add style tags for the instrumental (e.g. 'lofi, mellow').");
      return;
    }
    runTracksOp("add_instrumental", "Instrumental", async (signal) => {
      const uploadUrl = await uploadClipAudio(mediaItem, signal);
      return addInstrumentalToClip(
        uploadUrl,
        {
          tags: instTags.trim(),
          model,
          title: instTitle.trim() || undefined,
          ...advancedParams(),
        },
        signal,
      );
    });
  }, [mediaItem, instTags, instTitle, model, runTracksOp, advancedParams]);

  /**
   * One-click "back my vocals": upload the selected clip and let Suno build a
   * full arrangement under it. When the user hasn't typed style tags we get a
   * rich one from Suno's own style booster first — so a singer can record and
   * press ONE button without knowing how to describe a genre. Explicit tags
   * always win over the auto-generated ones.
   */
  const handleAutoInstrumental = useCallback(() => {
    if (!mediaItem) return;
    runTracksOp("add_instrumental", "Backing track", async (signal) => {
      const uploadUrl = await uploadClipAudio(mediaItem, signal);
      let tags = instTags.trim();
      if (!tags) {
        try {
          const boosted = await boostStyleText(
            "a full, modern band arrangement that supports a solo vocal — drums, bass, harmony instruments, tasteful dynamics",
            signal,
          );
          tags = boosted.result;
        } catch {
          // Booster is a nicety, not a dependency — fall back to a plain
          // arrangement brief rather than failing the whole run.
          tags = "full band arrangement, drums, bass, warm harmony, modern production";
        }
      }
      return addInstrumentalToClip(
        uploadUrl,
        { tags, model, title: instTitle.trim() || mediaItem.name || undefined, ...advancedParams() },
        signal,
      );
    });
  }, [mediaItem, instTags, instTitle, model, runTracksOp, advancedParams]);

  /**
   * Split into stems. Works on ANY audio: a Suno-origin clip separates by its
   * ids, anything else (an import, a recording) is uploaded first and split by
   * URL — the upstream endpoint accepts either, which is why this no longer
   * requires Suno lineage.
   */
  const handleSeparate = useCallback(async () => {
    if (!mediaItem || busy) return;
    setBusy("separate");
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const source = (mediaItem.sunoTaskId && mediaItem.sunoAudioId)
        ? { taskId: mediaItem.sunoTaskId, audioId: mediaItem.sunoAudioId }
        : { audioUrl: await uploadClipAudio(mediaItem, ac.signal) };
      const r = await separateClipStems(
        source,
        separateType,
        separateType === "split_stem_advanced" ? stemName : undefined,
        ac.signal,
      );
      const stems = r.result.stems || [];
      if (!stems.length) throw new Error("No stems were returned.");
      const takes: Take[] = stems.map((s) => ({
        id: uuidv4(),
        url: s.url,
        name: `${mediaItem.name} — ${s.label}`,
      }));
      // Stems are distinct outputs (not variations) → place each independently.
      setPending((p) => [...p, { id: uuidv4(), op: "separate", pickOne: false, takes }]);
      setSeparationTaskId(r.result.taskId || null);
      setBalance(r.balance);
      toast.success(
        "Stems separated",
        `${takes.length} stem${takes.length === 1 ? "" : "s"} — place each · ${r.charged} credits`,
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [mediaItem, busy, fail, separateType, stemName]);

  /**
   * Karaoke: 2-stem split, keep the instrumental, place it straight onto a new
   * track. Skips the pick-a-stem step because there is only one thing the user
   * wants here — a backing track to sing over.
   */
  const handleKaraoke = useCallback(async () => {
    if (!mediaItem || busy) return;
    setBusy("separate");
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const source = (mediaItem.sunoTaskId && mediaItem.sunoAudioId)
        ? { taskId: mediaItem.sunoTaskId, audioId: mediaItem.sunoAudioId }
        : { audioUrl: await uploadClipAudio(mediaItem, ac.signal) };
      const r = await separateClipStems(source, "separate_vocal", undefined, ac.signal);
      const instrumental =
        r.result.instrumentalUrl ||
        r.result.stems.find((s) => s.key === "instrumentalUrl")?.url ||
        "";
      if (!instrumental) throw new Error("No instrumental came back from the split.");
      const name = `${mediaItem.name} — Karaoke`;
      const mediaId = await importResultToLibrary(instrumental, name);
      const ctx = clipPlacementContext(clipId);
      await placeMedia(mediaId, "new-track", { startTime: ctx?.startTime });
      setSeparationTaskId(r.result.taskId || null);
      setBalance(r.balance);
      toast.success("Karaoke track ready", `On a new track, vocals removed · ${r.charged} credits`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [mediaItem, busy, fail, clipId]);

  /** Regenerate one window of the track in place. */
  const handleReplaceSection = useCallback(() => {
    if (!mediaItem) return;
    const span = Number(rsEnd) - Number(rsStart);
    if (!(span >= 6 && span <= 60)) {
      setError("Pick a window between 6 and 60 seconds long.");
      return;
    }
    if (!rsPrompt.trim() || !rsTags.trim() || !rsLyrics.trim()) {
      setError("Replace needs a description, style tags, and the FULL lyrics after the edit.");
      return;
    }
    runTracksOp("replace_section", "Replacement", async (signal) => {
      const params = {
        prompt: rsPrompt.trim(),
        tags: rsTags.trim(),
        title: rsTitle.trim() || mediaItem.name || "Untitled",
        infillStartS: Number(rsStart),
        infillEndS: Number(rsEnd),
        fullLyrics: rsLyrics.trim(),
        model,
        ...advancedParams(),
      };
      if (mediaItem.sunoTaskId && mediaItem.sunoAudioId) {
        return replaceClipSection(
          { taskId: mediaItem.sunoTaskId, audioId: mediaItem.sunoAudioId },
          params,
          signal,
        );
      }
      const uploadUrl = await uploadClipAudio(mediaItem, signal);
      return replaceClipSection({ uploadUrl }, params, signal);
    });
  }, [mediaItem, rsStart, rsEnd, rsPrompt, rsTags, rsTitle, rsLyrics, model, runTracksOp, advancedParams]);

  /** Capture a reusable artist identity from a window of this track. */
  const handlePersona = useCallback(async () => {
    if (!mediaItem?.sunoTaskId || !mediaItem?.sunoAudioId || busy) return;
    const span = Number(personaEnd) - Number(personaStart);
    if (!(span >= 10 && span <= 30)) {
      setError("The persona reference window must be 10–30 seconds.");
      return;
    }
    if (!personaName.trim() || !personaDesc.trim()) {
      setError("Give the persona a name and describe its musical character.");
      return;
    }
    setBusy("persona");
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await createPersona(
        mediaItem.sunoTaskId,
        mediaItem.sunoAudioId,
        {
          name: personaName.trim(),
          description: personaDesc.trim(),
          vocalStart: Number(personaStart),
          vocalEnd: Number(personaEnd),
        },
        ac.signal,
      );
      setPersonaId(r.result.personaId);
      setBalance(r.balance);
      toast.success("Persona created", `${r.result.name} · ${r.charged} credits`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [mediaItem, busy, fail, personaName, personaDesc, personaStart, personaEnd]);

  /**
   * Transcribe the last separation to MIDI and download it. Kie returns note
   * lists rather than a file, so the .mid is assembled server-side and handed
   * back base64 — this just turns it into a download.
   */
  const handleMidi = useCallback(async () => {
    if (!separationTaskId || busy) return;
    setBusy("midi");
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await transcribeToMidi(separationTaskId, undefined, ac.signal);
      const bin = atob(r.result.midiBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(mediaItem?.name || "transcription").replace(/[^a-zA-Z0-9._ -]/g, "_")}.mid`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick — revoking synchronously can cancel the
      // download in Chromium before it starts.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setBalance(r.balance);
      toast.success(
        "MIDI ready",
        `${r.result.noteCount} notes across ${r.result.instruments.length} instrument(s) · ${r.charged} credits`,
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [separationTaskId, busy, fail, mediaItem]);

  const handleWav = useCallback(async () => {
    if (!mediaItem?.sunoTaskId || !mediaItem?.sunoAudioId || busy) return;
    setBusy("wav");
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await convertClipToWav(mediaItem.sunoTaskId, mediaItem.sunoAudioId, ac.signal);
      setPending((p) => [...p, {
        id: uuidv4(), op: "wav", pickOne: false, taskId: mediaItem.sunoTaskId,
        takes: [{ id: uuidv4(), url: r.result.wavUrl, name: `${mediaItem.name} (WAV)`, audioId: mediaItem.sunoAudioId }],
      }]);
      setBalance(r.balance);
      toast.success("WAV ready", `Choose placement · ${r.charged} credits`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [mediaItem, busy, fail]);

  const handleLyrics = useCallback(async () => {
    if (!mediaItem?.sunoTaskId || !mediaItem?.sunoAudioId || !clip || busy) return;
    setBusy("timestamped_lyrics");
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await getClipTimestampedLyrics(mediaItem.sunoTaskId, mediaItem.sunoAudioId, ac.signal);
      const words = (r.result.alignedWords || []).filter((w) => w.word.trim());
      if (!words.length) throw new Error("No lyrics were aligned for this track.");

      // Group words into caption lines: break on a ≥0.6s gap or every 8 words.
      const base = clip.startTime;
      let line: typeof words = [];
      let lineCount = 0;
      const flush = () => {
        if (!line.length) return;
        const start = base + line[0].startS;
        const end = base + line[line.length - 1].endS;
        addSubtitle({
          text: line.map((w) => w.word).join(" "),
          startTime: start,
          endTime: Math.max(end, start + 0.3),
          words: line.map((w) => ({
            text: w.word,
            startTime: base + w.startS,
            endTime: base + w.endS,
          })),
          animationStyle: "word-highlight",
        } as Parameters<typeof addSubtitle>[0]);
        lineCount++;
        line = [];
      };
      for (let i = 0; i < words.length; i++) {
        line.push(words[i]);
        const next = words[i + 1];
        const gap = next ? next.startS - words[i].endS : Infinity;
        if (line.length >= 8 || gap >= 0.6) flush();
      }
      flush();

      setBalance(r.balance);
      toast.success("Lyrics added", `${lineCount} caption lines · ${r.charged} credits`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [mediaItem, clip, busy, fail, addSubtitle]);

  // Boost-style helper: enhance a style/tags field in place.
  const [boosting, setBoosting] = useState<string | null>(null);
  const boost = useCallback(
    async (current: string, apply: (v: string) => void, key: string) => {
      if (!current.trim() || boosting) return;
      setBoosting(key);
      try {
        const r = await boostStyleText(current.trim());
        apply(r.result);
        setBalance(r.balance);
      } catch (e) {
        fail(e);
      } finally {
        setBoosting(null);
      }
    },
    [boosting, fail],
  );

  const BoostBtn: React.FC<{ value: string; onApply: (v: string) => void; k: string }> = ({
    value,
    onApply,
    k,
  }) => (
    <button
      onClick={() => boost(value, onApply, k)}
      disabled={!value.trim() || boosting === k}
      title="Rewrite this into a richer style description"
      className="shrink-0 px-2 py-1.5 rounded-md bg-background-secondary border border-border text-[9px] text-text-secondary hover:text-primary hover:border-primary/40 transition-colors disabled:opacity-50 flex items-center gap-1"
    >
      {boosting === k ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
      Boost
    </button>
  );

  if (!clip || !mediaItem) {
    return (
      <p className="text-[10px] text-text-muted">Select an audio clip to use AI audio tools.</p>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 p-2 bg-primary/10 rounded-lg border border-primary/30">
        <Music2 size={15} className="text-primary shrink-0" />
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-text-primary">AI Audio · Suno</p>
          <p className="text-[9px] text-text-muted truncate">
            Every take is saved to your library automatically
          </p>
        </div>
      </div>

      {/* START HERE.
          Everything below this is one row per Suno endpoint, which is the
          right structure for someone who already knows the vocabulary and a
          dead end for someone who just recorded themselves singing. These
          three cover what people actually come here to do, in their words,
          and each one just opens the row that does it. */}
      <div className="space-y-1">
        <p className="text-[9px] text-text-secondary">What do you want to do?</p>
        {([
          ["cover", "Turn this into a proper song", "keeps your words & melody, new production"],
          ["add_instrumental", "Add music behind my voice", "your actual voice, with a band"],
          ["separate", "Make a karaoke version", "strip the vocals out"],
        ] as Array<[SunoOp, string, string]>).map(([op, label, hint]) => (
          <button
            key={op}
            onClick={() => setOpenOp(op)}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border text-left transition-colors ${
              openOp === op
                ? "bg-primary/15 border-primary/40"
                : "bg-background-secondary border-border hover:border-primary/40"
            }`}
          >
            <Sparkles size={11} className="text-primary shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] text-text-primary truncate">{label}</span>
              <span className="block text-[8px] text-text-muted truncate">{hint}</span>
            </span>
          </button>
        ))}
      </div>

      {/* Shared model selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] text-text-secondary">Model</span>
        <div className="flex gap-1 flex-1">
          {SUNO_MODELS.map((m) => (
            <button
              key={m}
              onClick={() => setModel(m)}
              className={`flex-1 py-1 rounded text-[9px] transition-colors ${
                model === m
                  ? "bg-primary text-black font-medium"
                  : "bg-background-tertiary text-text-muted hover:text-text-primary border border-border"
              }`}
            >
              {SUNO_MODEL_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="p-2 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-1.5">
          <AlertTriangle size={11} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-[10px] text-red-400">{error}</p>
        </div>
      )}

      {/* Generated results — audition & choose placement (no auto-placement). */}
      <audio ref={audioRef} onEnded={() => setPlayingTakeId(null)} className="hidden" />
      {pending.map((group) => {
        const placementRow = (take: Take) => (
          <div className="grid grid-cols-3 gap-1">
            {([
              ["new-track", Plus, "New track"],
              ["after-clip", CornerDownRight, "After clip"],
              ["library", Library, "Library"],
            ] as const).map(([mode, Icon, label]) => (
              <button
                key={mode}
                disabled={group.placing}
                onClick={() => placeTake(group, take, mode)}
                className="flex items-center justify-center gap-1 py-1.5 rounded-md bg-background-secondary border border-border text-[9px] text-text-secondary hover:text-primary hover:border-primary/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Icon size={10} /> {label}
              </button>
            ))}
          </div>
        );
        const selected = group.takes.find((t) => t.id === group.selectedTakeId);
        return (
          <div key={group.id} className="rounded-lg border border-primary/40 bg-primary/5 p-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-primary">
                {group.pickOne
                  ? `Pick a version · listen to ${group.takes.length}`
                  : group.takes.length > 1
                    ? `Place ${group.takes.length} stems`
                    : "Choose placement"}
              </span>
              <button
                onClick={() => dismissGroup(group.id)}
                title="Dismiss — the takes stay in your library"
                className="text-text-muted hover:text-text-primary transition-colors"
              >
                <X size={12} />
              </button>
            </div>

            {!group.pickOne && group.takes.length > 1 && (
              <button
                disabled={group.placing}
                onClick={() => placeAllStems(group)}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-primary text-black text-[10px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {group.placing ? <Loader2 size={11} className="animate-spin" /> : <Layers size={11} />}
                Place all {group.takes.length} on separate tracks
              </button>
            )}

            {group.takes.map((take) => {
              const isSel = group.selectedTakeId === take.id;
              const playing = playingTakeId === take.id;
              return (
                <div
                  key={take.id}
                  className={`rounded-md border p-2 space-y-1.5 transition-colors ${
                    group.pickOne && isSel ? "border-primary bg-primary/10" : "border-border bg-background-tertiary"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => togglePlay(take)}
                      title={playing ? "Pause" : "Preview"}
                      className="w-6 h-6 rounded-full bg-background-secondary hover:bg-primary/20 flex items-center justify-center shrink-0"
                    >
                      {playing ? (
                        <Pause size={11} className="text-primary" />
                      ) : (
                        <Play size={11} className="text-primary ml-0.5" />
                      )}
                    </button>
                    <span className="text-[10px] text-text-primary truncate flex-1">{take.name}</span>
                    {group.pickOne && (
                      <button
                        onClick={() => selectTake(group.id, take.id)}
                        title="Use this version"
                        className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                          isSel ? "bg-primary border-primary" : "border-border hover:border-primary/50"
                        }`}
                      >
                        {isSel && <Check size={11} className="text-black" />}
                      </button>
                    )}
                    {group.placing && <Loader2 size={11} className="animate-spin text-primary" />}
                  </div>
                  {!group.pickOne && placementRow(take)}
                </div>
              );
            })}

            {group.pickOne &&
              (selected ? (
                placementRow(selected)
              ) : (
                <p className="text-[9px] text-text-muted text-center py-0.5">
                  Listen, then select a version (◯) to place it.
                </p>
              ))}

            <p className="text-[8px] text-text-muted leading-relaxed">
              New track = aligned beside the source · After clip = continues on the same track · Library = save only.
            </p>
          </div>
        );
      })}

      {/* Cover */}
      {/* Cover — the "phone demo → finished record" path. Deliberately the
          first row: it is what most people mean by "make my song better".
          The voice caveat is stated in the row, not buried, because it is the
          one thing that surprises people. */}
      <OpRow
        id="cover"
        icon={Sparkles}
        title="Re-sing in a new style"
        cost={SUNO_OP_COST.cover}
        open={openOp === "cover"}
        busy={busy === "cover"}
        onToggle={() => toggle("cover")}
      >
        {/* Which KIND of text the big field holds decides how Suno reads it —
            a description shapes the sound, lyrics get sung. Making that a
            visible choice instead of an invisible consequence of filling in
            Style+Title is the fix for "it ignored my recording". */}
        <div className="flex gap-1">
          {([
            [false, "Keep my words", "sings what you sang"],
            [true, "New lyrics", "you supply the words"],
          ] as Array<[boolean, string, string]>).map(([mode, label, hint]) => (
            <button
              key={String(mode)}
              onClick={() => setCoverLyricsMode(mode)}
              className={`flex-1 px-2 py-1.5 rounded border text-left transition-colors ${
                coverLyricsMode === mode
                  ? "bg-primary/15 border-primary/40"
                  : "bg-background-secondary border-border hover:border-primary/30"
              }`}
            >
              <span className="block text-[10px] text-text-primary">{label}</span>
              <span className="block text-[8px] text-text-muted">{hint}</span>
            </button>
          ))}
        </div>
        {coverLyricsMode ? (
          <Field label="Lyrics to sing">
            <textarea
              value={coverPrompt}
              onChange={(e) => setCoverPrompt(e.target.value)}
              rows={4}
              placeholder="the actual words to sing"
              className="w-full rounded-md bg-background-secondary border border-border text-[10px] p-1.5 text-text-primary"
            />
          </Field>
        ) : (
          <div className="rounded-md border border-border bg-background-secondary/60 p-1.5 space-y-1">
            <p className="text-[8px] text-text-muted">
              {transcribing
                ? "Listening to your take to read the words…"
                : "Your sung words are read from the recording and used as the lyrics, so the cover says what you said."}
            </p>
            {detectedLyrics && (
              <>
                <label className="text-[8px] text-text-secondary block">Heard (edit if wrong)</label>
                <textarea
                  value={detectedLyrics}
                  onChange={(e) => {
                    setDetectedLyrics(e.target.value);
                    // An edited transcript is the user supplying lyrics, so
                    // switch modes rather than silently re-transcribing over it.
                    setCoverPrompt(e.target.value);
                    setCoverLyricsMode(true);
                  }}
                  rows={3}
                  className="w-full rounded bg-background-secondary border border-border text-[10px] p-1.5 text-text-primary"
                />
              </>
            )}
          </div>
        )}
        <Field label="Style">
          <div className="flex gap-1.5">
            <Input
              value={coverStyle}
              onChange={(e) => setCoverStyle(e.target.value)}
              placeholder="e.g. indie folk, warm, acoustic"
              className="h-7 text-[11px] bg-background-secondary border-border flex-1"
            />
            <BoostBtn value={coverStyle} onApply={setCoverStyle} k="cover-style" />
          </div>
        </Field>
        <Field label="Title (optional)">
          <Input
            value={coverTitle}
            onChange={(e) => setCoverTitle(e.target.value)}
            placeholder="track title"
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        <label className="flex items-center gap-2 text-[10px] text-text-secondary">
          <Switch checked={coverInstrumental} onCheckedChange={setCoverInstrumental} />
          Instrumental only
        </label>
        {renderAdvanced("styles to exclude")}
        <p className="text-[8px] text-text-muted">
          Keeps your melody and rebuilds the production around it — the fastest route from a rough
          take to something that sounds like a record.{" "}
          <span className="text-amber-400/90">
            An AI voice sings it, not yours.
          </span>{" "}
          To keep your own voice, use Vocal Studio above or “Add instrumental” below.
        </p>
        <RunButton
          busy={busy === "cover"}
          cost={SUNO_OP_COST.cover}
          label={transcribing ? "Reading your words" : "Re-sing"}
          onClick={handleCover}
        />
      </OpRow>

      <OpRow
        id="extend"
        icon={Music2}
        title="Extend"
        cost={SUNO_OP_COST.extend}
        open={openOp === "extend"}
        busy={busy === "extend"}
        onToggle={() => toggle("extend")}
      >
        <Field label="Continue from (seconds)">
          <Input
            type="number"
            min={0}
            step={0.5}
            value={extendAt}
            onChange={(e) => setExtendAt(parseFloat(e.target.value) || 0)}
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        <Field label="Direction (optional)">
          <Input
            value={extendPrompt}
            onChange={(e) => setExtendPrompt(e.target.value)}
            placeholder="how it should continue"
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        <Field label="Style (optional)">
          <div className="flex gap-1.5">
            <Input
              value={extendStyle}
              onChange={(e) => setExtendStyle(e.target.value)}
              placeholder="genre + mood (else keeps original)"
              className="h-7 text-[11px] bg-background-secondary border-border flex-1"
            />
            <BoostBtn value={extendStyle} onApply={setExtendStyle} k="extend-style" />
          </div>
        </Field>
        <Field label="Title (optional)">
          <Input
            value={extendTitle}
            onChange={(e) => setExtendTitle(e.target.value)}
            placeholder="track title"
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        <label className="flex items-center justify-between">
          <span className="text-[9px] text-text-secondary">Instrumental</span>
          <Switch checked={extendInstrumental} onCheckedChange={setExtendInstrumental} />
        </label>
        {renderAdvanced()}
        <p className="text-[8px] text-text-muted">
          {hasLineage ? "Uses Suno's native extend for a seamless join." : "Uploads this clip, then continues it."}
        </p>
        <RunButton busy={busy === "extend"} cost={SUNO_OP_COST.extend} label="Extend track" onClick={handleExtend} />
      </OpRow>

      {/* Add Vocals */}
      <OpRow
        id="add_vocals"
        icon={Mic2}
        title="Add vocals"
        cost={SUNO_OP_COST.add_vocals}
        open={openOp === "add_vocals"}
        busy={busy === "add_vocals"}
        onToggle={() => toggle("add_vocals")}
      >
        <Field label="Lyrics / direction">
          <textarea
            value={vocalPrompt}
            onChange={(e) => setVocalPrompt(e.target.value)}
            placeholder="paste lyrics, or describe what to sing"
            className={`${inputCls} h-14 resize-none`}
          />
        </Field>
        <Field label="Vocal style (optional)">
          <div className="flex gap-1.5">
            <Input
              value={vocalStyle}
              onChange={(e) => setVocalStyle(e.target.value)}
              placeholder="e.g. soulful pop"
              className="h-7 text-[11px] bg-background-secondary border-border flex-1"
            />
            <BoostBtn value={vocalStyle} onApply={setVocalStyle} k="vocal-style" />
          </div>
        </Field>
        <Field label="Title (optional)">
          <Input
            value={vocalTitle}
            onChange={(e) => setVocalTitle(e.target.value)}
            placeholder="track title"
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        {renderAdvanced("styles to exclude — e.g. rap, screaming")}
        <RunButton busy={busy === "add_vocals"} cost={SUNO_OP_COST.add_vocals} label="Add vocals" onClick={handleAddVocals} />
      </OpRow>

      {/* Add Instrumental */}
      <OpRow
        id="add_instrumental"
        icon={Music4}
        title="Add instrumental"
        cost={SUNO_OP_COST.add_instrumental}
        open={openOp === "add_instrumental"}
        busy={busy === "add_instrumental"}
        onToggle={() => toggle("add_instrumental")}
      >
        {/* The headline path for a singer: record, select the clip, one click.
            Everything below is optional steering. */}
        <button
          onClick={handleAutoInstrumental}
          disabled={!!busy}
          className="w-full py-2 rounded-lg bg-primary text-black text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {busy === "add_instrumental"
            ? <Loader2 size={12} className="animate-spin" />
            : <Wand2 size={12} />}
          Back my vocals — one click
          <span className="opacity-70">· {SUNO_OP_COST.add_instrumental} cr</span>
        </button>
        <p className="text-[8px] text-text-muted">
          Sing over silence, then press the button — Suno writes and plays the band underneath.
          Leave the fields blank and the style is chosen for you.
        </p>
        <Field label="Style tags (optional)">
          <div className="flex gap-1.5">
            <Input
              value={instTags}
              onChange={(e) => setInstTags(e.target.value)}
              placeholder="auto — or e.g. lofi, mellow, piano"
              className="h-7 text-[11px] bg-background-secondary border-border flex-1"
            />
            <BoostBtn value={instTags} onApply={setInstTags} k="inst-tags" />
          </div>
        </Field>
        <Field label="Title (optional)">
          <Input
            value={instTitle}
            onChange={(e) => setInstTitle(e.target.value)}
            placeholder="track title"
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        {renderAdvanced("styles to exclude — e.g. vocals, heavy metal")}
        <p className="text-[8px] text-text-muted">Backs this clip's vocals with a new instrumental.</p>
        <RunButton
          busy={busy === "add_instrumental"}
          cost={SUNO_OP_COST.add_instrumental}
          label="Add instrumental"
          onClick={handleAddInstrumental}
        />
      </OpRow>

      {/* Separate Stems — works on ANY audio, not just Suno-origin tracks. */}
      <OpRow
        id="separate"
        icon={Scissors}
        title="Separate stems"
        cost={separateCost(separateType)}
        open={openOp === "separate"}
        busy={busy === "separate"}
        onToggle={() => toggle("separate")}
      >
        <Field label="How deep">
          <div className="space-y-1">
            {([
              ["separate_vocal", "Vocal + instrumental", "2 stems — the quick split"],
              ["split_stem", "Every instrument", "up to 12 stems"],
              ["split_stem_advanced", "One instrument", "pick exactly what to pull out"],
            ] as Array<[SeparateType, string, string]>).map(([value, label, hint]) => (
              <button
                key={value}
                onClick={() => setSeparateType(value)}
                className={`w-full flex items-center justify-between px-2 py-1.5 rounded border text-left transition-colors ${
                  separateType === value
                    ? "bg-primary/15 border-primary/40"
                    : "bg-background-secondary border-border hover:border-primary/30"
                }`}
              >
                <span className="min-w-0">
                  <span className="block text-[10px] text-text-primary">{label}</span>
                  <span className="block text-[8px] text-text-muted">{hint}</span>
                </span>
                <span className="shrink-0 text-[9px] text-text-secondary flex items-center gap-0.5">
                  <Coins size={8} /> {separateCost(value)}
                </span>
              </button>
            ))}
          </div>
        </Field>
        {separateType === "split_stem_advanced" && (
          <Field label="Which stem">
            <div className="flex flex-wrap gap-1">
              {ADVANCED_STEM_NAMES.map((n) => (
                <button
                  key={n}
                  onClick={() => setStemName(n)}
                  className={`px-1.5 py-0.5 rounded text-[9px] border transition-colors ${
                    stemName === n
                      ? "bg-primary text-black border-primary font-medium"
                      : "bg-background-secondary text-text-secondary border-border hover:border-primary/40"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </Field>
        )}
        <p className="text-[8px] text-text-muted">
          Each stem lands on its own audio track, so you can rebalance or replace one part
          without touching the rest. Imported and recorded audio works too — not just AI tracks.
        </p>
        <RunButton
          busy={busy === "separate"}
          cost={separateCost(separateType)}
          label="Separate"
          onClick={handleSeparate}
        />
        {/* Karaoke is just the 2-stem split with the vocal thrown away, but
            nobody thinks of it that way — so it gets its own button. */}
        <button
          onClick={handleKaraoke}
          disabled={!!busy}
          className="w-full py-1.5 rounded-lg bg-background-secondary border border-border text-[10px] text-text-secondary hover:text-primary hover:border-primary/40 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {busy === "separate" ? <Loader2 size={11} className="animate-spin" /> : <Mic2 size={11} />}
          Make a karaoke track — instrumental only · {separateCost("separate_vocal")} cr
        </button>
      </OpRow>

      {/* Replace a section — the surgical alternative to re-rolling a whole song. */}
      <OpRow
        id="replace_section"
        icon={Replace}
        title="Replace a section"
        cost={SUNO_OP_COST.replace_section}
        open={openOp === "replace_section"}
        busy={busy === "replace_section"}
        onToggle={() => toggle("replace_section")}
      >
        <div className="grid grid-cols-2 gap-1.5">
          <Field label="From (s)">
            <Input
              type="number"
              value={rsStart}
              onChange={(e) => setRsStart(Number(e.target.value))}
              className="h-7 text-[11px] bg-background-secondary border-border"
            />
          </Field>
          <Field label="To (s)">
            <Input
              type="number"
              value={rsEnd}
              onChange={(e) => setRsEnd(Number(e.target.value))}
              className="h-7 text-[11px] bg-background-secondary border-border"
            />
          </Field>
        </div>
        <Field label="What should this part become">
          <Input
            value={rsPrompt}
            onChange={(e) => setRsPrompt(e.target.value)}
            placeholder="e.g. a bigger chorus with stacked harmonies"
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        <Field label="Style tags">
          <div className="flex gap-1.5">
            <Input
              value={rsTags}
              onChange={(e) => setRsTags(e.target.value)}
              placeholder="e.g. indie pop, anthemic"
              className="h-7 text-[11px] bg-background-secondary border-border flex-1"
            />
            <BoostBtn value={rsTags} onApply={setRsTags} k="rs-tags" />
          </div>
        </Field>
        <Field label="Title">
          <Input
            value={rsTitle}
            onChange={(e) => setRsTitle(e.target.value)}
            placeholder={mediaItem.name || "track title"}
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        <Field label="Full lyrics after the edit">
          <textarea
            value={rsLyrics}
            onChange={(e) => setRsLyrics(e.target.value)}
            rows={4}
            placeholder="The COMPLETE lyric of the track once this section is changed — not just the new lines."
            className="w-full rounded-md bg-background-secondary border border-border text-[10px] p-1.5 text-text-primary"
          />
        </Field>
        <p className="text-[8px] text-text-muted">
          6–60 seconds, and at most half the track. Suno blends the new part into what comes
          before and after, so the rest of the song is untouched.
        </p>
        <RunButton
          busy={busy === "replace_section"}
          cost={SUNO_OP_COST.replace_section}
          label="Replace section"
          onClick={handleReplaceSection}
        />
      </OpRow>

      {/* Persona — one artist identity across many releases. */}
      <OpRow
        id="persona"
        icon={UserRoundPen}
        title="Create artist persona"
        cost={SUNO_OP_COST.persona}
        open={openOp === "persona"}
        busy={busy === "persona"}
        disabled={!hasLineage}
        disabledHint="Only available for tracks generated by Suno here"
        onToggle={() => toggle("persona")}
      >
        <Field label="Artist name">
          <Input
            value={personaName}
            onChange={(e) => setPersonaName(e.target.value)}
            placeholder="e.g. Nightwell"
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        <Field label="What defines this artist">
          <Input
            value={personaDesc}
            onChange={(e) => setPersonaDesc(e.target.value)}
            placeholder="e.g. breathy alto over warm analog synths, unhurried phrasing"
            className="h-7 text-[11px] bg-background-secondary border-border"
          />
        </Field>
        <div className="grid grid-cols-2 gap-1.5">
          <Field label="From (s)">
            <Input
              type="number"
              value={personaStart}
              onChange={(e) => setPersonaStart(Number(e.target.value))}
              className="h-7 text-[11px] bg-background-secondary border-border"
            />
          </Field>
          <Field label="To (s)">
            <Input
              type="number"
              value={personaEnd}
              onChange={(e) => setPersonaEnd(Number(e.target.value))}
              className="h-7 text-[11px] bg-background-secondary border-border"
            />
          </Field>
        </div>
        <p className="text-[8px] text-text-muted">
          Learns the sound of a 10–30s window so later tracks can be the same artist.
          Needs a Suno v6 model when you use it.
        </p>
        {personaId && (
          <p className="text-[9px] text-primary break-all">Persona id: {personaId}</p>
        )}
        <RunButton
          busy={busy === "persona"}
          cost={SUNO_OP_COST.persona}
          label="Create persona"
          onClick={handlePersona}
        />
      </OpRow>

      {/* MIDI — only meaningful once a separation exists. */}
      <OpRow
        id="midi"
        icon={Piano}
        title="Transcribe to MIDI"
        cost={SUNO_OP_COST.midi}
        open={openOp === "midi"}
        busy={busy === "midi"}
        disabled={!separationTaskId}
        disabledHint="Separate this track into stems first"
        onToggle={() => toggle("midi")}
      >
        <p className="text-[9px] text-text-secondary">
          Turns the stems from your last separation into notes and downloads a .mid you can
          open in any DAW.
        </p>
        <RunButton busy={busy === "midi"} cost={SUNO_OP_COST.midi} label="Download MIDI" onClick={handleMidi} />
      </OpRow>

      {/* Convert to WAV */}
      <OpRow
        id="wav"
        icon={FileAudio2}
        title="Convert to WAV"
        cost={SUNO_OP_COST.wav}
        open={openOp === "wav"}
        busy={busy === "wav"}
        disabled={!hasLineage}
        disabledHint="Only available for tracks generated by Suno here"
        onToggle={() => toggle("wav")}
      >
        <p className="text-[9px] text-text-secondary">Adds a lossless WAV version on a new track.</p>
        <RunButton busy={busy === "wav"} cost={SUNO_OP_COST.wav} label="Convert" onClick={handleWav} />
      </OpRow>

      {/* Timestamped Lyrics */}
      <OpRow
        id="timestamped_lyrics"
        icon={Captions}
        title="Timestamped lyrics"
        cost={SUNO_OP_COST.timestamped_lyrics}
        open={openOp === "timestamped_lyrics"}
        busy={busy === "timestamped_lyrics"}
        disabled={!hasLineage}
        disabledHint="Only available for tracks generated by Suno here"
        onToggle={() => toggle("timestamped_lyrics")}
      >
        <p className="text-[9px] text-text-secondary">
          Adds word-synced captions to the timeline, aligned to this clip.
        </p>
        <RunButton
          busy={busy === "timestamped_lyrics"}
          cost={SUNO_OP_COST.timestamped_lyrics}
          label="Add lyrics"
          onClick={handleLyrics}
        />
      </OpRow>

      {balance !== null && (
        <p className="text-[9px] text-text-muted text-center flex items-center justify-center gap-1">
          <Coins size={9} /> {Math.round(balance)} credits left
        </p>
      )}
      {!hasLineage && (
        <p className="text-[8px] text-text-muted text-center">
          WAV, lyrics and personas unlock for tracks generated by Suno here. Stem separation,
          covers, extends and section replacement work on any audio.
        </p>
      )}
    </div>
  );
};

export default SunoAudioPanel;
