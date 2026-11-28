// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("Dialog and AlertDialog grid containment", () => {
  it("constrains DialogContent to a single minmax(0, 1fr) column and wraps unbreakable headers", () => {
    const longPath =
      "/Users/developer/workspaces/extremely-long-unbreakable-repository-directory-name-2026/packages/session-ui/src/conversation/sessions/dialog.tsx";
    render(
      <Dialog open>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{longPath}</DialogTitle>
            <DialogDescription>{longPath}</DialogDescription>
          </DialogHeader>
          <div className="min-w-0">
            <span className="block truncate">{longPath}</span>
          </div>
          <DialogFooter>
            <button type="button">Cancel</button>
          </DialogFooter>
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
    expect(dialog.querySelector('[data-slot="dialog-description"]')).toHaveClass(
      "min-w-0",
      "wrap-anywhere",
    );
  });

  it("constrains AlertDialogContent and header tracks so long paths wrap inside the card", () => {
    const longUrl =
      "https://example.invalid/organizations/platform-engineering/repositories/extremely-long-unbreakable-session-title-and-path";
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{longUrl}</AlertDialogTitle>
            <AlertDialogDescription>{longUrl}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <button type="button">Confirm</button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveClass("grid", "grid-cols-1");
    expect(dialog.querySelector('[data-slot="alert-dialog-header"]')).toHaveClass(
      "min-w-0",
      "grid-cols-1",
    );
    expect(dialog.querySelector('[data-slot="alert-dialog-title"]')).toHaveClass(
      "min-w-0",
      "wrap-anywhere",
    );
    expect(dialog.querySelector('[data-slot="alert-dialog-description"]')).toHaveClass(
      "min-w-0",
      "wrap-anywhere",
    );
  });
});
