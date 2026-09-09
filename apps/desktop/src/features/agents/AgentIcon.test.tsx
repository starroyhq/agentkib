// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIcon";

afterEach(cleanup);

describe("AgentIcon", () => {
  it("keeps the Hermes icon dark in light mode and inverts it in dark mode", () => {
    const { container } = render(<AgentIcon agent="hermes" />);
    const icon = container.querySelector("img");

    expect(icon?.classList.contains("invert")).toBe(false);
    expect(icon?.classList.contains("ak-agent-invert")).toBe(true);
  });

  it("renders the OpenCode asset", () => {
    const { container } = render(<AgentIcon agent="opencode" />);

    expect(container.querySelector("img")?.getAttribute("src")).toContain("OpenCode");
  });

  it("renders the Grok Build icon with dark-mode contrast", () => {
    const { container } = render(<AgentIcon agent="grok-build" />);
    const image = container.querySelector("img");

    expect(image?.getAttribute("src")).toContain("Grok");
    expect(image?.classList.contains("ak-agent-invert")).toBe(true);
  });
});
