import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";

export function MobileBlocker() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // An embedded desktop editor becomes narrow when its chat opens. Width
    // describes its pane, not the user's device, and must not block editing.
    setIsMobile(
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i.test(navigator.userAgent),
    );
  }, []);

  if (!isMobile) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-background flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-8">
        <div className="flex justify-center">
          <div className="bg-background-secondary border-2 border-primary/30 rounded-2xl p-8 shadow-glow-lg">
            <Monitor className="w-20 h-20 text-primary" strokeWidth={1.5} />
          </div>
        </div>

        <div className="space-y-3">
          <h1 className="text-5xl font-bold text-text-primary tracking-tight">
            Voidspace Studio
          </h1>
          <div className="flex items-center justify-center gap-2">
            <div className="h-px w-8 bg-primary/50" />
            <p className="text-lg text-text-secondary font-medium">
              Desktop Only
            </p>
            <div className="h-px w-8 bg-primary/50" />
          </div>
        </div>

        <div className="space-y-4 bg-background-secondary/50 backdrop-blur-sm rounded-xl p-6 border border-border">
          <p className="text-base text-text-primary leading-relaxed">
            Voidspace Studio is a professional video editor that requires a
            desktop or laptop computer.
          </p>
          <p className="text-sm text-text-muted">
            Please visit this page on your desktop or laptop to edit your
            AI-generated videos.
          </p>
        </div>

        <div className="pt-2">
          <a
            href="https://voidspace.ai"
            className="inline-flex items-center gap-2 px-8 py-3 bg-primary hover:bg-primary-hover active:bg-primary-active text-white font-medium rounded-lg transition-all duration-200 shadow-glow hover:shadow-glow-lg transform hover:scale-[1.02] active:scale-[0.98]"
          >
            Learn More
          </a>
        </div>
      </div>
    </div>
  );
}
