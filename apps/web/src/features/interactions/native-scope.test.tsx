import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NativeScope } from "@/features/conversation/features/interactions/native-scope";
afterEach(cleanup);
it.each([
  ["zh-CN", "主机"],
  ["zh-TW", "主機"],
  ["en-US", "Host"],
  ["ja-JP", "ホスト"],
] as const)("keeps %s host as the network permission destination", (locale, label) => {
  render(
    <NativeScope
      locale={locale}
      value={{ networkApprovalContext: { host: "destination.example.test", protocol: "https" } }}
    />,
  );
  const destination = screen.getByText("https://destination.example.test", {
    exact: false,
    selector: "li",
  });
  expect(destination).toHaveTextContent(`${label}: https://destination.example.test`);
});
it("keeps permission paths and network scope visible while collapsing raw metadata", () => {
  const { container } = render(
    <NativeScope
      locale="en-US"
      value={{
        cwd: "/project",
        grantRoot: "/authorized",
        networkApprovalContext: { host: "example.test", protocol: "https" },
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/read"],
            write: ["/write"],
            entries: [{ access: "deny", path: { type: "glob_pattern", pattern: "/private/**" } }],
          },
        },
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: "Permission scope" })).toBeVisible();
  for (const value of ["/authorized", "/read", "/write", "/private/**", "https://example.test"])
    expect(screen.getByText(value, { exact: false, selector: "li" })).toBeVisible();
  expect(container.querySelector("details")).not.toHaveAttribute("open");
});
it("shows a command or network rule without expanding native JSON", () => {
  const { rerender } = render(
    <NativeScope
      locale="zh-CN"
      candidate
      value={{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } }}
    />,
  );
  expect(screen.getByText(/git status/)).toBeVisible();
  rerender(
    <NativeScope
      locale="zh-CN"
      candidate
      value={{
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { action: "deny", host: "private.test" },
        },
      }}
    />,
  );
  expect(screen.getByText(/拒绝 · private.test/)).toBeVisible();
});
