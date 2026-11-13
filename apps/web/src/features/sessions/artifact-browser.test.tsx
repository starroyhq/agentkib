import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ArtifactEntry, ArtifactTicket } from "@agentkib/web-client";
import { ArtifactBrowser } from "@/features/conversation/features/sessions/artifact-browser";
import { artifactCopy } from "@/features/conversation/features/sessions/artifact-copy";
import {
  ArtifactPanel,
  ArtifactWorkspace,
} from "@/features/conversation/features/sessions/artifact-panel";

let session: {
  client: { request: ReturnType<typeof vi.fn> };
  access: { device: { files: boolean } };
  current: { workspace_id: string };
  selected: string;
  locale: string;
  embedded?: boolean;
};
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));
const file = (id: string, previewKind: ArtifactEntry["previewKind"], name = id): ArtifactEntry => ({
  id,
  name,
  kind: "file",
  mime: "application/octet-stream",
  size: 10,
  modifiedAt: "2026-01-01T00:00:00Z",
  revision: `revision-${id}`,
  previewKind,
});
const report = file("report", "text", "report.txt");
const html = file("page", "html", "index.html");
const movie = file("movie", "video", "movie.mp4");
const photo = file("photo", "image", "photo.png");
const ticket = (entry: ArtifactEntry, suffix = "first"): ArtifactTicket => ({
  url: `https://preview.example/p/${suffix}/${entry.name}`,
  expiresAt: Date.now() + 60_000,
  revision: entry.revision,
  kind: entry.previewKind,
});

