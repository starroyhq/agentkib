import { createContext, useContext, useState } from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalogCopy } from "@agentkib/session-ui";
import { dictionaries } from "@/features/conversation/i18n";
import { render } from "@/features/conversation/web-reader-test-utils";
import { SessionDialogs } from "@/features/conversation/web-session-dialogs";

const MetadataContext = createContext<Record<string, unknown> | null>(null);
vi.mock("@/features/conversation/web-session-context", () => ({
  useSession: () => useContext(MetadataContext),
}));

afterEach(cleanup);

it("keeps the Web metadata layout and restores focus after closing", async () => {
  const labels = dictionaries["en-US"];
  const copy = catalogCopy["en-US"];
  function Harness() {
    const [modal, setModal] = useState<"metadata">();
    const fixture = {
      modal,
      setModal,
      t: labels,
      c: copy,
      formatCatalogTime: () => copy.unknown,
      online: false,
    };
    return (
      <MetadataContext value={fixture}>
        <button type="button" onClick={() => setModal("metadata")}>
          Open metadata
        </button>
        <SessionDialogs />
      </MetadataContext>
    );
  }
  render(<Harness />);
  const launch = screen.getByRole("button", { name: "Open metadata" });
  launch.focus();
  fireEvent.click(launch);

  const dialog = await screen.findByRole("dialog", { name: labels.metadata });
  expect(dialog).toHaveClass("sm:max-w-xl");
  expect(dialog.querySelector(".dialog-body")).not.toHaveClass("overflow-y-auto");
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  fireEvent.click(within(dialog).getByRole("button", { name: labels.close }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(launch).toHaveFocus());
});
