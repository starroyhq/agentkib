import { SessionPlatformProvider } from "@agentkib/session-ui";
import { render as renderReact, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { WebClient } from "@agentkib/web-client";
import { useDesktopSessionPlatform } from "./session-platform";

const client = new WebClient();

export function render(ui: ReactNode, options?: RenderOptions) {
  const Wrapper = options?.wrapper;
  function ReaderPlatform({ children }: { children: ReactNode }) {
    const platform = useDesktopSessionPlatform(client);
    return (
      <SessionPlatformProvider platform={platform}>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </SessionPlatformProvider>
    );
  }
  return renderReact(ui, { ...options, wrapper: ReaderPlatform });
}
