import { continuationResources, composerAddCopy } from "@agentkib/session-ui";
import { useState } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type SessionResources, type SessionResource } from "@agentkib/web-client";
import { SessionComposerControls } from "@agentkib/session-ui";
import type { useSession } from "@/features/conversation/web-session-context";
let state: ReturnType<typeof useSession>;
const folder: SessionResource = {
  id: "folder-ref",
  kind: "directory",
  name: "src",
  navigationId: "opaque-src",
  available: true,
};
const rootFile: SessionResource = {
  id: "root-file",
  kind: "file",
  name: "README.md",
  available: true,
};
const nestedFile: SessionResource = {
  id: "nested-file",
  kind: "file",
  name: "nested.ts",
  available: true,
};
const root: SessionResources = {
  sessionId: "s",
  revision: 1,
  directoryId: "opaque-root",
  resources: [folder, rootFile],
};
const nested: SessionResources = {
  sessionId: "s",
  revision: 1,
  directoryId: "opaque-src",
  parentId: "opaque-root",
  resources: [nestedFile],
};
function Harness({ initialResources = [] }: { initialResources?: SessionResource[] }) {
  const [resources, setResources] = useState<SessionResource[]>(initialResources);
  return (
    <>
      <SessionComposerControls
        session={state}
        resources={resources}
        setResources={setResources}
        disabled={false}
        openPhoneFiles={vi.fn()}
      />
      <output aria-label="selected ids">{resources.map((item) => item.id).join(",")}</output>
    </>
  );
}
beforeEach(() => {
  state = {
    selected: "s",
    current: { id: "s", agent: "codex" },
    locale: "en-US",
    online: true,
    busy: false,
    access: { status: "approved", device: { accessMode: "full", advancedControl: true } },
    live: { sessionId: "s", status: "idle", revision: 1 },
    capabilities: {
      sessionId: "s",
      features: { resources: { available: true }, context: { available: true } },
    },
    client: {
      sessionSettings: vi.fn().mockRejectedValue(new Error("unsupported")),
      codexGoals: vi.fn().mockRejectedValue(new Error("unsupported")),
      codexContextOptions: vi.fn(async (_session: string, id?: string) =>
        id === "opaque-src" ? nested : root,
      ),
    },
  } as unknown as ReturnType<typeof useSession>;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
async function openBrowser() {
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  fireEvent.click(
    await screen.findByRole("button", { name: composerAddCopy("en-US").filesAndFolders }),
  );
}
async function open() {
  await openBrowser();
  await screen.findByRole("button", { name: "Open folder: src" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Open folder: src" })).toBeEnabled(),
  );
}
it("navigates with opaque cursors and preserves selected resources across directories", async () => {
  render(<Harness />);
  await open();
  fireEvent.click(screen.getByRole("checkbox", { name: /README.md/ }));
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  await screen.findByRole("checkbox", { name: /nested.ts/ });
  expect(state.client.codexContextOptions).toHaveBeenLastCalledWith(
    "s",
    "opaque-src",
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /nested.ts/ }));
  expect(screen.getByLabelText("selected ids")).toHaveTextContent("root-file,nested-file");
  fireEvent.click(screen.getByRole("button", { name: "Parent folder" }));
  await screen.findByRole("checkbox", { name: /README.md/ });
  expect(state.client.codexContextOptions).toHaveBeenLastCalledWith(
    "s",
    "opaque-root",
    expect.any(AbortSignal),
  );
  expect(screen.getByRole("checkbox", { name: /README.md/ })).toBeChecked();
  expect(screen.getByLabelText("selected ids")).toHaveTextContent("root-file,nested-file");
  expect(screen.getByRole("button", { name: "Parent folder" })).toBeDisabled();
});
it("shows navigation loading and errors, then retries the same authorized cursor", async () => {
  render(<Harness />);
  await open();
  let reject!: (error: unknown) => void;
  vi.mocked(state.client.codexContextOptions).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  expect(screen.getByText("Loading resources…")).toBeVisible();
  expect(screen.getByRole("button", { name: "Open folder: src" })).toBeDisabled();
  reject(new Error("temporary"));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByRole("checkbox", { name: /nested.ts/ });
  expect(state.client.codexContextOptions).toHaveBeenLastCalledWith(
    "s",
    "opaque-src",
    expect.any(AbortSignal),
  );
});
it("aborts old directory requests and ignores their response after a session switch", async () => {
  const view = render(<Harness />);
  await open();
  let resolve!: (value: SessionResources) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(state.client.codexContextOptions).mockImplementationOnce(
    (_id, _directory, requestSignal) => {
      signal = requestSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  state = {
    ...state,
    selected: "other",
    current: { ...state.current!, id: "other" },
    live: { ...state.live!, sessionId: "other" },
    capabilities: { ...state.capabilities!, sessionId: "other" },
  };
  view.rerender(<Harness />);
  expect(signal?.aborted).toBe(true);
  resolve(nested);
  await open();
  expect(screen.queryByRole("checkbox", { name: /nested.ts/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Parent folder" })).toBeDisabled();
  expect(screen.getByLabelText("selected ids")).toBeEmptyDOMElement();
});
it("keeps directory browsing available while context references cannot be submitted", async () => {
  state = {
    ...state,
    capabilities: {
      ...state.capabilities!,
      features: { resources: { available: true }, context: { available: false } },
    },
  };
  render(<Harness />);
  await openBrowser();
  const navigation = await screen.findByRole("button", { name: "Open folder: src" });
  expect(navigation).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: /src/ })).toBeDisabled();
  fireEvent.click(navigation);
  expect(await screen.findByRole("checkbox", { name: /nested.ts/ })).toBeDisabled();
  expect(screen.getByLabelText("selected ids")).toBeEmptyDOMElement();
});

it("allows browsing and removing references when the selection reaches the send limit", async () => {
  const initialResources = [
    rootFile,
    ...Array.from({ length: 9 }, (_, i) => ({ ...nestedFile, id: `other-${i}` })),
  ];
  render(<Harness initialResources={initialResources} />);
  await open();
  expect(screen.getByText("Select up to 10 items")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /src/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  expect(await screen.findByRole("checkbox", { name: /nested.ts/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Parent folder" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /README.md/ }));
  expect(screen.getByRole("checkbox", { name: /src/ })).toBeEnabled();
});

it("aborts directory browsing when its grant is revoked and ignores the pending result", async () => {
  const view = render(<Harness />);
  await open();
  let resolve!: (value: SessionResources) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(state.client.codexContextOptions).mockImplementationOnce(
    (_id, _directory, requestSignal) => {
      signal = requestSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  state = {
    ...state,
    capabilities: {
      ...state.capabilities!,
      features: {
        resources: { available: false, reason: "permission_denied" },
        context: { available: false, reason: "permission_denied" },
      },
    },
  };
  view.rerender(<Harness />);
  expect(signal?.aborted).toBe(true);
  const entry = screen.getByRole("button", { name: "Files and folders" });
  expect(entry).toBeDisabled();
  const reads = vi.mocked(state.client.codexContextOptions).mock.calls.length;
  resolve(nested);
  await waitFor(() => expect(screen.queryByRole("checkbox")).not.toBeInTheDocument());
  fireEvent.click(entry);
  expect(state.client.codexContextOptions).toHaveBeenCalledTimes(reads);
  expect(screen.getByLabelText("selected ids")).toBeEmptyDOMElement();
});

it("retains restored resource chips on initial mount without reusing source IDs or directory cursors", async () => {
  const original = { ...rootFile, navigationId: "source-cursor" };
  const draft = continuationResources([original]);
  render(<Harness initialResources={draft} />);
  await waitFor(() => expect(state.client.codexContextOptions).toHaveBeenCalled());
  const chip = screen.getByRole("button", { name: "Remove attachment: README.md" }).parentElement!;
  expect(chip).toHaveAttribute("aria-disabled", "true");
  expect(chip).toHaveAttribute("title", "This resource is no longer valid. Select it again.");
  expect(screen.getByLabelText("selected ids")).toHaveTextContent(draft[0]!.id);
  expect(draft[0]!.id).not.toBe(original.id);
  expect(draft[0]!.navigationId).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Remove attachment: README.md" }));
  expect(screen.getByLabelText("selected ids")).toBeEmptyDOMElement();
});
