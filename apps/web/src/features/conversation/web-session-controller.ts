import { displaySessionTitle, isSessionListed } from "@agentkib/session-catalog";
import {
  useSessionController as useSharedSessionController,
  type SessionOptions as SharedSessionOptions,
} from "@agentkib/session-ui";
import { dictionaries, type Locale } from "./i18n";
import { sessionImages, webSessionPlatform } from "./session-platform";

export type SessionOptions = Omit<SharedSessionOptions, "initialSessionId" | "readInitialCatalog">;

const usePlatform = () => webSessionPlatform;
const words = (locale: Locale) => dictionaries[locale];

export function useSessionController(options: SessionOptions) {
  return useSharedSessionController(options, {
    usePlatform,
    words,
    sessionImages,
    displaySessionTitle,
    isSessionListed,
  });
}

export type SessionController = ReturnType<typeof useSessionController>;
