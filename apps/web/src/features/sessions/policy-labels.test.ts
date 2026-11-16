import { describe, expect, it } from "vitest";
import { codexPolicyLabel, dshPolicyLabel } from "@agentkib/session-ui";

describe("policy labels", () => {
  it("names Codex policies in each locale and leaves unknown ids to the host", () => {
    expect(codexPolicyLabel("workspace-write-on-request", "zh-CN")?.name).toBe("请求批准");
    expect(codexPolicyLabel("workspace-write-on-request", "zh-Hant")?.name).toBe("要求核准");
    expect(codexPolicyLabel("full-access-on-request", "ja-JP")?.name).toBe("フルアクセス");
    expect(codexPolicyLabel("workspace-write-auto-review", "en-US")?.name).toBe("Approve for me");
    expect(codexPolicyLabel("custom", "zh-CN")).toBeUndefined();
  });

  it("names DeepSeek Harness presets in each locale", () => {
    expect(dshPolicyLabel("read-only", "zh-CN")?.name).toBe("仅可查看");
    expect(dshPolicyLabel("danger-full-access", "ja-JP")?.name).toBe("フルアクセス");
    expect(dshPolicyLabel("auto", "zh-Hant")?.name).toBe("自動審查");
    expect(dshPolicyLabel("other", "en-US")).toBeUndefined();
  });
});
