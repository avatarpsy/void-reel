/**
 * What is running in the background, said quietly.
 *
 * ── WHAT THIS USED TO BE, AND WHY IT CHANGED ────────────────────────────────
 * A full-screen scrim over the preview with a card in the middle reading
 * "Processing Effects — please wait while effects are being applied". That was
 * written when the only tasks here were destructive per-clip effects. It is now
 * also how a graphic render reports itself, and the mismatch was loud: dragging
 * a block onto the timeline blacked out the picture, told the user to wait, and
 * called their lower third an effect. Nothing was actually blocked — the scrim
 * only LOOKED modal — so it was pure interruption.
 *
 * So: a small card in the corner of the preview. It never covers the picture,
 * it never claims to be blocking, and it says what is actually happening. The
 * work it reports is genuinely background work — the user can keep cutting while
 * a graphic renders on their machine, and now they can see that they can.
 *
 * ── WHY FAILURES LINGER AND SUCCESSES DO NOT ────────────────────────────────
 * A finished task disappears; the result is on the timeline and saying so twice
 * is noise. A FAILED one stays until it is dismissed, because "the desktop app
 * is not connected" is the whole explanation for why nothing appeared, and a
 * toast that vanishes is useless for "why did that fail?" — the same rule the
 * library panel's result line follows.
 */
import React, { useState } from "react";
import { Loader2, X, AlertCircle } from "lucide-react";
import {
  useProcessingStore,
  PROCESSING_TYPE_LABELS,
  type ProcessingTask,
} from "../../services/processing-manager";

/** One line. Deliberately one line: the label, its progress, its note. */
const TaskRow: React.FC<{ task: ProcessingTask; onDismiss?: () => void }> = ({
  task,
  onDismiss,
}) => {
  const failed = task.status === "failed";
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <div className="mt-0.5 shrink-0">
        {failed ? (
          <AlertCircle size={13} className="text-error" />
        ) : (
          <Loader2 size={13} className="text-primary animate-spin" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-medium text-text-primary truncate">
            {PROCESSING_TYPE_LABELS[task.type]}
          </span>
          {!failed && (
            <span className="text-[10px] text-text-muted font-mono tabular-nums shrink-0">
              {task.progress}%
            </span>
          )}
        </div>
        {/* The message carries the detail — which block, on whose machine. */}
        <p
          className={`text-[10px] leading-snug mt-0.5 ${
            failed ? "text-error/90" : "text-text-muted"
          }`}
        >
          {failed ? task.error || "Failed" : task.message}
        </p>
        {!failed && (
          /* A hairline, not a bar. It is a hint of pace, not the subject. */
          <div className="mt-1.5 h-px w-full bg-border/60 overflow-hidden rounded-full">
            <div
              className="h-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${Math.max(4, Math.min(100, task.progress))}%` }}
            />
          </div>
        )}
      </div>
      {failed && onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          className="shrink-0 -mr-1 p-0.5 rounded text-text-muted hover:text-text-primary transition-colors"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
};

export const ProcessingOverlay: React.FC = () => {
  const { tasks, removeTask } = useProcessingStore();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const shown = Array.from(tasks.values()).filter(
    (t) =>
      (t.status === "queued" || t.status === "processing" || t.status === "failed") &&
      !dismissed.has(t.id),
  );

  if (shown.length === 0) return null;

  /**
   * Bottom-left, above the transport. The picture is centred, so a corner card
   * sits over letterboxing rather than over the frame in every aspect the
   * editor supports.
   *
   * `pointer-events-none` on the wrapper and `auto` on the card: the area
   * around it must stay clickable — this is a status readout, not a dialog.
   */
  return (
    <div className="absolute inset-x-0 bottom-0 z-40 p-3 flex justify-start pointer-events-none">
      <div
        className="pointer-events-auto w-[260px] max-w-[calc(100%-1.5rem)] rounded-lg
                   border border-border/80 bg-background-secondary/85 backdrop-blur-md
                   shadow-lg shadow-black/20 px-3 py-1.5
                   divide-y divide-border/50"
      >
        {shown.slice(0, 3).map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onDismiss={() => {
              setDismissed((d) => new Set(d).add(task.id));
              removeTask(task.id);
            }}
          />
        ))}
        {shown.length > 3 && (
          <p className="text-[10px] text-text-muted py-1.5">
            +{shown.length - 3} more
          </p>
        )}
      </div>
    </div>
  );
};

export default ProcessingOverlay;
