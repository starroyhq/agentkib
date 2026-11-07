// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planSlashOption, useSlashCommandMenu } from "@agentkib/session-ui";

function Composer({ enter }: { enter?: () => boolean }) {
  const [value, setValue] = useState("");
  const slash = useSlashCommandMenu({
    value,
    options: [{ name: "compact", description: "Compact the context", aliases: [] }],
    enabled: true,
    catalogKnown: true,
    locale: "en-US",
    plan: enter ? { option: planSlashOption("en-US"), enter } : undefined,
    onChoose: setValue,
  });
  return (
    <div>
      {slash.menu}
      <textarea
        aria-label="Message"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => slash.onKeyDown(event, false)}
        {...slash.inputProps}
      />
    </div>
  );
}

function type(text: string) {
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: text } });
  return input;
}

afterEach(cleanup);

describe("`/plan` in the composer, as Codex's takes it", () => {
  it("turns plan mode on for /plan at the start and leaves it out of the draft", () => {
    const enter = vi.fn(() => true);
    render(<Composer enter={enter} />);
    const input = type("/plan");
    expect(within(screen.getByRole("listbox")).getAllByRole("option")[0]).toHaveTextContent(
      "/planTurn on Plan mode",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(enter).toHaveBeenCalledOnce();
    expect(input).toHaveValue("");
  });

  it("takes /plan typed after a space, and only that", () => {
    const enter = vi.fn(() => true);
    render(<Composer enter={enter} />);
    const input = type("Fix the flaky test /pl");
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["/planTurn on Plan mode"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(enter).toHaveBeenCalledOnce();
    expect(input).toHaveValue("Fix the flaky test");
    // Other commands are names at the start only.
    type("Fix the flaky test /co");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("completes /plan as text where plan mode cannot turn on", () => {
    const enter = vi.fn(() => false);
    render(<Composer enter={enter} />);
    const input = type("/pl");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/plan ");
  });

  it("offers nothing after a space where the session has no plan mode", () => {
    render(<Composer />);
    type("Fix the flaky test /pl");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
