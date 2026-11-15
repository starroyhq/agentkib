// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { SkillOperationPreview, SkillSource, SkillVersionList } from "@/core/types";
import { SkillVersionDialog } from "./SkillVersionDialog";

const mocks = vi.hoisted(() => ({
  listSkillVersions: vi.fn(),
  prepareSkillVersionChange: vi.fn(),
  prepareSkillInstall: vi.fn(),
  discardSkillPreview: vi.fn(),
}));
vi.mock("@/core/api", () => ({ api: mocks }));
const source: SkillSource = {
  kind: "github",
  repository: "owner/repo",
  path: "skills/reviewer",
  ref: "main",
  resolved_commit: "a".repeat(40),
  tree_sha: "tree",
};
const preview: SkillOperationPreview = {
  token: "version-token",
  operation: "update",
  skill: { name: "reviewer", description: "Review", source },
  files: [],
  added: [],
  removed: [],
  modified: [],
  total_size: 0,
  local_modified: false,
  expires_at: "2030-01-01T00:00:00Z",
};
const list = (type: "tag" | "branch", page = 1, hasMore = false): SkillVersionList => ({
  type,
  page,
  has_more: hasMore,
  entries: [{ name: type === "tag" ? `v${page}.0` : "main", commit: "b".repeat(40) }],
});

describe("SkillVersionDialog", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listSkillVersions.mockResolvedValue(list("tag"));
    mocks.prepareSkillVersionChange.mockResolvedValue(preview);
    mocks.prepareSkillInstall.mockResolvedValue(preview);
    mocks.discardSkillPreview.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    cleanup();
    await changeLocale("en-US");
  });

  it("lists versions of an existing library package and prepares the selected tag", async () => {
    const onPrepared = vi.fn();
    render(
      <SkillVersionDialog
        name="reviewer"
        source={source}
        libraryId="library-reviewer"
        onClose={vi.fn()}
        onPrepared={onPrepared}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /v1.0/ }));
    await user.click(screen.getByRole("button", { name: "Review version" }));
    expect(mocks.listSkillVersions).toHaveBeenCalledWith({
      library_id: "library-reviewer",
      type: "tag",
      page: 1,
    });
    expect(mocks.prepareSkillVersionChange).toHaveBeenCalledWith("library-reviewer", {
      type: "tag",
      value: "v1.0",
    });
    expect(mocks.prepareSkillInstall).not.toHaveBeenCalled();
    expect(onPrepared).toHaveBeenCalledWith(preview);
    expect(screen.getByText(/does not update deployed copies/)).toBeTruthy();
  });

  it("clears the selected reference when paging and prepares initial installation at a commit", async () => {
    mocks.listSkillVersions.mockImplementation(({ type, page }) =>
      Promise.resolve(list(type, page, page === 1)),
    );
    render(
      <SkillVersionDialog name="reviewer" source={source} onClose={vi.fn()} onPrepared={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /v1.0/ }));
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("button", { name: /v2.0/ })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Review version" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("tab", { name: "Commit" }));
    const input = screen.getByRole("textbox", { name: "Commit SHA" });
    await user.clear(input);
    await user.type(input, "not-a-sha");
    expect(
      (screen.getByRole("button", { name: "Review version" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.clear(input);
    await user.type(input, "abcdef0");
    await user.click(screen.getByRole("button", { name: "Review version" }));
    expect(mocks.prepareSkillInstall).toHaveBeenCalledWith({
      ...source,
      ref: "abcdef0",
      ref_type: "commit",
    });
  });

  it("ignores a tag response after switching to branches and supports retry after a list error", async () => {
    let completeTags: (value: SkillVersionList) => void = () => undefined;
    mocks.listSkillVersions
      .mockImplementationOnce(
        () =>
          new Promise<SkillVersionList>((resolve) => {
            completeTags = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("Version list unavailable"))
      .mockResolvedValueOnce(list("branch"));
    render(
      <SkillVersionDialog name="reviewer" source={source} onClose={vi.fn()} onPrepared={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Branch" }));
    expect(await screen.findByText(/Version list unavailable/)).toBeTruthy();
    await act(async () => completeTags(list("tag")));
    expect(screen.queryByRole("button", { name: /v1.0/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /main/ })).toBeTruthy();
  });

  it("discards a prepared snapshot when the dialog unmounts while preparation is pending", async () => {
    let complete: (value: SkillOperationPreview) => void = () => undefined;
    mocks.prepareSkillVersionChange.mockImplementation(
      () =>
        new Promise<SkillOperationPreview>((resolve) => {
          complete = resolve;
        }),
    );
    const onPrepared = vi.fn();
    const view = render(
      <SkillVersionDialog
        name="reviewer"
        source={source}
        libraryId="library"
        onClose={vi.fn()}
        onPrepared={onPrepared}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /v1.0/ }));
    await user.click(screen.getByRole("button", { name: "Review version" }));
    view.unmount();
    await act(async () => complete(preview));
    await waitFor(() => expect(mocks.discardSkillPreview).toHaveBeenCalledWith("version-token"));
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it("localizes version controls in all four interface languages", async () => {
    render(
      <SkillVersionDialog
        name="reviewer"
        source={{ ...source, ref_type: "commit" }}
        onClose={vi.fn()}
        onPrepared={vi.fn()}
      />,
    );
    for (const locale of ["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const) {
      await act(() => changeLocale(locale));
      expect(screen.getByRole("textbox", { name: tr("skills.versions.commitInput") })).toBeTruthy();
      expect(screen.getByRole("button", { name: tr("skills.versions.review") })).toBeTruthy();
      expect(tr("skills.versions.review")).not.toBe("skills.versions.review");
    }
  });
});
