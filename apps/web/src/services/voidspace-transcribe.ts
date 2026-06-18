/**
 * Voidspace speech-to-text for the editor's AI Auto-Captions.
 *
 * Talks to the Voidspace Studio server proxies — never to a third-party STT
 * service directly — so the central ElevenLabs key and the credit ledger stay
 * server-side, exactly like the Suno audio client (services/suno/index.ts):
 *
 *   POST /api/studio/upload-temp  → public URL for the extracted clip audio
 *   POST /api/studio/transcribe   → ElevenLabs Scribe v1 STT (charges credits)
 *
 * Auth: the user's Firebase ID token, forwarded as `Authorization: Bearer`.
 * The server resolves the UID, runs the SAME `generateSubtitles` (Scribe v1)
 * the studio uses for gen-clip/gen-voiceover, and debits ~4 cr/min from that
 * user's Voidspace credits.
 *
 * This replaces the old route to the external `transcribe.openreel.video`
 * Cloudflare-Whisper service, which charged no credits and is unreachable in
 * the Voidspace deployment. The result is mapped to the core's
 * `CloudflareWhisperResponse` shape so the transcription pipeline is unchanged.
 */

import { auth } from "../config/firebase-config";
import type {
  CloudflareWhisperResponse,
  WhisperTranscriptionProgress,
} from "@openreel/core";

async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to generate captions.");
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

/** Same origin-resolution rule as the Suno client / voidspace-publish.ts:
 *  when the editor runs in an iframe, target the parent (Nuxt) origin. */
function apiBase(): string {
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) {
        return window.parent.location.origin;
      }
    } catch {
      /* cross-origin — use current origin */
    }
  }
  return "";
}

/** Pull a friendly error message out of an h3 createError JSON body. */
async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw);
    return (
      j?.statusMessage || j?.message || j?.statusText || raw || `HTTP ${res.status}`
    );
  } catch {
    return raw || `HTTP ${res.status}`;
  }
}

/** True when a Voidspace user is signed in, so auto-captions can route through
 *  the credit-charged Voidspace STT instead of the standalone fallback. */
export function isVoidspaceTranscribeAvailable(): boolean {
  return !!auth.currentUser;
}

export interface VoidspaceTranscribeResult extends CloudflareWhisperResponse {
  /** Credits debited by /api/studio/transcribe (sized to audio length). */
  charged?: number;
  /** Remaining Voidspace balance after the charge. */
  balance?: number;
}

/**
 * Transcribe the already-extracted (and trim-accurate) clip audio through
 * Voidspace STT. Designed to be passed to the core TranscriptionService as
 * `config.transcribeAudio`, so the existing extract → transcribe → group-into-
 * subtitles pipeline is reused verbatim — only the STT backend changes.
 */
export async function transcribeViaVoidspace(
  audioBlob: Blob,
  onProgress?: (progress: WhisperTranscriptionProgress) => void,
): Promise<VoidspaceTranscribeResult> {
  const headers = await authHeader();
  const base = apiBase();

  // 1. Upload the extracted audio → public URL the STT endpoint can fetch.
  onProgress?.({
    phase: "uploading",
    progress: 30,
    message: "Uploading audio...",
  });
  const form = new FormData();
  form.append("file", audioBlob, "caption-audio.wav");
  const upRes = await fetch(`${base}/api/studio/upload-temp`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!upRes.ok) {
    throw new Error(`Audio upload failed: ${await errorText(upRes)}`);
  }
  const up = (await upRes.json()) as { url?: string };
  if (!up.url) throw new Error("Audio upload returned no URL.");

  // 2. Transcribe via ElevenLabs Scribe v1 (server charges credits).
  onProgress?.({
    phase: "transcribing",
    progress: 60,
    message: "Transcribing audio...",
  });
  const txRes = await fetch(`${base}/api/studio/transcribe`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ mediaUrl: up.url }),
  });
  if (!txRes.ok) {
    throw new Error(`Transcription failed: ${await errorText(txRes)}`);
  }
  const data = (await txRes.json()) as {
    transcript?: string;
    wordTimestamps?: Array<{ word: string; start: number; end: number }>;
    charged?: number;
    balance?: number;
  };

  // Map Voidspace's { transcript, wordTimestamps } → the core's
  // CloudflareWhisperResponse { text, words } so nothing downstream changes.
  return {
    text: data.transcript ?? "",
    words: (data.wordTimestamps ?? []).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
    })),
    charged: data.charged,
    balance: data.balance,
  };
}
