// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { AppDialogProvider, useAppDialogs } from "./AppDialogProvider";
import { SidebarSearchButton } from "./SidebarSearchButton";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./ui/dialog";
import { SettingsSkeleton } from "@/features/settings/SettingsSkeleton";

function DialogTrigger() {
  const dialogs = useAppDialogs();
  return (
    <button onClick={() => void dialogs.confirm("Pending confirmation")}>Open confirmation</button>
  );
}

function ConflictTrigger({ result }: { result: (loadDisk: boolean) => void }) {
  const dialogs = useAppDialogs();
  return (
    <button
      onClick={() =>
        void dialogs
          .confirm({
            title: tr("workspace.refreshConflictTitle"),
            description: tr("workspace.refreshConflict"),
            confirmLabel: tr("workspace.refreshLoadDisk"),
            cancelLabel: tr("workspace.refreshKeepDraft"),
          })
          .then(result)
      }
    >
      Open conflict
    </button>
  );
}

describe("shared component locale subscriptions", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "names the destructive disk choice in %s",
    async (locale) => {
      await act(() => changeLocale(locale));
      const result = vi.fn();
      render(
        <AppDialogProvider>
          <ConflictTrigger result={result} />
        </AppDialogProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open conflict" }));
      await screen.findByRole("alertdialog");
      expect(
        screen.getByRole("heading", { name: tr("workspace.refreshConflictTitle") }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: tr("common.confirm") })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: tr("workspace.refreshKeepDraft") }));
      await act(async () => undefined);
      expect(result).toHaveBeenCalledWith(false);
      fireEvent.click(screen.getByRole("button", { name: "Open conflict" }));
      await screen.findByRole("alertdialog");
      fireEvent.click(screen.getByRole("button", { name: tr("workspace.refreshLoadDisk") }));
      await act(async () => undefined);
      expect(result).toHaveBeenLastCalledWith(true);
      await act(() => changeLocale("en-US"));
    },
  );

  it("updates the loading announcement without replacing the loading state", async () => {
    render(<SettingsSkeleton />);
    const status = screen.getByRole("status", { name: "Loading settings" });
    try {
      for (const locale of ["zh-CN", "zh-TW", "ja-JP"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("status", { name: tr("loading.settings") })).toBe(status);
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it("translates both shared dialog close controls while the dialog stays open", async () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Details</DialogTitle>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    );
    expect(await screen.findAllByRole("button", { name: "Close" })).toHaveLength(2);
    try {
      await act(() => changeLocale("zh-CN"));
      expect(screen.getAllByRole("button", { name: tr("common.close") })).toHaveLength(2);
      expect(screen.getByRole("dialog")).toBeTruthy();
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it("refreshes an open dialog and search control without remounting", async () => {
    render(
      <AppDialogProvider>
        <DialogTrigger />
        <SidebarSearchButton onOpenSearch={() => undefined} />
      </AppDialogProvider>,
    );
    const searchButton = screen.getByRole("button", { name: tr("search.open") });
    fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
    const dialog = await screen.findByRole("alertdialog");

    try {
      await act(() => changeLocale("zh-CN"));
      expect(screen.getByRole("alertdialog")).toBe(dialog);
      expect(screen.getByRole("button", { name: tr("common.confirm") })).toBeTruthy();
      expect(screen.getByRole("button", { name: tr("common.cancel") })).toBeTruthy();
      expect(screen.getByText(tr("dialog.confirmTitle"))).toBeTruthy();
      expect(searchButton.getAttribute("aria-label")).toBe(tr("search.open"));
      expect(searchButton.getAttribute("title")).toContain(tr("search.open"));
      expect(screen.getByText("Pending confirmation")).toBeTruthy();
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
});
