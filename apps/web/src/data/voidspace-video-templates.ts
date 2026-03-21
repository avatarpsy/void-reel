/**
 * Voidspace Video Templates
 *
 * Standard template definitions for AI-powered video generation.
 * Each template maps to a video generation style supported by the Voidspace pipeline.
 *
 * To create a custom template, follow this schema and add it to VOIDSPACE_TEMPLATES.
 * The sampleOutput field shows exactly what the AI generates for the given style.
 */

// ── Types ──────────────────────────────────────────────────

export type VideoStyle =
  | "vlog"
  | "story"
  | "cinematic"
  | "explainer"
  | "fun"
  | "brand";

export type NarrationMode = "narrator" | "dialogue" | "false";

export type SubtitleType = "word" | "sentence" | "none" | "narration" | "lyrics";

export type StoryStyle =
  | "story_narration"
  | "vlog"
  | "pov"
  | "explainer"
  | "testimonial"
  | "music_video"
  | "product_showcase";

export type Duration = "10" | "20" | "30" | "40" | "50" | "60";

export type AspectRatio = "16:9" | "9:16" | "4:3" | "3:4" | "1:1";

export type TemplateCategory =
  | "storytelling"
  | "conversational"
  | "creative"
  | "commercial";

export interface TemplateField {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "number";
  placeholder?: string;
  required: boolean;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

export interface SampleScene {
  scene_number: number;
  title: string;
  text: string;
  first_frame_image_description: string;
  mood: string;
  visual_style: string;
  duration_seconds: number;
  voiceover?: string;
  dialogue?: string;
}

export interface SampleOutput {
  title: string;
  template: string;
  hook: string;
  mood: string;
  description: string;
  scenes: SampleScene[];
}

export interface VoidspaceVideoTemplate {
  id: string;
  name: string;
  shortName: string;
  description: string;
  longDescription: string;
  icon: string; // lucide icon name
  gradient: string; // tailwind gradient classes
  category: TemplateCategory;
  tags: string[];

  // Video generation parameters
  videoStyle: VideoStyle;
  narration: NarrationMode;
  subtitleType: SubtitleType;
  defaultDuration: Duration;
  defaultAspectRatio: AspectRatio;
  storyStyle: StoryStyle;

  // Script guidance
  scriptGuidance: string;
  promptTips: string[];

  // User-editable fields
  fields: TemplateField[];

