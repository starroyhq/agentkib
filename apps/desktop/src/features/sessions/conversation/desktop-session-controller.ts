import { displaySessionTitle, isSessionListed } from "@agentkib/session-catalog";
import {
  useSessionController as useSharedSessionController,
  type SessionOptions as SharedSessionOptions,
} from "@agentkib/session-ui";
import { conversationWords } from "@/core/i18n";
import { sessionImages, useDesktopSessionPlatform } from "./session-platform";

export { settingsNoticeGroup, type SettingsNotice } from "@agentkib/session-ui";
export type SessionOptions = SharedSessionOptions;

export function useSessionController(options: SessionOptions) {
  return useSharedSessionController(options, {
    usePlatform: useDesktopSessionPlatform,
    words: conversationWords,
    sessionImages,
    displaySessionTitle,
    isSessionListed,
  });
}

export type SessionController = ReturnType<typeof useSessionController>;
