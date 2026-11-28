// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog as ConversationDialog } from "./dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@agentkib/ui/dialog";

afterEach(cleanup);

describe("Web Dialog grid containment", () => {
  it("constrains DialogContent to a single minmax(0, 1fr) column and wraps long titles", () => {
    const longPath =
      "/Users/developer/workspaces/extremely-long-unbreakable-repository-directory-name-2026/packages/session-ui/index.tsx";
    render(
      <Dialog open>
        <DialogContent closeLabel="Close">
          <DialogHeader>
            <DialogTitle>{longPath}</DialogTitle>
          </DialogHeader>
          <div className="min-w-0">
            <span className="block truncate">{longPath}</span>
          </div>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("grid", "grid-cols-1");
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass("min-w-0");
    expect(dialog.querySelector('[data-slot="dialog-title"]')).toHaveClass(
      "min-w-0",
      "wrap-anywhere",
    );
  });

  it("wraps long titles and descriptions inside ConversationDialog", () => {
    const longUrl =
      "https://example.invalid/workspaces/extremely-long-unbreakable-path-segment-for-dialog-test";
    render(
      <ConversationDialog
        title={longUrl}
        description={longUrl}
        closeLabel="Close"
        onClose={() => {}}
      >
        <p className="truncate">{longUrl}</p>
      </ConversationDialog>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("grid", "grid-cols-1");
    expect(dialog.querySelector('[data-slot="dialog-title"]')).toHaveClass(
      "min-w-0",
      "flex-1",
      "wrap-anywhere",
    );
  });
});
