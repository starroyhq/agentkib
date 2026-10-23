// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import {
  SkillFileBrowser,
  SkillSafeMarkdown,
  boundedSkillDiff,
  type SkillReadableContent,
} from "./SkillFileBrowser";

const openExternal = vi.fn();
vi.mock("@/core/api", () => ({
  api: { openExternal: (...args: unknown[]) => openExternal(...args) },
}));
beforeAll(() => initializeI18n("en-US"));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Skill content preview", () => {
  it("renders instructions without executing HTML or loading remote images and blocks unsafe links", async () => {
    const { container } = render(
      <SkillSafeMarkdown
        content={
          '# Instructions\n\n<script>alert(1)</script>\n\n<img src="https://tracking.invalid/pixel" onerror="alert(2)">\n\n![tracking](https://tracking.invalid/pixel)\n\n[unsafe](javascript:alert(3))\n\n[docs](https://example.com/docs)'
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "Instructions" })).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("link", { name: "docs" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });
  it("bounds diff work before the LCS allocation", () => {
    expect(boundedSkillDiff("old\nline", "new\nline")?.map((line) => line.type)).toContain("added");
    expect(boundedSkillDiff("x\n".repeat(1000), "y\n".repeat(1000))).toBeUndefined();
    expect(boundedSkillDiff("a".repeat(128 * 1024), "b")).toBeUndefined();
  });
  it.each([
    ["file to directory", ["resources/", "resources/guide.md", "resources"]],
    ["directory to file", ["resources", "resources/", "resources/guide.md"]],
  ])("keeps both file versions selectable for a %s change", async (_change, paths) => {
    const readFile = vi.fn(async (path: string) => ({ path, after: `Contents of ${path}` }));
    render(
      <SkillFileBrowser
        files={["SKILL.md", ...paths].map((path) => ({ path, size: 10, executable: false }))}
        readFile={readFile}
      />,
    );
    await screen.findByText("Contents of SKILL.md");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "guide.md" }));
    expect(await screen.findByText("Contents of resources/guide.md")).toBeTruthy();
    expect(readFile).toHaveBeenLastCalledWith("resources/guide.md");
    await user.click(screen.getByTitle("resources"));
    expect(await screen.findByText("Contents of resources")).toBeTruthy();
    expect(readFile).toHaveBeenLastCalledWith("resources");
    expect(readFile.mock.calls.every(([path]) => !path.endsWith("/"))).toBe(true);
  });
  it.each([
    ["resources/", "resources"],
    ["resources", "resources/"],
  ])("preserves an empty directory beside a file version (%s first)", async (...paths) => {
    const readFile = vi.fn(async (path: string) => ({ path, after: "Historical file content" }));
    render(
      <SkillFileBrowser
        files={paths.map((path) => ({ path, size: 0, executable: false }))}
        readFile={readFile}
      />,
    );
    expect(await screen.findByText("Historical file content")).toBeTruthy();
    expect(screen.getByTitle("resources/").textContent).toContain("Directory");
    expect(screen.getByRole("button", { name: "resources" })).toBeTruthy();
    expect(readFile.mock.calls).toEqual([["resources"]]);
  });
  it("shows nested empty directories without reading them as files", async () => {
    const readFile = vi.fn();
    render(
      <SkillFileBrowser
        files={["output/", "output/nested/", "empty/"].map((path) => ({
          path,
          size: 0,
          executable: false,
        }))}
        readFile={readFile}
      />,
    );
    expect(screen.getByText(/Only directories are listed here/)).toBeTruthy();
    expect(screen.getByTitle("output/nested/")).toBeTruthy();
    expect(screen.getByTitle("empty/")).toBeTruthy();
    await userEvent.setup().click(screen.getByTitle("output/"));
    expect(readFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Source" })).toBeNull();
  });
  it.each(["before", "after"] as const)(
    "keeps the readable %s version beside a binary version in every viewing mode",
    async (textSide) => {
      render(
        <SkillFileBrowser
          files={[{ path: "guide.md", size: 128, executable: false }]}
          readFile={vi.fn().mockResolvedValue({
            path: "guide.md",
            [textSide]: "# Readable instructions",
            binary: true,
            before_size: 128,
            after_size: 128,
            before_sha256: "previous-hash",
            after_sha256: "next-hash",
          })}
        />,
      );
      expect(await screen.findByRole("heading", { name: "Readable instructions" })).toBeTruthy();
      const readable = screen.getByRole("region", {
        name: textSide === "before" ? "Previous" : "Next",
      });
      const binary = screen.getByRole("region", {
        name: textSide === "before" ? "Next" : "Previous",
      });
      expect(within(binary).getByText("Binary version")).toBeTruthy();
      expect(within(binary).queryByText(/Readable instructions/)).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Source" }));
      expect(within(readable).getByText("# Readable instructions").tagName).toBe("PRE");
      await user.click(screen.getByRole("tab", { name: "Changes" }));
      expect(within(readable).getByText("# Readable instructions").tagName).toBe("PRE");
      expect(screen.queryByText(/^[+−] # Readable/)).toBeNull();
    },
  );
  it("preserves empty text as a readable side of a binary conversion", async () => {
    render(
      <SkillFileBrowser
        files={[{ path: "empty.txt", size: 0, executable: false }]}
        readFile={vi.fn().mockResolvedValue({
          path: "empty.txt",
          before: "",
          binary: true,
          before_size: 0,
          after_size: 10,
        })}
      />,
    );
    const readable = await screen.findByRole("region", { name: "Previous" });
    expect(readable.querySelector("pre")?.textContent).toBe("");
    expect(within(readable).queryByText("Binary version")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Next" })).getByText("Binary version"),
    ).toBeTruthy();
  });
  it("shows binary hashes, size and executable changes without trying to render bytes", async () => {
    render(
      <SkillFileBrowser
        files={[{ path: "assets/tool.bin", size: 256, executable: true }]}
        readFile={vi.fn().mockResolvedValue({
          path: "assets/tool.bin",
          binary: true,
          before_size: 128,
          after_size: 256,
          before_sha256: "previous-sha256",
          after_sha256: "next-sha256",
          before_executable: false,
          after_executable: true,
        })}
      />,
    );
    expect(await screen.findByText(/Binary content cannot be previewed/)).toBeTruthy();
    expect(screen.getByText("SHA-256: previous-sha256")).toBeTruthy();
    expect(screen.getByText("SHA-256: next-sha256")).toBeTruthy();
    expect(screen.getByText("128 B · Not executable")).toBeTruthy();
    expect(screen.getByText("256 B · Executable")).toBeTruthy();
  });
  it("ignores stale file reads and resets the selection when the file list changes", async () => {
    let resolveOld!: (value: SkillReadableContent) => void;
    const readFile = vi.fn().mockImplementation((path: string) =>
      path === "SKILL.md"
        ? new Promise<SkillReadableContent>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ path, after: "Newest content" }),
    );
    const { rerender } = render(
      <SkillFileBrowser
        files={[{ path: "SKILL.md", size: 10, executable: false }]}
        readFile={readFile}
      />,
    );
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("SKILL.md"));
    rerender(
      <SkillFileBrowser
        files={[{ path: "guide.md", size: 10, executable: false }]}
        readFile={readFile}
      />,
    );
    expect(await screen.findByText("Newest content")).toBeTruthy();
    await act(async () => resolveOld({ path: "SKILL.md", after: "Stale content" }));
    expect(screen.queryByText("Stale content")).toBeNull();
    expect(screen.getByRole("button", { name: "guide.md" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
  it("shows explicit truncation and a bounded fallback for large changes", async () => {
    render(
      <SkillFileBrowser
        files={[{ path: "large.txt", size: 5000, executable: false }]}
        readFile={vi.fn().mockResolvedValue({
          path: "large.txt",
          before: "old\n".repeat(600),
          after: "next\n".repeat(600),
          truncated: true,
        })}
      />,
    );
    expect(await screen.findByText(/This preview is truncated/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Changes" }));
    expect(screen.getByText(/too large for an inline diff/)).toBeTruthy();
  });
});

describe("Skill file read states", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "does not announce an error while loading or after a successful read in %s",
    async (locale) => {
      await initializeI18n(locale);
      let resolveRead!: (value: SkillReadableContent) => void;
      const readFile = vi.fn(
        () =>
          new Promise<SkillReadableContent>((resolve) => {
            resolveRead = resolve;
          }),
      );
      render(
        <SkillFileBrowser
          files={[{ path: "SKILL.md", size: 20, executable: false }]}
          readFile={readFile}
        />,
      );

      expect(screen.getByText(tr("skills.manager.readOnlyNotice"))).toBeTruthy();
      expect(within(screen.getByRole("status")).getByText(tr("common.loading"))).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();

      await act(async () => resolveRead({ path: "SKILL.md", content: "# Reviewed instructions" }));

      expect(await screen.findByRole("heading", { name: "Reviewed instructions" })).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("null")).toBeNull();
    },
  );

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "does not announce an error while loading or after an empty text read in %s",
    async (locale) => {
      await initializeI18n(locale);
      let resolveRead!: (value: SkillReadableContent) => void;
      const readFile = vi.fn(
        () =>
          new Promise<SkillReadableContent>((resolve) => {
            resolveRead = resolve;
          }),
      );
      const { container } = render(
        <SkillFileBrowser
          files={[{ path: "empty.txt", size: 0, executable: false }]}
          readFile={readFile}
        />,
      );

      expect(screen.getByText(tr("skills.manager.readOnlyNotice"))).toBeTruthy();
      expect(within(screen.getByRole("status")).getByText(tr("common.loading"))).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();

      await act(async () => resolveRead({ path: "empty.txt", content: "" }));

      await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
      expect(container.querySelector("pre")?.textContent).toBe("");
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("null")).toBeNull();
    },
  );

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "does not announce an error when only directories or no files are available in %s",
    async (locale) => {
      await initializeI18n(locale);
      const readFile = vi.fn();
      const { rerender } = render(
        <SkillFileBrowser
          files={[{ path: "resources/", size: 0, executable: false }]}
          readFile={readFile}
        />,
      );

      expect(screen.getByText(tr("skills.manager.readOnlyNotice"))).toBeTruthy();
      expect(screen.getByText(tr("skills.manager.directoriesOnly"))).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();

      rerender(<SkillFileBrowser files={[]} readFile={readFile} />);

      expect(screen.getByText(tr("skills.manager.readOnlyNotice"))).toBeTruthy();
      expect(screen.queryByText(tr("skills.manager.directoriesOnly"))).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("null")).toBeNull();
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps an actual file read error readable in %s",
    async (locale) => {
      await initializeI18n(locale);
      render(
        <SkillFileBrowser
          files={[{ path: "SKILL.md", size: 20, executable: false }]}
          readFile={vi.fn().mockRejectedValue(new Error("Skill preview could not be read"))}
        />,
      );

      expect(screen.getByText(tr("skills.manager.readOnlyNotice"))).toBeTruthy();
      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toBe("Error: Skill preview could not be read"));
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText("null")).toBeNull();
    },
  );
});
