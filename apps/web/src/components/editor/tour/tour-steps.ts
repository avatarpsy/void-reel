export interface TourStep {
  id: string;
  target: string | null;
  title: string;
  description: string;
  tips?: string[];
  position: "center" | "top" | "bottom" | "left" | "right";
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    target: null,
    title: "Welcome to Voidspace Studio",
    description:
      "This is an AI-assisted editor — you can edit two ways: just ask the assistant, or do it yourself on the timeline. Here's a 30-second tour.",
    position: "center",
  },
  {
    // The single most important onboarding step for an agent-first product:
    // teach that the chat assistant is the fastest way to work. It lives in
    // the parent shell (outside this iframe), so this is a CENTERED card —
    // we can't spotlight a cross-document element. Keep the example asks
    // generic so the one step reads right for both video and music projects.
    id: "agent",
    target: null,
    title: "Edit by chatting — your AI director",
    description:
      "The fastest way to work here is to just ask. Open the chat panel and tell the assistant what you want — it can script, generate, and edit the timeline for you. You can always fine-tune by hand afterwards.",
    tips: [
      "“Add a scene about …”  ·  “Make it shorter”",
      "“Change the music”  ·  “Regenerate scene 2”",
      "“Add captions and background music”",
    ],
    position: "center",
  },
  {
    id: "assets",
    target: "[data-tour='assets']",
    title: "Assets Panel",
    description: "Your creative toolkit. Import media, reuse past generations from the Library, and add text, graphics, music and SFX.",
    tips: [
      "Drag & drop videos, audio, images",
      "Library tab — reuse anything you've generated",
      "Stickers, backgrounds & overlays",
    ],
    position: "right",
  },
  {
    id: "timeline",
    target: "[data-tour='timeline']",
    title: "Timeline",
    description: "Arrange and edit your clips. Drag to move, drag edges to trim.",
    tips: ["Press S to split clips", "Space to play/pause", "Scroll to zoom"],
    position: "top",
  },
  {
    id: "preview",
    target: "[data-tour='preview']",
    title: "Preview",
    description: "Watch your video in real-time as you edit.",
    tips: [
      "Arrow keys for frame navigation",
      "Click to scrub",
      "Fullscreen available",
    ],
    position: "left",
  },
  {
    id: "inspector",
    target: "[data-tour='inspector']",
    title: "Inspector",
    description:
      "Select a clip to see its properties. Add effects, adjust colors, animate.",
    tips: [
      "Transform, effects, color grading",
      "Keyframe any property",
      "AI-powered tools",
    ],
    position: "left",
  },
  {
    id: "complete",
    target: null,
    title: "You're Ready!",
    description:
      "Ask the assistant in the chat panel, or edit the timeline yourself — they work hand in hand. Press ? anytime for keyboard shortcuts.",
    position: "center",
  },
];

export const ONBOARDING_KEY = "openreel-onboarding-complete";
