// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PathDisplayProvider, usePathDisplay } from "./usePathDisplay";

const bridge = vi.hoisted(() => ({ displayContext: vi.fn() }));
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ paths: bridge }) }));

function Path() {
  const displayPath = usePathDisplay();
  return <span title="/fixture/home/work">{displayPath("/fixture/home/work")}</span>;
}

afterEach(() => {
  cleanup();
  bridge.displayContext.mockReset();
});

describe("desktop path display context", () => {
  it("keeps the original path available while a trusted home is loading", async () => {
    let resolve!: (value: { homeDirectory: string }) => void;
    bridge.displayContext.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(
      <PathDisplayProvider>
        <Path />
      </PathDisplayProvider>,
    );
    expect(screen.getByText("/fixture/home/work").title).toBe("/fixture/home/work");
    await act(async () => {
      resolve({ homeDirectory: "/fixture/home" });
    });
    expect(screen.getByText("~/work").title).toBe("/fixture/home/work");
    expect(bridge.displayContext).toHaveBeenCalledTimes(1);
  });

  it("does not block the page or invent a home after a read failure", async () => {
    bridge.displayContext.mockRejectedValue(new Error("unavailable"));
    render(
      <PathDisplayProvider>
        <Path />
      </PathDisplayProvider>,
    );
    await act(async () => {});
    expect(screen.getByText("/fixture/home/work")).toBeDefined();
  });

  it("ignores a late result after the provider unmounts", async () => {
    let resolve!: (value: { homeDirectory: string }) => void;
    bridge.displayContext.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(
      <PathDisplayProvider>
        <Path />
      </PathDisplayProvider>,
    );
    await act(async () => {});
    view.unmount();
    await act(async () => {
      resolve({ homeDirectory: "/fixture/home" });
    });
    expect(screen.queryByText("~/work")).toBeNull();
  });
});
