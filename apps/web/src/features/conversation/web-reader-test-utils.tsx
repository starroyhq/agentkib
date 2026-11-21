import { SessionPlatformProvider } from "@agentkib/session-ui";
import { render as renderReact, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { webSessionPlatform } from "./session-platform";

export function render(ui: ReactNode, options?: RenderOptions) {
  const Wrapper = options?.wrapper;
  function ReaderPlatform({ children }: { children: ReactNode }) {
    const platform = webSessionPlatform;
    return (
      <SessionPlatformProvider platform={platform}>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </SessionPlatformProvider>
    );
  }
  return renderReact(ui, { ...options, wrapper: ReaderPlatform });
}
