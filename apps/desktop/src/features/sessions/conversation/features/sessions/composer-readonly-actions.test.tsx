// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  composerAddCopy,
  composerGoalCopy,
  planModeCopy,
  SessionComposerAddMenu,
} from "@agentkib/session-ui";
import { sessionReason } from "../../session-copy";

afterEach(cleanup);

it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
  "disables unavailable actions without adding menu feedback in %s",
  async (locale) => {
    const onPick = vi.fn();
    const onGoal = vi.fn();
    const onPlan = vi.fn();
    render(
      <SessionComposerAddMenu
        locale={locale}
        label="Add"
        attachment={{
          disabled: true,
          onPick,
        }}
        goal={{ disabled: true, onOpen: onGoal }}
        plan={{ disabled: true, active: false, onToggle: onPlan }}
        resources={{
          path: [],
          selected: [],
          selectable: true,
          page: { resources: [] },
          load: vi.fn(),
          onSelect: vi.fn(),
        }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add" }));
    const menu = await screen.findByRole("dialog", { name: "Add" });
    for (const name of [
      composerAddCopy(locale).attachment,
      composerGoalCopy(locale).title,
      planModeCopy(locale).title,
    ]) {
      const action = within(menu).getByRole("button", { name });
      expect(action).toBeDisabled();
      fireEvent.click(action);
      action.focus();
      expect(action).not.toHaveFocus();
    }
    expect(within(menu).queryByRole("status")).not.toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
    expect(onGoal).not.toHaveBeenCalled();
    expect(onPlan).not.toHaveBeenCalled();
    expect(menu).toBeVisible();
  },
);

it("keeps revoked grants natively disabled without presenting them as an executor limitation", () => {
  const onPick = vi.fn();
  render(
    <SessionComposerAddMenu
      locale="en-US"
      label="Add"
      attachment={{
        disabled: true,
        onPick,
      }}
    />,
  );
  const add = screen.getByRole("button", { name: "Add" });
  expect(add).toBeDisabled();
  fireEvent.click(add);
  expect(screen.queryByRole("dialog", { name: "Add" })).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(onPick).not.toHaveBeenCalled();
});

it("keeps the reference limitation on unavailable controls and preserves navigation", () => {
  const load = vi.fn();
  const onSelect = vi.fn();
  const code = "follower-resource-input-unsupported";
  const reason = sessionReason("en-US", code).text;
  render(
    <SessionComposerAddMenu
      locale="en-US"
      label="Add"
      resources={{
        path: [],
        selected: [],
        selectable: false,
        reasonText: (value) => sessionReason("en-US", value).text,
        page: {
          resources: [
            { id: "src", kind: "directory", name: "src", available: true, navigationId: "src" },
            { id: "file", kind: "file", name: "README.md", available: false, reason: code },
          ],
        },
        load,
        onSelect,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const entry = screen.getByRole("button", { name: "Files and folders" });
  expect(entry).not.toHaveAttribute("title");
  fireEvent.click(entry);
  expect(screen.queryByText(reason)).not.toBeInTheDocument();
  for (const input of screen.getAllByRole("checkbox")) {
    expect(input).toBeDisabled();
    expect(input).not.toHaveAttribute("title");
  }
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  expect(load).toHaveBeenCalledExactlyOnceWith("src", ["src"]);
  expect(onSelect).not.toHaveBeenCalled();
});
