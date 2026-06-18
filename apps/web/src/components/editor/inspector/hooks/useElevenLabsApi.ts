import { useState, useCallback } from "react";
import type { ElevenLabsVoice, ElevenLabsModel } from "../tts-types";
import {
  synthesizeViaVoidspace,
  enhanceTextViaVoidspace,
  VOIDSPACE_TTS_VOICES,
  VOIDSPACE_TTS_MODELS,
} from "../../../../services/voidspace-tts";

interface UseElevenLabsApiOptions {
  /** Selected TTS model id (maps straight to gen-voiceover's `model`). */
  elevenLabsModel: string;
}

interface UseElevenLabsApiReturn {
  allVoices: ElevenLabsVoice[];
  allModels: ElevenLabsModel[];
  isLoadingVoices: boolean;
  isLoadingModels: boolean;
  generateWithElevenLabs: (text: string, voiceId: string, signal?: AbortSignal) => Promise<Blob>;
  generateWithPiper: (text: string, voice: string, speed: number, signal?: AbortSignal) => Promise<Blob>;
  enhanceViaLlm: (text: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * TTS + script-enhancement, routed entirely through the Voidspace Studio API
 * (services/voidspace-tts). The voice/model lists are the curated Voidspace
 * catalog — no BYOK key, no external fetch; generation + enhancement charge
 * credits server-side. The old ElevenLabs / OpenAI / Anthropic BYOK paths and
 * the openreel Piper free service are gone. The hook keeps the same return
 * shape so TextToSpeechPanel / useTtsActions are unchanged.
 */
export function useElevenLabsApi(options: UseElevenLabsApiOptions): UseElevenLabsApiReturn {
  const { elevenLabsModel } = options;

  const [allVoices] = useState<ElevenLabsVoice[]>(VOIDSPACE_TTS_VOICES);
  const [allModels] = useState<ElevenLabsModel[]>(VOIDSPACE_TTS_MODELS);

  const generateWithElevenLabs = useCallback(
    (inputText: string, voiceId: string, signal?: AbortSignal): Promise<Blob> =>
      synthesizeViaVoidspace(inputText, voiceId, elevenLabsModel, signal),
    [elevenLabsModel],
  );

  // The legacy "piper" path now also routes through Voidspace TTS (the openreel
  // free service is gone). `speed` is not supported by the studio TTS engine.
  const generateWithPiper = useCallback(
    (inputText: string, voice: string, _speed: number, signal?: AbortSignal): Promise<Blob> =>
      synthesizeViaVoidspace(inputText, voice, elevenLabsModel, signal),
    [elevenLabsModel],
  );

  const enhanceViaLlm = useCallback(
    (inputText: string, signal?: AbortSignal): Promise<string> =>
      enhanceTextViaVoidspace(inputText, signal),
    [],
  );

  return {
    allVoices,
    allModels,
    isLoadingVoices: false,
    isLoadingModels: false,
    generateWithElevenLabs,
    generateWithPiper,
    enhanceViaLlm,
  };
}
