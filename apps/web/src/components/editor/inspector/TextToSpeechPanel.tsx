import React, { useState } from "react";
import { Mic, Loader2, Volume2, Sparkles, AlertTriangle } from "lucide-react";
import { Switch } from "@openreel/ui";
import { useSettingsStore } from "../../../stores/settings-store";
import { useElevenLabsApi } from "./hooks/useElevenLabsApi";
import { useTtsActions } from "./hooks/useTtsActions";
import { VoiceBrowser } from "./VoiceBrowser";
import { ModelSelector } from "./ModelSelector";
import { EnhancedTextPreview } from "./EnhancedTextPreview";
import { AudioResult } from "./AudioResult";
import { VOIDSPACE_TTS_VOICES } from "../../../services/voidspace-tts";

/**
 * Text-to-Speech panel — fully Voidspace-backed. Generation routes through
 * /api/studio/gen-voiceover (ElevenLabs, charges credits) and "Enhance for
 * TTS" through /api/studio/enhance-text (agent LLM). No BYOK keys, no provider
 * toggle, no openreel Piper service — those were removed.
 */
export const TextToSpeechPanel: React.FC = () => {
  const { elevenLabsModel, favoriteVoices } = useSettingsStore();

  const [text, setText] = useState("");
  const [selectedVoice, setSelectedVoice] = useState<string>(
    VOIDSPACE_TTS_VOICES[0]?.voice_id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [enhanceText, setEnhanceText] = useState(false);
  const [enhancedPreview, setEnhancedPreview] = useState<string | null>(null);

  const {
    allVoices,
    allModels,
    isLoadingVoices,
    isLoadingModels,
    generateWithElevenLabs,
    generateWithPiper,
    enhanceViaLlm,
  } = useElevenLabsApi({ elevenLabsModel });

  const {
    isGenerating,
    isPlaying,
    isEnhancing,
    generatedAudio,
    hasUnsavedAudio,
    successMsg,
    audioRef,
    getSelectedVoiceName,
    handleEnhance,
    generateSpeech,
    togglePlayback,
    handleAudioEnded,
    saveToMedia,
    addToTimeline,
    downloadAudio,
  } = useTtsActions({
    // Single Voidspace provider now; pass the (legacy) "elevenlabs" value so
    // the shared hooks/components take their full-featured branch.
    provider: "elevenlabs",
    selectedVoice,
    text,
    speed: 1,
    enhanceText,
    enhancedPreview,
    allVoices,
    favoriteVoices,
    generateWithElevenLabs,
    generateWithPiper,
    enhanceViaLlm,
    setText,
    setError,
    setEnhancedPreview,
  });

  const getSelectedModelName = (): string => {
    const model = allModels.find((m) => m.model_id === elevenLabsModel);
    return model ? model.name : elevenLabsModel || "TTS";
  };

  const charCount = text.length;
  const maxChars = 5000;

  return (
    <div className="space-y-3 w-full min-w-0 max-w-full">
      <audio ref={audioRef as React.RefObject<HTMLAudioElement>} onEnded={handleAudioEnded} className="hidden" />

      <div className="flex items-center gap-2 p-2 bg-primary/10 rounded-lg border border-primary/30">
        <Mic size={16} className="text-primary" />
        <div>
          <span className="text-[11px] font-medium text-text-primary">Text to Speech</span>
          <p className="text-[9px] text-text-muted">AI voice generation · Voidspace</p>
        </div>
      </div>

      <ModelSelector allModels={allModels} isLoadingModels={isLoadingModels} />

      <div className="space-y-2">
        <label className="text-[10px] font-medium text-text-secondary">Text</label>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setEnhancedPreview(null); }}
          placeholder="Enter the text you want to convert to speech..."
          className="w-full h-24 px-3 py-2 text-[11px] bg-background-tertiary rounded-lg border border-border focus:border-primary focus:outline-none resize-none"
          maxLength={maxChars}
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Switch
              checked={enhanceText}
              onCheckedChange={setEnhanceText}
              className="scale-75 origin-left"
            />
            <label className="text-[9px] text-text-muted flex items-center gap-1 cursor-pointer" onClick={() => setEnhanceText(!enhanceText)}>
              <Sparkles size={10} className={enhanceText ? "text-amber-400" : ""} />
              Enhance for TTS
            </label>
          </div>
          <span className={`text-[9px] ${charCount > maxChars * 0.9 ? "text-red-400" : "text-text-muted"}`}>
            {charCount}/{maxChars}
          </span>
        </div>

        {enhancedPreview && enhanceText && (
          <EnhancedTextPreview
            enhancedPreview={enhancedPreview}
            onUpdate={setEnhancedPreview}
            onDiscard={() => setEnhancedPreview(null)}
          />
        )}
      </div>

      <VoiceBrowser
        provider="elevenlabs"
        selectedVoice={selectedVoice}
        onSelectVoice={setSelectedVoice}
        allVoices={allVoices}
        isLoadingVoices={isLoadingVoices}
      />

      {error && (
        <div className="p-2 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-[10px] text-red-400">{error}</p>
        </div>
      )}

      {successMsg && (
        <div className="p-2 bg-green-500/10 border border-green-500/30 rounded-lg">
          <p className="text-[10px] text-green-400">{successMsg}</p>
        </div>
      )}

      {enhanceText && !enhancedPreview && (
        <button
          onClick={handleEnhance}
          disabled={isEnhancing || !text.trim()}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 text-white rounded-lg text-[11px] font-medium transition-all hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isEnhancing ? (
            <><Loader2 size={14} className="animate-spin" /> Enhancing...</>
          ) : (
            <><Sparkles size={14} /> Enhance Text</>
          )}
        </button>
      )}

      <button
        onClick={generateSpeech}
        disabled={isGenerating || !text.trim() || !selectedVoice || (enhanceText && !enhancedPreview)}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-white rounded-lg text-[11px] font-medium transition-all hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isGenerating ? (
          <><Loader2 size={14} className="animate-spin" /> Generating...</>
        ) : (
          <><Volume2 size={14} /> Generate Speech</>
        )}
      </button>

      {hasUnsavedAudio && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <AlertTriangle size={12} className="text-amber-400 shrink-0" />
          <p className="text-[9px] text-amber-400">
            Unsaved audio — save to media, add to timeline, or download to keep it.
          </p>
        </div>
      )}

      {generatedAudio && (
        <AudioResult
          generatedAudio={generatedAudio}
          voiceName={getSelectedVoiceName()}
          isPlaying={isPlaying}
          isGenerating={isGenerating}
          onTogglePlayback={togglePlayback}
          onSaveToMedia={saveToMedia}
          onAddToTimeline={addToTimeline}
          onDownload={downloadAudio}
        />
      )}

      <p className="text-[9px] text-text-muted text-center">
        Powered by Voidspace · {getSelectedModelName()}
      </p>
    </div>
  );
};

export default TextToSpeechPanel;
