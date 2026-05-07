import React from "react";
import { Settings } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@openreel/ui";
import { useSettingsStore } from "../../../stores/settings-store";
import { GeneralPanel } from "./GeneralPanel";

export const SettingsDialog: React.FC = () => {
  const { settingsOpen, closeSettings } = useSettingsStore();

  return (
    <Dialog open={settingsOpen} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] bg-background flex flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings size={18} className="text-primary" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Configure editor preferences.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1 mt-2">
          <GeneralPanel />
        </div>
      </DialogContent>
    </Dialog>
  );
};
