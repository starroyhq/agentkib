// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { displaySessionTitle } from "./session-title";

describe("displaySessionTitle", () => {
  beforeAll(() => initializeI18n("en-US"));

  it("hides cached internal AGENTS instructions", () => {
    expect(displaySessionTitle("# AGENTS.md instructions\nprivate")).toBe("Untitled session");
  });

  it("keeps a real title that only mentions the internal prefix", () => {
    expect(displaySessionTitle("Fix # AGENTS.md instructions rendering")).toBe(
      "Fix # AGENTS.md instructions rendering",
    );
  });

  it("extracts explicit requests from known attachment wrappers but never their metadata", () => {
    expect(displaySessionTitle("# Files mentioned by the user:\nprivate.png\n## My request:\nFix layout\n<image name=test>")).toBe("Fix layout");
    expect(displaySessionTitle("# Applications mentioned by the user: app state ## My request: Review sidebar")).toBe("Review sidebar");
    expect(displaySessionTitle("# Files mentioned by the user: ## HANDOFF.md")).toBe("Untitled session");
    expect(displaySessionTitle("# Applications mentioned by the user: browser")).toBe("Untitled session");
    expect(displaySessionTitle("# Files mentioned by the user: ## My request:   ")).toBe("Untitled session");
  });
});
