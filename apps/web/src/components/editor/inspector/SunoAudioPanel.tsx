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
 *     • Cover            – re-imagine in a new style
 *     • Extend           – continue past its end
 *     • Add Vocals       – sing over an instrumental
 *     • Add Instrumental – back an acapella
 *   Needs a Suno-origin source (taskId + audioId on the media item):
 *     • Separate Stems   – split into vocal + instrumental
 *     • Convert to WAV   – lossless export
 *     • Timestamped Lyrics – word-synced captions
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
} from "lucide-react";
import { Input, Switch } from "@openreel/ui";
import { useProjectStore } from "../../../stores/project-store";
import { toast } from "../../../stores/notification-store";
import {
  SUNO_OP_COST,
  uploadClipAudio,
  coverClip,
  extendClipUpload,
  extendClipNative,
  addVocalsToClip,
  addInstrumentalToClip,
  separateClipStems,
  convertClipToWav,
  getClipTimestampedLyrics,
  boostStyleText,
  importResultToLibrary,
  placeMedia,
  clipPlacementContext,
  proxiedMediaUrl,
  type SunoOp,
  type PlacementMode,
} from "../../../services/suno";

/** One produced audio take (a variation or a stem). */
interface Take {
  id: string;
  url: string;
  name: string;
  /** Suno per-track id — becomes the placed clip's sunoAudioId lineage. */
  audioId?: string;
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

const SUNO_MODELS = ["V4_5PLUS", "V5", "V4_5"] as const;
type SunoModel = (typeof SUNO_MODELS)[number];

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
  const [model, setModel] = useState<SunoModel>("V4_5PLUS");
  const [coverPrompt, setCoverPrompt] = useState("");
  const [coverStyle, setCoverStyle] = useState("");
  const [coverTitle, setCoverTitle] = useState("");
  const [coverInstrumental, setCoverInstrumental] = useState(false);

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
        toast.success(
          `${label} ready`,
          takes.length > 1
            ? `${takes.length} versions — listen & pick one · ${r.charged} credits`
            : `Generated — choose placement · ${r.charged} credits`,
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
        const lineage = group.taskId ? { sunoTaskId: group.taskId, sunoAudioId: take.audioId } : {};
        const mediaId = await importResultToLibrary(take.url, take.name, lineage);
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

  // ── op handlers ──────────────────────────────────────────────────────────
  const handleCover = useCallback(() => {
    if (!mediaItem) return;
    if (!coverPrompt.trim()) {
      setError("Describe the cover you want.");
      return;
    }
    runTracksOp("cover", "Cover", async (signal) => {
      const uploadUrl = await uploadClipAudio(mediaItem, signal);
      return coverClip(
        uploadUrl,
        {
          prompt: coverPrompt.trim(),
          model,
          instrumental: coverInstrumental,
          style: coverStyle.trim() || undefined,
          title: coverTitle.trim() || undefined,
          ...advancedParams(),
        },
        signal,
      );
    });
  }, [mediaItem, coverPrompt, coverStyle, coverTitle, coverInstrumental, model, runTracksOp, advancedParams]);

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

  const handleSeparate = useCallback(async () => {
    if (!mediaItem?.sunoTaskId || !mediaItem?.sunoAudioId || busy) return;
    setBusy("separate");
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await separateClipStems(mediaItem.sunoTaskId, mediaItem.sunoAudioId, ac.signal);
      const takes: Take[] = [];
      if (r.result.instrumentalUrl)
        takes.push({ id: uuidv4(), url: r.result.instrumentalUrl, name: `${mediaItem.name} — Instrumental` });
      if (r.result.vocalUrl)
        takes.push({ id: uuidv4(), url: r.result.vocalUrl, name: `${mediaItem.name} — Vocals` });
      if (!takes.length) throw new Error("No stems were returned.");
      // Stems are distinct outputs (not variations) → place each independently.
      setPending((p) => [...p, { id: uuidv4(), op: "separate", pickOne: false, takes }]);
      setBalance(r.balance);
      toast.success("Stems separated", `${takes.length} stems — place each · ${r.charged} credits`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [mediaItem, busy, fail]);

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
      title="Enhance this style with Suno's boost (1 cr)"
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
            Transform this clip — results land on new tracks
          </p>
        </div>
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
              {m.replace("V", "v").replace("_", ".").replace("PLUS", "+")}
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
                title="Discard (results aren't saved)"
                className="text-text-muted hover:text-text-primary transition-colors"
              >
                <X size={12} />
              </button>
            </div>

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
      <OpRow
        id="cover"
        icon={Music4}
        title="Cover (restyle)"
        cost={SUNO_OP_COST.cover}
        open={openOp === "cover"}
        busy={busy === "cover"}
        onToggle={() => toggle("cover")}
      >
        <Field label="Describe the cover">
          <textarea
            value={coverPrompt}
            onChange={(e) => setCoverPrompt(e.target.value)}
            placeholder="e.g. acoustic, slow, intimate"
            className={`${inputCls} h-14 resize-none`}
          />
        </Field>
        <Field label="Style (optional)">
          <div className="flex gap-1.5">
            <Input
              value={coverStyle}
              onChange={(e) => setCoverStyle(e.target.value)}
              placeholder="genre + mood"
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
        <label className="flex items-center justify-between">
          <span className="text-[9px] text-text-secondary">Instrumental</span>
          <Switch checked={coverInstrumental} onCheckedChange={setCoverInstrumental} />
        </label>
        {renderAdvanced()}
        <RunButton busy={busy === "cover"} cost={SUNO_OP_COST.cover} label="Generate cover" onClick={handleCover} />
      </OpRow>

      {/* Extend */}
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
        <Field label="Style tags">
          <div className="flex gap-1.5">
            <Input
              value={instTags}
              onChange={(e) => setInstTags(e.target.value)}
              placeholder="e.g. lofi, mellow, piano"
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

      {/* Separate Stems */}
      <OpRow
        id="separate"
        icon={Scissors}
        title="Separate stems"
        cost={SUNO_OP_COST.separate}
        open={openOp === "separate"}
        busy={busy === "separate"}
        disabled={!hasLineage}
        disabledHint="Only available for tracks generated by Suno here"
        onToggle={() => toggle("separate")}
      >
        <p className="text-[9px] text-text-secondary">
          Splits this track into separate vocal and instrumental tracks.
        </p>
        <RunButton busy={busy === "separate"} cost={SUNO_OP_COST.separate} label="Separate" onClick={handleSeparate} />
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
          Separate / WAV / Lyrics unlock for tracks generated by Suno here.
        </p>
      )}
    </div>
  );
};

export default SunoAudioPanel;
