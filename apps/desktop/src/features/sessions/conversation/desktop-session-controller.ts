import { useEffect } from "react";
import { displaySessionTitle, isSessionListed } from "@agentkib/session-catalog";
import {
  useSessionController as useSharedSessionController,
  type SessionOptions as SharedSessionOptions,
} from "@agentkib/session-ui";
import { conversationWords } from "@/core/i18n";
import { rememberSessionTitlePreview } from "../session-preview-titles";
import { sessionImages, useDesktopSessionPlatform } from "./session-platform";

export { settingsNoticeGroup, type SettingsNotice } from "@agentkib/session-ui";
export type SessionOptions = SharedSessionOptions;

export function useSessionController(options: SessionOptions) {
  const controller = useSharedSessionController(options, {
    usePlatform: useDesktopSessionPlatform,
    words: conversationWords,
    sessionImages,
    displaySessionTitle,
    isSessionListed,
  });
  const sessionId = controller.selected;
  const firstUserMessage = controller.page?.events.find(
    (event) => event.kind === "user-message" && event.content?.trim(),
  )?.content;
  useEffect(() => {
    if (sessionId && firstUserMessage) {
      rememberSessionTitlePreview(sessionId, firstUserMessage);
    }
  }, [sessionId, firstUserMessage]);
  return controller;
}

export type SessionController = ReturnType<typeof useSessionController>;
