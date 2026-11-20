import { useRef } from "react";
import type { CodexSessionSettings, Live } from "@agentkib/web-client";
import type { ComposerModelPickerHandle } from "./composer-model-picker";

export function useComposerModelPanel() {
  const pickerRef = useRef<ComposerModelPickerHandle>(null);
  const refreshOnOpen = useRef(false);

  function open(page: "models" | "effort", available: boolean, refresh = false) {
    if (!available || !pickerRef.current) return false;
    refreshOnOpen.current = refresh;
    pickerRef.current.open(page);
    return true;
  }

  function modelActions({
    settings,
    stale,
    settingsError,
    prepare,
    refresh,
    terminal,
  }: {
    settings?: CodexSessionSettings;
    stale: boolean;
    settingsError: string;
    prepare: () => void;
    refresh?: () => void;
    terminal: {
      offered: boolean;
      settingsReadable: boolean;
      sessionId: string;
      live?: Live | null;
      ready: boolean;
      online: boolean;
      blocked: boolean;
      open: () => Promise<boolean>;
    };
  }) {
    const terminalLive =
      terminal.live?.sessionId === terminal.sessionId &&
      terminal.live.executionMode === "claude-follower"
        ? terminal.live
        : undefined;
    const terminalPickerOpen =
      terminal.online && terminalLive?.reason === "claude-model-picker-open";
    const terminalPickerAvailable =
      terminal.offered &&
      terminal.settingsReadable &&
      terminalLive !== undefined &&
      terminal.ready &&
      terminal.online &&
      !terminalPickerOpen &&
      !terminal.blocked;
    return {
      pickerRef,
      terminalPickerOpen,
      onOpenTerminalPicker: terminalPickerAvailable ? terminal.open : undefined,
      onOpen: () => {
        const requestedRefresh = refreshOnOpen.current;
        refreshOnOpen.current = false;
        if (
          requestedRefresh ||
          stale ||
          settingsError ||
          !settings?.available ||
          !settings.options.models.length
        )
          prepare();
        else refresh?.();
      },
    };
  }

  return { open, modelActions };
}