  // Sample LLM output
  sampleOutput: SampleOutput;
}

// ── Template Definitions ───────────────────────────────────

export const VOIDSPACE_TEMPLATES: VoidspaceVideoTemplate[] = [
  // ─── 1. Story Narration ──────────────────────────────────
  {
    id: "voidspace-story-narration",
    name: "Story Narration",
    shortName: "Story",
    description:
      "Third-person cinematic narrator tells a dramatic story. Perfect for viral TikTok/Reels.",
    longDescription:
      "A cinematic third-person narrator tells your avatar's story with dramatic pacing, emotional beats, and visual storytelling. The narrator voice creates a documentary-like feel that's proven to stop scrollers and drive engagement. Best for life stories, achievements, personal transformations, and motivational content.",
    icon: "BookOpen",
    gradient: "from-violet-600 to-purple-500",
    category: "storytelling",
    tags: ["viral", "cinematic", "motivational", "tiktok"],

    videoStyle: "story",
    narration: "narrator",
    subtitleType: "narration",
    defaultDuration: "30",
    defaultAspectRatio: "9:16",
    storyStyle: "story_narration",

    scriptGuidance:
      "Write a narrative arc for your story. Include a hook that grabs attention in the first 2 seconds, build emotional tension, and end with a powerful resolution or call-to-action.",
    promptTips: [
      "Start with a hook: 'Three months ago, everything changed...'",
      "Build tension through the middle sections",
      "End with a transformation or powerful takeaway",
      "Include visual descriptions for each scene",
    ],

    fields: [
      {
        id: "topic",
        label: "Story Topic",
        type: "textarea",
        placeholder:
          "e.g. My journey from burnout to building a successful business...",
        required: true,
      },
      {
        id: "mood",
        label: "Mood",
        type: "select",
        required: true,
        defaultValue: "inspirational",
        options: [
          { value: "inspirational", label: "Inspirational" },
          { value: "dramatic", label: "Dramatic" },
          { value: "vulnerable", label: "Vulnerable" },
          { value: "triumphant", label: "Triumphant" },
          { value: "mysterious", label: "Mysterious" },
        ],
      },
      {
        id: "key_points",
        label: "Key Story Beats",
        type: "textarea",
        placeholder:
          "List the main moments in your story, one per line...\ne.g.\n- The moment I hit rock bottom\n- The decision to change\n- First small win\n- Where I am now",
        required: false,
      },
      {
        id: "duration",
        label: "Duration",
        type: "select",
        required: true,
        defaultValue: "30",
        options: [
          { value: "20", label: "20 seconds — Quick reel" },
          { value: "30", label: "30 seconds — Standard" },
          { value: "40", label: "40 seconds — Detailed" },
          { value: "60", label: "60 seconds — Deep narrative" },
        ],
      },
    ],

    sampleOutput: {
      title: "From Burnout to Breakthrough",
      template: "narrative_story",
      hook: "Three months ago, they were ready to give up on everything.",
      mood: "inspirational",
      description:
        "A powerful transformation story about overcoming burnout and finding purpose through creativity.",
      scenes: [
        {
          scene_number: 1,
          title: "The Breaking Point",
          text: "Three months ago, they were ready to give up on everything.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Close-up of a young creator staring at a laptop screen in a dark room, bags under their eyes, empty coffee cups scattered around, dim blue screen light casting shadows on their face, mood of exhaustion and defeat",
          mood: "vulnerable",
          visual_style: "intimate close-up",
          duration_seconds: 8,
          voiceover:
            "Three months ago, they were ready to give up on everything. The late nights, the constant grind — it was all leading nowhere.",
        },
        {
          scene_number: 2,
          title: "The Turning Point",
          text: "But then something unexpected happened.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Wide shot of morning sunrise through a bedroom window, warm golden light flooding in, journal and pen on the bedside table, fresh start feeling, hope and possibility in the air",
          mood: "hopeful",
          visual_style: "wide establishing shot",
          duration_seconds: 8,
          voiceover:
            "But one morning, instead of scrolling, they picked up a journal. And for the first time in months, they wrote what they actually felt.",
        },
        {
          scene_number: 3,
          title: "The Transformation",
          text: "Day by day, everything started to shift.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Montage-style scene showing a person writing, then creating on camera, then smiling at growing engagement numbers, warm progression from dim to bright lighting, energy and growth",
          mood: "building",
          visual_style: "dynamic montage",
          duration_seconds: 7,
          voiceover:
            "Day by day, the words turned into videos. The videos turned into a community. And that community became everything they never knew they needed.",
        },
        {
          scene_number: 4,
          title: "The Breakthrough",
          text: "Now they wake up excited. Every single day.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Confident creator sitting at a clean, well-lit desk with a professional camera setup, genuine smile, sunlight streaming in, surrounded by notes of encouragement and a vision board, success and fulfillment",
          mood: "triumphant",
          visual_style: "hero shot",
          duration_seconds: 7,
          voiceover:
            "Now they wake up excited. Not because it's easy — but because it finally means something. Your story matters. Start telling it.",
        },
      ],
    },
  },

  // ─── 2. Vlog ─────────────────────────────────────────────
  {
    id: "voidspace-vlog",
    name: "Vlog — Talk to Camera",
    shortName: "Vlog",
    description:
      "Avatar speaks directly to the audience. Authentic, personal, and engaging.",
    longDescription:
      "Your avatar looks straight into the camera and shares thoughts, updates, reactions, or advice in their own voice. Word-by-word subtitles highlight as they speak for maximum engagement. This is the most personal and authentic format — like a FaceTime call with your audience.",
    icon: "Video",
    gradient: "from-cyan-500 to-blue-500",
    category: "conversational",
    tags: ["personal", "authentic", "direct", "engaging"],

    videoStyle: "vlog",
    narration: "dialogue",
    subtitleType: "word",
    defaultDuration: "20",
    defaultAspectRatio: "9:16",
    storyStyle: "vlog",

    scriptGuidance:
      "Write exactly what your avatar SAYS — like a natural conversation with the viewer. Include energy cues (pause, laugh, lean in) and keep sentences short and punchy.",
    promptTips: [
      "Open with a direct question or bold statement",
      "Write in first person — 'I' not 'they'",
      "Keep energy high, sentences short",
      "Add delivery notes: (whispers), (excited), (pause for effect)",
    ],

    fields: [
      {
        id: "topic",
        label: "What are you talking about?",
        type: "textarea",
        placeholder:
          "e.g. Sharing my top 3 productivity hacks that actually work...",
        required: true,
      },
      {
        id: "tone",
        label: "Tone",
        type: "select",
        required: true,
        defaultValue: "energetic",
        options: [
          { value: "energetic", label: "Energetic & Fun" },
          { value: "chill", label: "Chill & Conversational" },
          { value: "passionate", label: "Passionate & Fired Up" },
          { value: "thoughtful", label: "Thoughtful & Reflective" },
          { value: "funny", label: "Humorous" },
        ],
      },
      {
        id: "key_points",
        label: "Key Talking Points",
        type: "textarea",
        placeholder:
          "List what you want to cover, one per line...\ne.g.\n- Morning routine hack\n- The 2-minute rule\n- Why most people fail",
        required: false,
      },
      {
        id: "duration",
        label: "Duration",
        type: "select",
        required: true,
        defaultValue: "20",
        options: [
          { value: "10", label: "10 seconds — Quick take" },
          { value: "20", label: "20 seconds — Standard reel" },
          { value: "30", label: "30 seconds — Detailed" },
          { value: "60", label: "60 seconds — Full vlog" },
        ],
      },
    ],

    sampleOutput: {
      title: "3 Productivity Hacks That Actually Work",
      template: "direct_talking",
      hook: "Okay stop whatever you're doing — I need to tell you something.",
      mood: "energetic",
      description:
        "Quick, punchy vlog sharing three practical productivity tips that changed my workflow.",
      scenes: [
        {
          scene_number: 1,
          title: "The Hook",
          text: "Okay stop whatever you're doing — I need to tell you something that changed my entire life.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Avatar leaning towards camera with excited expression, bright ring light behind them, modern clean room, pointing at camera, energetic and engaging pose",
          mood: "excited",
          visual_style: "direct to camera close-up",
          duration_seconds: 5,
          dialogue:
            "Okay stop whatever you're doing — I need to tell you something that changed my entire life.",
        },
        {
          scene_number: 2,
          title: "Hack #1",
          text: "Number one — the two minute rule. If it takes less than two minutes, do it NOW.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Avatar counting on fingers, animated text overlay showing '2 MIN RULE' floating beside them, bright studio lighting, enthusiastic teaching gesture",
          mood: "passionate",
          visual_style: "medium shot with text overlay",
          duration_seconds: 5,
          dialogue:
            "Number one — the two minute rule. If it takes less than two minutes, just do it right now. Don't add it to a list.",
        },
        {
          scene_number: 3,
          title: "Hack #2",
          text: "Number two — time blocking. I schedule EVERYTHING. Even lunch.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Split view showing a clean calendar/planner on one side and the avatar pointing at it on the other, organized colorful time blocks visible, productive atmosphere",
          mood: "confident",
          visual_style: "split frame demonstration",
          duration_seconds: 5,
          dialogue:
            "Number two — time blocking. I literally schedule everything in my calendar. Even lunch. Sounds crazy but it works.",
        },
        {
          scene_number: 4,
          title: "Closer",
          text: "Try these for ONE week and watch what happens. You'll thank me later.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Avatar leaning back confidently with arms crossed, warm smile, 'TRY IT' text effect, call-to-action energy, bright positive lighting",
          mood: "confident",
          visual_style: "close-up hero shot",
          duration_seconds: 5,
          dialogue:
            "Try these for just one week and watch what happens. Follow for more — and you're welcome in advance.",
        },
      ],
    },
  },

  // ─── 3. POV Experience ───────────────────────────────────
  {
    id: "voidspace-pov",
    name: "POV Experience",
    shortName: "POV",
    description:
      "First-person immersive storytelling. The viewer IS the main character.",
    longDescription:
      "The viewer becomes the main character through first-person narration and immersive visual perspectives. This format drives huge engagement on TikTok and Reels because it creates an instant emotional connection — the viewer literally sees themselves in the story. Perfect for relatable situations, day-in-my-life content, and storytime videos.",
    icon: "Eye",
    gradient: "from-emerald-500 to-teal-500",
    category: "storytelling",
    tags: ["immersive", "first-person", "relatable", "storytime"],

    videoStyle: "cinematic",
    narration: "dialogue",
    subtitleType: "sentence",
    defaultDuration: "30",
    defaultAspectRatio: "9:16",
    storyStyle: "pov",

    scriptGuidance:
      "Write from the viewer's perspective — they ARE the character. Use 'you' language. Create a scenario they can instantly relate to. Build tension through the situation.",
    promptTips: [
      "Start with 'POV:' to set the scene immediately",
      "Use second-person: 'You walk in and see...'",
      "Create a relatable or surprising situation",
      "End with a twist or emotional payoff",
    ],

    fields: [
      {
        id: "scenario",
        label: "POV Scenario",
        type: "textarea",
        placeholder:
          "e.g. POV: You finally quit your 9-5 and your family asks what you do for a living...",
        required: true,
      },
      {
        id: "mood",
        label: "Mood",
        type: "select",
        required: true,
        defaultValue: "relatable",
        options: [
          { value: "relatable", label: "Relatable & Funny" },
          { value: "dramatic", label: "Dramatic & Intense" },
          { value: "wholesome", label: "Wholesome & Heartwarming" },
          { value: "suspenseful", label: "Suspenseful" },
          { value: "empowering", label: "Empowering" },
        ],
      },
      {
        id: "duration",
        label: "Duration",
        type: "select",
        required: true,
        defaultValue: "30",
        options: [
          { value: "20", label: "20 seconds — Quick POV" },
          { value: "30", label: "30 seconds — Standard" },
          { value: "60", label: "60 seconds — Full story" },
        ],
      },
    ],

    sampleOutput: {
      title: "POV: You Quit Your Job to Follow Your Dream",
      template: "pov",
      hook: "POV: You finally tell your family you quit your 9-5 to be a content creator.",
      mood: "relatable",
      description:
        "A relatable first-person experience of telling your family about your new career path.",
      scenes: [
        {
          scene_number: 1,
          title: "The Setup",
          text: "POV: You finally tell your family you quit your 9-5.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: First-person view at a dinner table, family members sitting across looking expectant, warm indoor lighting, slight tension in the air, phone face-down on table, nervous energy",
          mood: "tense",
          visual_style: "first-person perspective",
          duration_seconds: 8,
          dialogue:
            "So... I have some news. I quit my job. (pause) No, I'm not getting another one. I'm making content now.",
        },
        {
          scene_number: 2,
          title: "The Reactions",
          text: "Everyone goes silent. Then your mom speaks first.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Close-up reaction shots of family members around dinner table, shocked expressions, one person mid-sip of water, another with fork frozen, dramatic lighting contrast",
          mood: "awkward",
          visual_style: "reaction close-ups",
          duration_seconds: 8,
          dialogue:
            "My mom just stares at me. My dad puts his fork down. And my little sister... she goes 'Wait, like on TikTok? That's actually cool.'",
        },
        {
          scene_number: 3,
          title: "The Doubt",
          text: "But you already know — this is exactly what you're supposed to do.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Person sitting alone afterwards looking at their phone showing their content creation stats, small smile forming, moonlight through window, quiet determination, transition from doubt to resolve",
          mood: "determined",
          visual_style: "intimate solo shot",
          duration_seconds: 7,
          dialogue:
            "And honestly? I was terrified. But I looked at what I've been building, and I just knew. This is my path.",
        },
        {
          scene_number: 4,
          title: "The Payoff",
          text: "Fast forward: your content is blowing up and your family is your biggest fan.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Joyful scene of family gathered around a phone watching the creator's viral video, everyone laughing and proud, warm golden lighting, wholesome payoff moment, family love and support",
          mood: "triumphant",
          visual_style: "wide joyful shot",
          duration_seconds: 7,
          dialogue:
            "Fast forward two months and my mom literally sends my videos to all her friends. Sometimes the biggest risk is the best decision you'll ever make.",
        },
      ],
    },
  },

  // ─── 4. Explainer ────────────────────────────────────────
  {
    id: "voidspace-explainer",
    name: "Explainer",
    shortName: "Explainer",
    description:
      "Clear, educational content with a professional narrator. Teach anything.",
    longDescription:
      "A clean, professional narrator breaks down complex topics into easy-to-understand segments. Each scene builds on the last with clear visual cues and supporting graphics. Perfect for tutorials, how-to guides, interesting facts, top lists, and educational content that positions you as an authority.",
    icon: "GraduationCap",
    gradient: "from-amber-500 to-orange-500",
    category: "commercial",
    tags: ["educational", "tutorial", "how-to", "authority"],

    videoStyle: "explainer",
    narration: "narrator",
    subtitleType: "sentence",
    defaultDuration: "30",
    defaultAspectRatio: "9:16",
    storyStyle: "explainer",

    scriptGuidance:
      "Structure your content as a clear lesson: introduce the topic, break it into steps or facts, and summarize the key takeaway. Use simple language and concrete examples.",
    promptTips: [
      "Open with a surprising fact or question",
      "Use numbered steps or clear sections",
      "Include real-world examples or analogies",
      "End with the 'so what' — why this matters",
    ],

    fields: [
      {
        id: "topic",
        label: "What are you explaining?",
        type: "textarea",
        placeholder:
          "e.g. How the algorithm actually decides which content goes viral...",
        required: true,
      },
      {
        id: "audience",
        label: "Target Audience",
        type: "select",
        required: true,
        defaultValue: "general",
        options: [
          { value: "general", label: "General Audience" },
          { value: "beginners", label: "Beginners / New to Topic" },
          { value: "intermediate", label: "Intermediate" },
          { value: "professional", label: "Professionals / Experts" },
        ],
      },
      {
        id: "key_points",
        label: "Key Points to Cover",
        type: "textarea",
        placeholder:
          "List the main points, one per line...\ne.g.\n- Watch time matters most\n- Engagement rate formula\n- Best posting times",
        required: false,
      },
      {
        id: "duration",
        label: "Duration",
        type: "select",
        required: true,
        defaultValue: "30",
        options: [
          { value: "20", label: "20 seconds — Quick fact" },
          { value: "30", label: "30 seconds — Standard explainer" },
          { value: "40", label: "40 seconds — Detailed breakdown" },
          { value: "60", label: "60 seconds — Full tutorial" },
        ],
      },
    ],

    sampleOutput: {
      title: "How the Algorithm Actually Works",
      template: "narrative_story",
      hook: "The algorithm doesn't hate you. You just don't understand it yet.",
      mood: "educational",
      description:
        "Clear breakdown of how social media algorithms decide which content goes viral.",
      scenes: [
        {
          scene_number: 1,
          title: "The Hook",
          text: "The algorithm doesn't hate you — you just don't understand it yet.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: A giant glowing brain-like network floating above a smartphone, data streams flowing through it, person looking up in wonder, tech-meets-magic visual, clean educational aesthetic",
          mood: "intriguing",
          visual_style: "concept visualization",
          duration_seconds: 6,
          voiceover:
            "The algorithm doesn't hate you. It's not random either. Here's exactly how it decides who sees your content.",
        },
        {
          scene_number: 2,
          title: "Step 1: Watch Time",
          text: "Step one: Watch time is king. The algorithm measures every second.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: A stopwatch icon growing larger as more eyes gather around a phone screen, visual metaphor for watch time, charts growing upward, clean infographic style",
          mood: "informative",
          visual_style: "infographic animation",
          duration_seconds: 8,
          voiceover:
            "First, watch time. The algorithm tracks every single second someone spends on your video. The longer they stay, the more it pushes your content to new people.",
        },
        {
          scene_number: 3,
          title: "Step 2: Engagement Signals",
          text: "Step two: It's not just views — it's what people DO after watching.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Multiple floating action icons — hearts, comments, shares, saves — being weighed on a glowing scale, algorithm balance visual, dynamic and clean",
          mood: "analytical",
          visual_style: "diagram visualization",
          duration_seconds: 8,
          voiceover:
            "Second, engagement. Saves are worth more than likes. Shares are worth more than comments. The algorithm weighs every action differently.",
        },
        {
          scene_number: 4,
          title: "The Key Takeaway",
          text: "The secret? Make them watch the whole thing. Everything else follows.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Person confidently creating content with a flowing stream of viewers and engagement symbols, bright and optimistic, success visualization, call-to-action energy",
          mood: "empowering",
          visual_style: "hero conclusion",
          duration_seconds: 8,
          voiceover:
            "The secret is simple: make them watch until the end. Hook them in the first second, deliver value every second after. Do that, and the algorithm works for you, not against you.",
        },
      ],
    },
  },

  // ─── 5. Testimonial ─────────────────────────────────────
  {
    id: "voidspace-testimonial",
    name: "Testimonial",
    shortName: "Testimonial",
    description:
      "Honest personal review or experience sharing. Build trust with your audience.",
    longDescription:
      "An authentic, personal testimonial where your avatar shares their genuine experience with a product, service, or life change. The conversational delivery builds trust and relatability. Includes reaction cutaways and honest reflection moments. Perfect for product reviews, experience sharing, and building credibility.",
    icon: "MessageSquareHeart",
    gradient: "from-rose-500 to-pink-500",
    category: "conversational",
    tags: ["review", "trust", "authentic", "personal"],

    videoStyle: "vlog",
    narration: "dialogue",
    subtitleType: "word",
    defaultDuration: "30",
    defaultAspectRatio: "9:16",
    storyStyle: "testimonial",

    scriptGuidance:
      "Be genuine and specific. Share what you expected, what actually happened, and your honest verdict. Include specific details that prove you actually tried it.",
    promptTips: [
      "Start with your initial skepticism or excitement",
      "Share specific, concrete details (not vague claims)",
      "Be honest about downsides — it builds trust",
      "End with a clear recommendation (or not)",
    ],

    fields: [
      {
        id: "subject",
        label: "What are you reviewing?",
        type: "textarea",
        placeholder:
          "e.g. My honest review after 30 days of using this AI video tool...",
        required: true,
      },
      {
        id: "verdict",
        label: "Overall Verdict",
        type: "select",
        required: true,
        defaultValue: "positive",
        options: [
          { value: "positive", label: "Positive — Recommend it" },
          { value: "mixed", label: "Mixed — Pros and cons" },
          { value: "transformative", label: "Life-changing" },
          { value: "surprising", label: "Surprisingly good/bad" },
        ],
      },
      {
        id: "key_points",
        label: "Key Points",
        type: "textarea",
        placeholder:
          "e.g.\n- What I expected vs reality\n- The biggest surprise\n- Who it's perfect for\n- My honest rating",
        required: false,
      },
      {
        id: "duration",
        label: "Duration",
        type: "select",
        required: true,
        defaultValue: "30",
        options: [
          { value: "20", label: "20 seconds — Quick take" },
          { value: "30", label: "30 seconds — Full review" },
          { value: "60", label: "60 seconds — Deep dive" },
        ],
      },
    ],

    sampleOutput: {
      title: "My Honest 30-Day Review",
      template: "direct_talking",
      hook: "I've been using this for 30 days and I need to be honest with you.",
      mood: "authentic",
      description:
        "A genuine personal review sharing real experience, honest pros/cons, and a clear recommendation.",
      scenes: [
        {
          scene_number: 1,
          title: "The Setup",
          text: "I've been using this for 30 days straight and I need to be completely honest.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Avatar sitting casually in a modern living room, looking directly at camera with a serious but warm expression, soft natural lighting, product visible in background, authenticity vibes",
          mood: "honest",
          visual_style: "direct to camera",
          duration_seconds: 7,
          dialogue:
            "Okay so I've been using this for 30 days straight now and I need to be completely honest with you about my experience.",
        },
        {
          scene_number: 2,
          title: "The Experience",
          text: "Here's what actually happened — not what I expected.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Before-and-after style scene, one side showing frustration and the other showing positive results, split composition, dramatic contrast, honest storytelling visual",
          mood: "surprised",
          visual_style: "split demonstration",
          duration_seconds: 8,
          dialogue:
            "At first I thought it was just hype. But by week two? I noticed a real difference. My workflow completely changed.",
        },
        {
          scene_number: 3,
          title: "The Honest Take",
          text: "Is it perfect? No. But here's why I keep using it.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Avatar leaning forward with a thoughtful expression, pros and cons floating as small cards around them, balanced evaluation visual, warm lighting, trust-building moment",
          mood: "thoughtful",
          visual_style: "close-up reflection",
          duration_seconds: 8,
          dialogue:
            "Is it perfect? No. There are definitely things I'd improve. But the time it saves me — honestly that alone makes it worth it.",
        },
        {
          scene_number: 4,
          title: "The Verdict",
          text: "My final verdict after 30 days.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Avatar giving a confident thumbs up with a genuine smile, rating stars floating beside them, bright positive lighting, conclusive and trustworthy, clear recommendation energy",
          mood: "confident",
          visual_style: "final verdict hero",
          duration_seconds: 7,
          dialogue:
            "My final verdict? Eight out of ten. I'd recommend it to anyone who wants to save time. Link in my bio if you want to try it.",
        },
      ],
    },
  },

  // ─── 6. Music Video ──────────────────────────────────────
  {
    id: "voidspace-music-video",
    name: "Music Video",
    shortName: "Music",
    description:
      "Cinematic visuals synced to music with optional lyrics display. No speech needed.",
    longDescription:
      "Create stunning visuals synced to a music track with optional lyric display. The AI generates scene-by-scene imagery that matches the mood and rhythm of your music. No narration — the music and visuals tell the story. Supports LRC/JSON lyrics for word-level or line-level display. Perfect for original music, mood pieces, aesthetic content, and lyric videos.",
    icon: "Music",
    gradient: "from-fuchsia-500 to-rose-500",
    category: "creative",
    tags: ["music", "aesthetic", "lyrics", "cinematic"],

    videoStyle: "cinematic",
    narration: "false",
    subtitleType: "lyrics",
    defaultDuration: "60",
    defaultAspectRatio: "9:16",
    storyStyle: "music_video",

    scriptGuidance:
      "Describe the visual mood and scenes you want for your music. The AI will generate imagery that matches each section of the song. If you have lyrics, include them with timestamps for synced display.",
    promptTips: [
      "Describe the overall visual mood (dark, dreamy, energetic, etc.)",
      "Match visual transitions to musical sections (verse, chorus, bridge)",
      "Include lyrics with LRC timestamps if you have them",
      "Describe specific visual moments for key musical beats",
    ],

    fields: [
      {
        id: "music_description",
        label: "Describe Your Music",
        type: "textarea",
        placeholder:
          "e.g. An emotional indie pop track about moving to a new city. Starts slow piano, builds to a full band chorus...",
        required: true,
      },
      {
        id: "visual_mood",
        label: "Visual Mood",
        type: "select",
        required: true,
        defaultValue: "cinematic",
        options: [
          { value: "cinematic", label: "Cinematic & Dramatic" },
          { value: "dreamy", label: "Dreamy & Ethereal" },
          { value: "energetic", label: "Energetic & Bold" },
          { value: "dark", label: "Dark & Moody" },
          { value: "colorful", label: "Colorful & Vibrant" },
          { value: "minimal", label: "Minimal & Clean" },
        ],
      },
      {
        id: "lyrics",
        label: "Lyrics (optional)",
        type: "textarea",
        placeholder:
          "Paste your lyrics here. For synced display, use LRC format:\n[00:05.00]First line of lyrics\n[00:10.50]Second line\n[00:15.20]Third line",
        required: false,
      },
      {
        id: "duration",
        label: "Duration",
        type: "select",
        required: true,
        defaultValue: "60",
        options: [
          { value: "30", label: "30 seconds — Clip/Preview" },
          { value: "40", label: "40 seconds — Short version" },
          { value: "50", label: "50 seconds — Extended" },
          { value: "60", label: "60 seconds — Full section" },
        ],
      },
    ],

    sampleOutput: {
      title: "Moving Forward — Visual Music Experience",
      template: "music_video",
      hook: "A cinematic visual journey through change and new beginnings.",
      mood: "cinematic",
      description:
        "Atmospheric music video with synced visuals and lyrics, telling a story of transformation through imagery alone.",
      scenes: [
        {
          scene_number: 1,
          title: "Intro — Piano",
          text: "[00:00] Slow piano notes over empty streets at dawn",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Empty city street at dawn, soft blue and gold lighting, lone figure walking in the distance, fog rolling through, piano-mood atmospheric, melancholy beauty, cinematic wide angle",
          mood: "melancholy",
          visual_style: "wide atmospheric",
          duration_seconds: 15,
        },
        {
          scene_number: 2,
          title: "Verse — Building",
          text: "[00:15] Memories flash by like passing car headlights",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Montage of flowing memories — photos, handwritten letters, packed boxes, a plane ticket — all streaming through a tunnel of golden light, emotional nostalgia, dynamic movement",
          mood: "nostalgic",
          visual_style: "flowing montage",
          duration_seconds: 15,
        },
        {
          scene_number: 3,
          title: "Chorus — Full Band",
          text: "[00:30] The world opens up — new city, new possibilities",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Person stepping out of a train station into a vibrant new city, buildings towering with colorful neon, energy and excitement, wide angle showing the scale of possibility, sunrise behind skyline",
          mood: "hopeful",
          visual_style: "grand establishing shot",
          duration_seconds: 15,
        },
        {
          scene_number: 4,
          title: "Outro — Resolution",
          text: "[00:45] Standing on a rooftop, looking forward — not back",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Person standing on a rooftop at golden hour, city sprawling below, arms slightly open as if embracing the future, warm golden backlighting, peaceful resolution, beautiful wide composition",
          mood: "peaceful",
          visual_style: "hero silhouette wide",
          duration_seconds: 15,
        },
      ],
    },
  },

  // ─── 7. Product Showcase ─────────────────────────────────
  {
    id: "voidspace-product-showcase",
    name: "Product Showcase",
    shortName: "Product",
    description:
      "Highlight a product or feature with dynamic demos and clear benefits.",
    longDescription:
      "A professional product highlight that showcases features, benefits, and use cases through dynamic visual demonstrations. Your avatar presents with authority while close-up shots and overlays demonstrate the product in action. Word-by-word subtitles ensure key messages land. Perfect for product launches, feature highlights, app demos, and promotional content.",
    icon: "ShoppingBag",
    gradient: "from-indigo-500 to-violet-500",
    category: "commercial",
    tags: ["product", "promo", "demo", "marketing"],

    videoStyle: "brand",
    narration: "dialogue",
    subtitleType: "word",
    defaultDuration: "30",
    defaultAspectRatio: "9:16",
    storyStyle: "product_showcase",

    scriptGuidance:
      "Lead with the problem your product solves, show it in action, highlight 2-3 key benefits, and end with a clear call-to-action. Keep it benefit-focused, not feature-focused.",
    promptTips: [
      "Start with the pain point your audience knows well",
      "Show, don't just tell — describe visual demonstrations",
      "Focus on 2-3 benefits, not a feature dump",
      "End with a clear, single call-to-action",
    ],

    fields: [
      {
        id: "product",
        label: "What are you showcasing?",
        type: "textarea",
        placeholder:
          "e.g. Our new AI video editor that turns text into professional videos in 60 seconds...",
        required: true,
      },
      {
        id: "style",
        label: "Presentation Style",
        type: "select",
        required: true,
        defaultValue: "demo",
        options: [
          { value: "demo", label: "Live Demo / Walkthrough" },
          { value: "benefits", label: "Benefits-First" },
          { value: "comparison", label: "Before vs After" },
          { value: "launch", label: "New Launch Announcement" },
        ],
      },
      {
        id: "key_benefits",
        label: "Key Benefits",
        type: "textarea",
        placeholder:
          "e.g.\n- Saves 10 hours per week\n- No design skills needed\n- Works with any content",
        required: false,
      },
      {
        id: "cta",
        label: "Call to Action",
        type: "text",
        placeholder: "e.g. Try it free — link in bio",
        required: false,
        defaultValue: "Link in bio to try it free",
      },
      {
        id: "duration",
        label: "Duration",
        type: "select",
        required: true,
        defaultValue: "30",
        options: [
          { value: "20", label: "20 seconds — Quick promo" },
          { value: "30", label: "30 seconds — Standard" },
          { value: "60", label: "60 seconds — Full showcase" },
        ],
      },
    ],

    sampleOutput: {
      title: "This Tool Changes Everything",
      template: "direct_talking",
      hook: "What if I told you you could create a professional video in 60 seconds?",
      mood: "energetic",
      description:
        "Dynamic product showcase highlighting key benefits with live demo moments and a clear call-to-action.",
      scenes: [
        {
          scene_number: 1,
          title: "The Problem",
          text: "Making videos used to take me HOURS. Scripting, filming, editing — I almost gave up.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Frustrated creator at a desk surrounded by complicated editing software windows, hair messy, clock showing late hours, visual representation of video creation pain, overwhelming complexity",
          mood: "frustrated",
          visual_style: "problem visualization",
          duration_seconds: 7,
          dialogue:
            "Making videos used to take me hours. Scripting, filming, editing — honestly I almost gave up on content creation entirely.",
        },
        {
          scene_number: 2,
          title: "The Solution",
          text: "Then I found this. Type your idea, pick a style, and boom — professional video.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Clean, modern interface glowing on screen, text being typed transforming into a beautiful video preview, magic sparkle effects, transformation moment, sleek and impressive",
          mood: "amazed",
          visual_style: "product reveal",
          duration_seconds: 8,
          dialogue:
            "Then I found this tool. You literally type your idea, pick a style, and it creates a professional video for you. In sixty seconds.",
        },
        {
          scene_number: 3,
          title: "The Proof",
          text: "I made this entire video using it right now. No filming. No editing.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Person confidently showing their phone with the video playing on it, multiple example videos arranged around them like a portfolio, proof and results, bright confident energy",
          mood: "confident",
          visual_style: "proof demonstration",
          duration_seconds: 8,
          dialogue:
            "In fact — this video you're watching right now? I made it with the tool. No camera. No editor. Just my idea and sixty seconds.",
        },
        {
          scene_number: 4,
          title: "The CTA",
          text: "Try it free. Link in bio. You'll thank me later.",
          first_frame_image_description:
            "VIBRANT DISNEY-PIXAR 3D: Avatar pointing at a 'Try Free' button with an inviting gesture, bright call-to-action energy, confetti and celebration vibes, professional and exciting close",
          mood: "persuasive",
          visual_style: "call-to-action hero",
          duration_seconds: 7,
          dialogue:
            "Seriously, try it free. Link is in my bio. This is the future of content creation and you're gonna thank me later.",
        },
      ],
    },
  },
];

// ── "Create from Scratch" Template ─────────────────────────

export const CREATE_FROM_SCRATCH_TEMPLATE: VoidspaceVideoTemplate = {
  id: "voidspace-create-from-scratch",
  name: "Create from Scratch",
  shortName: "Custom",
  description:
    "Write your own script with full creative control over every detail.",
  longDescription:
    "Start with a blank canvas. Paste your script or write it from scratch. You control the video style, narration, mood, duration, and visual direction. Use the sample format below to structure your scenes — include a visual description and voiceover/dialogue for each.",
  icon: "PenLine",
  gradient: "from-zinc-600 to-slate-700",
  category: "creative",
  tags: ["custom", "freeform", "advanced", "blank"],

  videoStyle: "story",
  narration: "narrator",
  subtitleType: "word",
  defaultDuration: "30",
  defaultAspectRatio: "9:16",
  storyStyle: "story_narration",

  scriptGuidance:
    "Write your complete video script below. Structure it as a sequence of scenes — each with a visual description and the voiceover or dialogue. You can also paste a blog post, article, or raw script and we'll format it into scenes.",
  promptTips: [
    "Paste a full script, blog post, or article — AI will break it into scenes",
    "Include visual directions: 'Show a sunset over the ocean' or 'Close-up of hands typing'",
    "Add voiceover or dialogue for each section",
    "Specify mood: 'upbeat and energetic' or 'calm and reflective'",
    "Include any URLs or references you want to incorporate",
  ],

  fields: [
    {
      id: "topic",
      label: "Video Topic / Title",
      type: "text",
      placeholder: "e.g. Why I quit my job to become a full-time creator",
      required: true,
    },
    {
      id: "script",
      label: "Full Script or Content",
      type: "textarea",
      placeholder:
        "Paste your script, blog post, or raw content here...\n\nExample format:\n\nScene 1: [Visual: Person at desk late at night]\nVoiceover: \"It was 2 AM and I couldn't sleep...\"\n\nScene 2: [Visual: Morning sunrise over city]\nVoiceover: \"The next morning, everything changed...\"",
      required: true,
    },
    {
      id: "style",
      label: "Video Style",
      type: "select",
      required: true,
      defaultValue: "story",
      options: [
        { value: "story", label: "Story / Cinematic" },
        { value: "vlog", label: "Vlog / Personal" },
        { value: "explainer", label: "Explainer / Educational" },
        { value: "cinematic", label: "Cinematic / Visual" },
        { value: "fun", label: "Fun / Casual" },
        { value: "brand", label: "Brand / Professional" },
      ],
    },
    {
      id: "narrationMode",
      label: "Narration Mode",
      type: "select",
      required: true,
      defaultValue: "narrator",
      options: [
        { value: "narrator", label: "Third-person Narrator" },
        { value: "dialogue", label: "Direct Dialogue (talking to camera)" },
        { value: "false", label: "No speech (music only)" },
      ],
    },
    {
      id: "mood",
      label: "Mood & Tone",
      type: "text",
      placeholder:
        "e.g. inspirational, dramatic, upbeat, calm, mysterious",
      required: false,
    },
    {
      id: "duration",
      label: "Duration",
      type: "select",
      required: true,
      defaultValue: "30",
      options: [
        { value: "10", label: "10 seconds" },
        { value: "20", label: "20 seconds" },
        { value: "30", label: "30 seconds" },
        { value: "40", label: "40 seconds" },
        { value: "50", label: "50 seconds" },
        { value: "60", label: "60 seconds" },
      ],
    },
    {
      id: "aspectRatio",
      label: "Aspect Ratio",
      type: "select",
      required: true,
      defaultValue: "9:16",
      options: [
        { value: "9:16", label: "Vertical (9:16) — TikTok, Reels, Shorts" },
        { value: "16:9", label: "Horizontal (16:9) — YouTube" },
        { value: "1:1", label: "Square (1:1) — Instagram" },
      ],
    },
  ],

  sampleOutput: {
    title: "Why I Quit My Job to Become a Full-Time Creator",
    template: "custom",
    hook: "I walked into my boss's office and said 'I quit.'",
    mood: "inspirational",
    description:
      "A personal story about leaving corporate life to pursue content creation full-time.",
    scenes: [
      {
        scene_number: 1,
        title: "The Decision",
        text: "Late night in the office, staring at a screen full of spreadsheets.",
        first_frame_image_description:
          "A dimly lit office cubicle at night, computer screen glowing with Excel spreadsheets, an empty coffee cup on the desk. The worker looks exhausted and contemplative.",
        mood: "introspective",
        visual_style: "cinematic, moody lighting, shallow depth of field",
        duration_seconds: 8,
        voiceover:
          "It was 2 AM on a Tuesday. I was alone in the office, and I realized I couldn't remember the last time I was excited to wake up in the morning.",
      },
      {
        scene_number: 2,
        title: "The Turning Point",
        text: "A viral video notification pops up on the phone.",
        first_frame_image_description:
          "Close-up of a phone screen showing a social media notification with thousands of likes and comments. The room is dark, the phone illuminating the person's face.",
        mood: "hopeful",
        visual_style: "warm lighting, intimate close-up",
        duration_seconds: 7,
        voiceover:
          "Then my phone buzzed. A video I'd made on a whim — just me talking about what I wished I'd known at 20 — had reached a million views overnight.",
      },
      {
        scene_number: 3,
        title: "The Leap",
        text: "Walking out of the office building into sunlight.",
        first_frame_image_description:
          "A person pushing open glass office doors, stepping into bright golden sunlight. They carry a small box of personal items. Expression shows a mix of fear and excitement.",
        mood: "liberating",
        visual_style: "bright, overexposed sunlight, slow motion",
        duration_seconds: 8,
        voiceover:
          "Two weeks later, I walked into my boss's office. My hands were shaking. But I said the words I'd been rehearsing: 'I quit.'",
      },
      {
        scene_number: 4,
        title: "The New Beginning",
        text: "Setting up a home studio, creating content with confidence.",
        first_frame_image_description:
          "A cozy home studio space with ring light, camera on tripod, laptop open with editing software. The person sits confidently, smiling at the camera.",
        mood: "empowered",
        visual_style: "warm, natural lighting, clean aesthetic",
        duration_seconds: 7,
        voiceover:
          "That was six months ago. Today I wake up excited. I create what I want, connect with people who care, and for the first time — I feel alive.",
      },
    ],
  },
};

// ── Helper Functions ───────────────────────────────────────

export const TEMPLATE_CATEGORIES: {
  id: TemplateCategory | "all";
  label: string;
  icon: string;
}[] = [
  { id: "all", label: "All Templates", icon: "LayoutGrid" },
  { id: "storytelling", label: "Storytelling", icon: "BookOpen" },
  { id: "conversational", label: "Conversational", icon: "MessageCircle" },
  { id: "creative", label: "Creative", icon: "Sparkles" },
  { id: "commercial", label: "Commercial", icon: "TrendingUp" },
];

export function getTemplatesByCategory(
  category: TemplateCategory | "all",
): VoidspaceVideoTemplate[] {
  if (category === "all") return VOIDSPACE_TEMPLATES;
  return VOIDSPACE_TEMPLATES.filter((t) => t.category === category);
}

export function getTemplateById(
  id: string,
): VoidspaceVideoTemplate | undefined {
  return (
    VOIDSPACE_TEMPLATES.find((t) => t.id === id) ??
    (id === CREATE_FROM_SCRATCH_TEMPLATE.id
      ? CREATE_FROM_SCRATCH_TEMPLATE
      : undefined)
  );
}
