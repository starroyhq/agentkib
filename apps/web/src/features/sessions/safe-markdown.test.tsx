import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SafeMarkdown } from "@agentkib/session-ui";

// Replies CLI 2.1.311 wrote for bare commands, run offline against a local API stub. /context is
// shortened to two table rows.
const outputs = {
  model:
    "Current model: `Haiku 5.5`\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.",
  rename: "Could not generate a name: no conversation context yet. Usage: /rename <name>",
  mcp: "No MCP servers are configured. Add one with `claude mcp add`.\nUsage: /mcp [reconnect|enable|disable [<server>|all]]. With no server name, applies to all.",
  usage:
    "Total cost:            $0.0000\nTotal duration (API):  0s\nTotal duration (wall): 0s\nTotal code changes:    0 lines added, 0 lines removed\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write",
  context:
    "## Context Usage\n\n**Model:** claude-haiku-5-5  \n**Tokens:** 3.5k / 1m (0%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 1.3k | 0.1% |\n| Free space | 963.5k | 96.4% |",
};
const rendered = (text: string, literal: boolean) =>
  render(<SafeMarkdown text={text} literal={literal} />).container;

afterEach(cleanup);

describe("Markdown for text Claude Code wrote itself", () => {
  it("keeps the placeholders of a usage line", () => {
    expect(rendered(outputs.rename, true).textContent).toBe(outputs.rename);
    const mcp = rendered(outputs.mcp, true);
    expect(mcp.querySelector("code")?.textContent).toBe("claude mcp add");
    expect(mcp.textContent).toBe(outputs.mcp.replaceAll("`", ""));
    // As a model's reply the sanitizer drops `<name>`, which is why the output is marked.
    const reply = rendered(outputs.rename, false).textContent;
    expect(reply).toContain("Usage: /rename");
    expect(reply).not.toContain("<name>");
  });

  it("keeps each line on its own line", () => {
    const output = rendered(outputs.usage, true);
    expect(output.querySelectorAll("p")).toHaveLength(1);
    expect(output.querySelectorAll("br")).toHaveLength(4);
    expect(output.textContent).toBe(outputs.usage);
    expect(rendered(outputs.usage, false).querySelectorAll("br")).toHaveLength(0);
  });

  it("still renders code, headings and tables, with one break per line", () => {
    const model = rendered(outputs.model, true);
    expect(model.querySelector("code")?.textContent).toBe("Haiku 5.5");
    expect(model.querySelectorAll("br")).toHaveLength(1);
    expect(model.textContent).toContain("Usage: /model <name>. Available: sonnet,");
    const context = rendered(outputs.context, true);
    expect(context.querySelector("h2")?.textContent).toBe("Context Usage");
    expect(context.querySelector("h3")?.textContent).toBe("Estimated usage by category");
    expect(context.querySelectorAll("tbody tr")).toHaveLength(2);
    // The Markdown hard break after the model stays one break.
    const summary = context.querySelector("p")!;
    expect([...summary.querySelectorAll("strong")].map((item) => item.textContent)).toEqual([
      "Model:",
      "Tokens:",
    ]);
    expect(summary.querySelectorAll("br")).toHaveLength(1);
  });

  it("shows HTML as text and never renders it", () => {
    const text = [
      '<img src="https://example.test/pixel" onerror="alert(1)">',
      "<script>window.evil = true</script>",
      "Usage: /goal <condition>",
    ].join("\n");
    const output = rendered(text, true);
    expect(output.querySelector("img, script")).toBeNull();
    expect(output.textContent).toBe(text);
    // The lines form an HTML block, which reads as one paragraph.
    expect(output.querySelectorAll("p")).toHaveLength(1);
    expect(output.querySelectorAll("p > br")).toHaveLength(2);
    // Inside a list or quote too.
    const nested = rendered("> <name>\n\n- <first>\n- second <arg>", true);
    expect(nested.querySelector("blockquote")?.textContent?.trim()).toBe("<name>");
    expect([...nested.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "<first>",
      "second <arg>",
    ]);
  });
});
