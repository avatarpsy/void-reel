import React from "react";
import { Switch } from "@openreel/ui";
import { Label } from "@openreel/ui";
import { useSettingsStore } from "../../../stores/settings-store";

const RAM_OPTIONS = [
  { value: 0.5, label: "512 MB" },
  { value: 1, label: "1 GB" },
  { value: 2, label: "2 GB" },
  { value: 4, label: "4 GB" },
  { value: 8, label: "8 GB" },
  { value: 16, label: "16 GB" },
  { value: 32, label: "32 GB" },
];

export const GeneralPanel: React.FC = () => {
  const {
    autoSave,
    autoSaveInterval,
    ramPreviewMaxGB,
    setAutoSave,
    setAutoSaveInterval,
    setRamPreviewMaxGB,
  } = useSettingsStore();

  return (
    <div className="space-y-6 pb-4">
      {/* Auto-save */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text-primary">Auto-Save</h3>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm text-text-secondary">Enable auto-save</Label>
            <p className="text-xs text-text-muted mt-0.5">
              Automatically save your project at regular intervals
            </p>
          </div>
          <Switch checked={autoSave} onCheckedChange={setAutoSave} />
        </div>

        {autoSave && (
          <div className="flex items-center gap-3">
            <Label className="text-sm text-text-secondary whitespace-nowrap">
              Save every
            </Label>
            <select
              value={autoSaveInterval}
              onChange={(e) => setAutoSaveInterval(Number(e.target.value))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value={1}>1 minute</option>
              <option value={2}>2 minutes</option>
              <option value={5}>5 minutes</option>
              <option value={10}>10 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
            </select>
          </div>
        )}
      </div>

      <div className="h-px bg-border" />

      {/* RAM Preview */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text-primary">RAM Preview</h3>
        <p className="text-xs text-text-muted">
          Frames are cached in memory during playback. Second play is instant
          and smooth. Higher limit = more cached footage.
        </p>

        <div className="flex items-center justify-between">
          <Label className="text-sm text-text-secondary">
            Maximum RAM for preview cache
          </Label>
          <select
            value={ramPreviewMaxGB}
            onChange={(e) => setRamPreviewMaxGB(Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-[120px]"
          >
            {RAM_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
};