describe("ArtifactBrowser", () => {
  let entries: ArtifactEntry[];
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    entries = [report, html, movie, photo];
    session = {
      client: {
        request: vi.fn(async (path: string, body?: { artifactId?: string }) => {
          if (path === "files/workspaces")
            return {
              workspaces: [
                { id: "workspace", name: "Project" },
                { id: "extra", name: "Extra" },
              ],
            };
          if (path.startsWith("artifacts?")) return { artifacts: entries };
          if (path.startsWith("files/list?")) return { directoryId: "root", entries };
          if (path.startsWith("files/text?")) return { text: "Text from the authorized file" };
          if (path === "artifact-tickets")
            return ticket(entries.find((entry) => entry.id === body?.artifactId)!);
          throw new Error(`unexpected path ${path}`);
        }),
      },
      access: { device: { files: true } },
      current: { workspace_id: "workspace" },
      selected: "session-one",
      locale: "en-US",
    };
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function show() {
    const view = render(<ArtifactBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Files & artifacts" }));
    await screen.findByRole("button", { name: "report.txt" });
    return view;
  }
  it("does not expose file UI or make requests without the device files grant", () => {
    session.access.device.files = false;
    render(<ArtifactBrowser />);
    expect(screen.queryByRole("button", { name: "Files & artifacts" })).not.toBeInTheDocument();
    expect(session.client.request).not.toHaveBeenCalled();
  });
  it.each([
    ["zh-CN", "请在电脑上的 AgentKib 的 Web 设置中授权目录。"],
    ["zh-Hant", "請在電腦上的 AgentKib 的 Web 設定中授權目錄。"],
    ["en-US", "Authorize directories in Web settings in AgentKib on your computer."],
    ["ja-JP", "コンピューター上の AgentKib の Web 設定でディレクトリを許可してください。"],
  ] as const)(
    "points an empty authorized-directory list to the computer application in %s",
    async (locale, notice) => {
      session.locale = locale;
      session.client.request.mockResolvedValue({ workspaces: [] });
      render(<ArtifactBrowser />);
      fireEvent.click(screen.getByRole("button", { name: artifactCopy(locale).title }));
      expect(await screen.findByText(notice)).toBeVisible();
      expect(session.client.request).toHaveBeenCalledWith(
        "files/workspaces",
        undefined,
        expect.any(AbortSignal),
      );
      expect(session.client.request.mock.calls.every(([path]) => path === "files/workspaces")).toBe(
        true,
      );
    },
  );
  it("loads session references, opaque directory ids and revision-bound text", async () => {
    await show();
    expect(session.client.request).toHaveBeenCalledWith(
      "artifacts?workspaceId=workspace&sessionId=session-one",
      undefined,
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole("button", { name: "report.txt" }));
    await screen.findByText("Text from the authorized file");
    expect(session.client.request).toHaveBeenCalledWith(
      "files/text?workspaceId=workspace&artifactId=report&revision=revision-report",
      undefined,
      expect.any(AbortSignal),
    );
    entries = [{ ...file("folder-id", "download", "output"), kind: "directory" }];
    fireEvent.click(screen.getByRole("tab", { name: "Project files" }));
    fireEvent.click(await screen.findByRole("button", { name: /output/ }));
    await waitFor(() =>
      expect(session.client.request).toHaveBeenCalledWith(
        "files/list?workspaceId=workspace&directoryId=folder-id",
        undefined,
        expect.any(AbortSignal),
      ),
    );
  });
  it("renders interactive HTML in an opaque sandbox and media with native HTTPS URLs", async () => {
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: "index.html" }));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).not.toHaveAttribute("srcdoc");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("src", "https://preview.example/p/first/index.html");
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    fireEvent.click(screen.getByRole("button", { name: "movie.mp4" }));
    await waitFor(() =>
      expect(view.container.querySelector("video")).toHaveAttribute(
        "src",
        "https://preview.example/p/first/movie.mp4",
      ),
    );
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video.src).not.toMatch(/^blob:/);
    expect(view.container.querySelector("iframe")).toBeNull();
  });
  it("ignores late text when changing authorized directories", async () => {
    await show();
    const normal = session.client.request.getMockImplementation()! as (
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ) => unknown;
    let finish!: (value: { text: string }) => void;
    session.client.request.mockImplementation(
      (path: string, body?: unknown, signal?: AbortSignal) => {
        if (path.startsWith("files/text?"))
          return new Promise((resolve) => {
            finish = resolve;
          });
        return normal(path, body, signal);
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "report.txt" }));
    await waitFor(() => expect(finish).toBeDefined());
    await userEvent.click(screen.getByRole("combobox", { name: "Authorized directory" }));
    await userEvent.click(await screen.findByRole("option", { name: "Extra" }));
    await act(async () => {
      finish({ text: "Late private text" });
    });
    expect(screen.queryByText("Late private text")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Prepare download" })).not.toBeInTheDocument();
  });
  it("refreshes references and clears previews when changing sessions in the same workspace", async () => {
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: "index.html" }));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    entries = [file("new-report", "text", "new-report.txt")];
    session.selected = "session-two";
    view.rerender(<ArtifactBrowser />);
    await screen.findByRole("button", { name: "new-report.txt" });
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("button", { name: "report.txt" })).not.toBeInTheDocument();
    expect(session.client.request).toHaveBeenCalledWith(
      "artifacts?workspaceId=workspace&sessionId=session-two",
      undefined,
      expect.any(AbortSignal),
    );
  });
  it("renews media tickets, restores playback and blocks a changed file revision", async () => {
    const view = await show();
    const normal = session.client.request.getMockImplementation()! as (
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ) => unknown;
    let count = 0;
    session.client.request.mockImplementation(
      (path: string, body?: unknown, signal?: AbortSignal) => {
        if (path === "artifact-tickets") {
          count++;
          return Promise.resolve({
            ...ticket(movie, `ticket-${count}`),
            expiresAt: Date.now() + (count === 1 ? 31_000 : 60_000),
            revision: count >= 3 ? "changed" : movie.revision,
          });
        }
        return normal(path, body, signal);
      },
    );
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "movie.mp4" }));
    });
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", "https://preview.example/p/ticket-1/movie.mp4");
    video.currentTime = 37;
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    const play = vi.spyOn(video, "play").mockResolvedValue();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(video).toHaveAttribute("src", "https://preview.example/p/ticket-2/movie.mp4");
    video.currentTime = 0;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(37);
    expect(play).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(view.container.querySelector("video")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("File changed. Open it again.");
  });
  it("clears rendered file contents immediately when file permission is revoked", async () => {
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: "report.txt" }));
    await screen.findByText("Text from the authorized file");
    session.access.device.files = false;
    view.rerender(<ArtifactBrowser />);
    expect(screen.queryByText("Text from the authorized file")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps an unexpired media ticket during a temporary renewal failure and retries", async () => {
    const view = await show();
    const normal = session.client.request.getMockImplementation()! as (
      path: string,
      body?: { artifactId?: string },
    ) => unknown;
    let issued = 0;
    session.client.request.mockImplementation((path: string, body?: { artifactId?: string }) => {
      if (path !== "artifact-tickets") return normal(path, body);
      issued++;
      if (issued === 2) return Promise.reject(new Error("network interruption"));
      return Promise.resolve({
        ...ticket(movie, `renew-${issued}`),
        expiresAt: Date.now() + 31_000,
      });
    });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "movie.mp4" }));
    });
    const video = view.container.querySelector("video")!;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(video).toHaveAttribute("src", "https://preview.example/p/renew-1/movie.mp4");
    video.currentTime = 42;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(video).toHaveAttribute("src", "https://preview.example/p/renew-3/movie.mp4");
    video.currentTime = 0;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(42);
  });
  it("removes an expired preview even if renewal never responds", async () => {
    const view = await show();
    const normal = session.client.request.getMockImplementation()! as (
      path: string,
      body?: { artifactId?: string },
    ) => unknown;
    let issued = 0;
    session.client.request.mockImplementation((path: string, body?: { artifactId?: string }) => {
      if (path !== "artifact-tickets") return normal(path, body);
      if (++issued > 1) return new Promise(() => {});
      return Promise.resolve({ ...ticket(movie), expiresAt: Date.now() + 2000 });
    });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "movie.mp4" }));
    });
    expect(view.container.querySelector("video")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(view.container.querySelector("video")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Preview expired");
  });
  it("keeps one media element and ticket when changing between full screen and sidebar", async () => {
    let wide = false;
    let update!: () => void;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return wide;
        },
        addEventListener: (_: string, listener: () => void) => {
          update = listener;
        },
        removeEventListener: vi.fn(),
      })),
    );
    const view = render(<ArtifactBrowser />, {
      wrapper: ({ children }) => (
        <ArtifactWorkspace browser={children}>
          <button>Continue chat</button>
        </ArtifactWorkspace>
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "Files & artifacts" }));
    fireEvent.click(await screen.findByRole("button", { name: "movie.mp4" }));
    await waitFor(() => expect(view.container.querySelector("video")).not.toBeNull());
    const video = view.container.querySelector("video")!;
    video.currentTime = 21;
    const requests = session.client.request.mock.calls.length;
    act(() => {
      wide = true;
      update();
    });
    expect(screen.getByRole("complementary")).not.toHaveAttribute("aria-modal");
    expect(view.container.querySelector("video")).toBe(video);
    expect(video.currentTime).toBe(21);
    screen.getByRole("button", { name: "Continue chat" }).focus();
    act(() => {
      wide = false;
      update();
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    expect(view.container.querySelector("video")).toBe(video);
    expect(session.client.request.mock.calls.length).toBe(requests);
  });
  it("returns to the existing list and stops media on close without issuing a new ticket", async () => {
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: "movie.mp4" }));
    await waitFor(() => expect(view.container.querySelector("video")).not.toBeNull());
    const video = view.container.querySelector("video")!;
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(video.pause).toHaveBeenCalled();
    expect(video).not.toHaveAttribute("src");
    expect(screen.getByRole("button", { name: "movie.mp4" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "movie.mp4" }));
    await waitFor(() => expect(view.container.querySelector("video")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Close files" }));
    expect(view.container.querySelector("video")).toBeNull();
    const tickets = session.client.request.mock.calls.filter(
      ([path]) => path === "artifact-tickets",
    );
    expect(tickets).toHaveLength(2);
  });
  it("supports controlled visibility, aborts pending reads, and ignores their late completion", async () => {
    const change = vi.fn();
    const view = render(<ArtifactBrowser open onOpenChange={change} showTrigger={false} />);
    await screen.findByRole("button", { name: "report.txt" });
    expect(screen.queryByRole("button", { name: "Files & artifacts" })).toBeNull();
    let finish!: (result: { text: string }) => void;
    let signal!: AbortSignal;
    session.client.request.mockImplementation((_: string, __: unknown, next: AbortSignal) => {
      signal = next;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "report.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Close files" }));
    expect(change).toHaveBeenCalledWith(false);
    view.rerender(<ArtifactBrowser open={false} onOpenChange={change} showTrigger={false} />);
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish({ text: "Late hidden text" });
    });
    expect(screen.queryByText("Late hidden text")).toBeNull();
  });
  it("traps modal focus and restores the opener when closing with Escape", async () => {
    render(<ArtifactBrowser />);
    const opener = screen.getByRole("button", { name: "Files & artifacts" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("button", { name: "report.txt" });
    const firstControl = screen.getByRole("button", { name: "Refresh" });
    firstControl.focus();
    await userEvent.setup().tab({ shift: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "photo.png" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it.each([false, true])(
    "obtains an explicit download link only on request (embedded: %s)",
    async (embedded) => {
      session.embedded = embedded;
      const view = await show();
      fireEvent.click(screen.getByRole("button", { name: "photo.png" }));
      expect(await screen.findByRole("img", { name: "photo.png" })).toHaveAttribute(
        "src",
        "https://preview.example/p/first/photo.png",
      );
      expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Prepare download" }));
      const download = await screen.findByRole("link", { name: "Download" });
      expect(download).toHaveAttribute("download");
      expect(download).toHaveAttribute("href", "https://preview.example/p/first/photo.png");
      if (embedded) expect(download).toHaveAttribute("target", "_blank");
      else expect(download).not.toHaveAttribute("target");
      expect(session.client.request).toHaveBeenCalledWith(
        "artifact-tickets",
        { workspaceId: "workspace", artifactId: "photo", download: true },
        expect.any(AbortSignal),
      );
      view.unmount();
    },
  );
  it("restores focus after revealing the background when resized through sidebar and modal", async () => {
    let wide = false;
    let update!: () => void;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return wide;
        },
        addEventListener: (_: string, listener: () => void) => {
          update = listener;
        },
        removeEventListener: vi.fn(),
      })),
    );
    render(<ArtifactBrowser />);
    const opener = screen.getByRole("button", { name: "Files & artifacts" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("button", { name: "index.html" });
    fireEvent.click(screen.getByRole("button", { name: "index.html" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    act(() => {
      wide = true;
      update();
    });
    act(() => {
      wide = false;
      update();
    });
    expect(opener.closest('[aria-hidden="true"]')).not.toBeNull();
    const realFocus = opener.focus.bind(opener);
    const attempts: boolean[] = [];
    vi.spyOn(opener, "focus").mockImplementation(() => {
      const hidden = Boolean(opener.closest('[aria-hidden="true"]'));
      attempts.push(hidden);
      if (!hidden) realFocus();
    });
    fireEvent.click(screen.getByRole("button", { name: "Close files" }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(attempts).toEqual([false]);
  });
  it("does not restore focus over another modal opened while the file panel closes", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const focus = vi.spyOn(opener, "focus");
    const view = render(
      <ArtifactPanel labelledBy="files-heading" onClose={() => {}}>
        <h2 id="files-heading">Files</h2>
      </ArtifactPanel>,
    );
    view.rerender(
      <div role="dialog" aria-modal="true">
        <button autoFocus>Next action</button>
      </div>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Next action" })).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    opener.remove();
  });
});
