// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { AgentKind, SkillDeployment, SkillObservation, WorkspaceSummary } from "@/core/types";
import { SkillUsageList } from "./SkillManagerPanels";

const personal: SkillObservation = {
  id: "personal-release-notes",
  name: "release-notes",
  path: "/fixture/home/.claude/skills/release-notes",
  resolved_path: "/fixture/home/.claude/skills/release-notes",
  scope: "personal",
  workspace_id: null,
  agents: ["claude-code", "cursor", "opencode", "grok-build"],
  kind: "directory",
  status: "observed",
  owner: "external",
  library_id: null,
  diagnostics: [],
};
const related: SkillObservation = {
  ...personal,
  id: "project-release-notes",
  scope: "workspace",
  workspace_id: "northstar",
  agents: ["opencode"],
};
const workspace: WorkspaceSummary = {
  id: "northstar",
  name: "northstar-api",
  path: "/fixture/northstar-api",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
function mount(
  observations = [related, personal],
  deployments: SkillDeployment[] = [],
  workspaces = [workspace],
) {
  const onOpen = vi.fn();
  const onImport = vi.fn();
  const onDetail = vi.fn();
  const view = render(
    <SkillUsageList
      inventory={{ observations, warnings: [] }}
      deployments={deployments}
      installed={[]}
      workspaces={workspaces}
      loading={false}
      busy={false}
      onDetail={onDetail}
      onImport={onImport}
      onAction={vi.fn()}
      onOpen={onOpen}
    />,
  );
  return { ...view, onOpen, onImport, onDetail };
}
beforeEach(() => initializeI18n("en-US"));
afterEach(cleanup);

describe("v15 usage location cards", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps a personal source with a workspace relationship compact in %s",
    async (locale) => {
      await initializeI18n(locale);
      expect(tr("skills.manager.visibleTo")).not.toBe("skills.manager.visibleTo");
      const { onOpen, onImport, onDetail } = mount();
      const user = userEvent.setup();
      const name = screen.getByText(personal.name);
      const card = name.closest<HTMLElement>(".rounded-xl")!;
      const source = within(card).getByText(tr("skills.manager.personal"));
      expect(
        within(card).queryByText(tr("skills.manager.projectSource", { name: workspace.name })),
      ).toBeNull();
      expect(source.closest('[data-slot="badge"]')?.parentElement).toBe(
        within(card).getByTitle(personal.path).parentElement,
      );
      expect(screen.queryByText(tr("skills.manager.status.observed"))).toBeNull();
      expect(
        screen.queryByRole("checkbox", { name: tr("skills.manager.showInactive") }),
      ).toBeNull();
      const notice = screen.getByText(tr("skills.manager.inventoryNotice"));
      expect(notice.parentElement?.querySelector("svg.lucide-lock-keyhole")).not.toBeNull();
      expect(
        notice.parentElement!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.queryByText(tr("skills.manager.visibilityNotice"))).toBeNull();
      const visibility = within(card).getByText(tr("skills.manager.visibleTo")).parentElement!;
      for (const agent of ["Claude Code", "Cursor", "OpenCode", "Grok Build"]) {
        const badge = within(visibility).getByText(agent).closest('[data-slot="badge"]');
        expect(badge).toHaveClass(
          "bg-[color-mix(in_srgb,var(--foreground)_5%,var(--background))]",
          "text-foreground",
        );
        expect(badge?.querySelector("img")).not.toBeNull();
      }
      const info = within(visibility).getByRole("button");
      await user.hover(info);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        tr("skills.manager.visibilityNotice"),
      );
      await user.unhover(info);
      await user.keyboard("{Escape}");
      fireEvent.click(info);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent(tr("skills.manager.visibilityNotice"));
      expect(info).toHaveAttribute("aria-describedby", tooltip.id);
      await user.keyboard("{Escape}");
      const more = within(card).getByRole("button", {
        name: new RegExp(`^${tr("common.moreActions")}`),
      });
      expect(more.textContent).toBe("");
      expect(more.parentElement?.parentElement).toContainElement(
        within(card).getByRole("button", { name: tr("skills.manager.viewNative") }),
      );
      await user.click(more);
      await user.click(
        await screen.findByRole("menuitem", {
          name: `${tr("skills.manager.openWorkspace")} · ${workspace.name}`,
        }),
      );
      expect(onOpen).toHaveBeenCalledWith(workspace.id);
      await user.click(within(card).getByRole("button", { name: tr("skills.manager.viewNative") }));
      expect(onDetail).toHaveBeenCalledWith({ observation_id: related.id });
      await user.click(within(card).getByRole("button", { name: tr("skills.manager.addNative") }));
      expect(onImport).toHaveBeenCalledWith(related.id);
    },
  );
  it.each(["native-restricted", "pending-trust", "unverified", "broken-link"])(
    "keeps %s separate from Agent labels and preserves diagnostics",
    (status) => {
      mount([
        { ...personal, status: "visible" },
        {
          ...related,
          status,
          diagnostics: ["Disabled by native configuration"],
        },
      ]);
      const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
      const restricted = screen.getByText(tr(`skills.manager.status.${status}`));
      expect(visible).not.toContainElement(restricted);
      expect(restricted.closest('[data-slot="badge"]')).toHaveClass(
        "border-amber-500/40",
        "text-amber-700",
      );
      expect(screen.queryByText(tr("skills.manager.status.visible"))).toBeNull();
      expect(screen.queryByText("Disabled by native configuration")).toBeNull();
      expect(screen.getByText(tr("skills.manager.load.detailsNotice"))).toBeVisible();
    },
  );
  it("shows only the project source when there is no personal observation", () => {
    mount([related]);
    expect(
      screen.getByText(tr("skills.manager.projectSource", { name: workspace.name })),
    ).toBeVisible();
    expect(
      screen.queryByText(tr("skills.manager.personal"), { selector: '[data-slot="badge"]' }),
    ).toBeNull();
  });
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "separates the real shared-root Hermes and OpenClaw failures in %s",
    async (locale) => {
      await initializeI18n(locale);
      const diagnostics = [
        "Hermes: project skills are not loaded because this project has no Git root",
        "OpenClaw: native enablement is unknown because workspace or skills configuration could not be resolved",
      ];
      mount([
        {
          ...related,
          path: "/fixture/northstar-api/.agents/skills/release-notes",
          resolved_path: "/fixture/northstar-api/.agents/skills/release-notes",
          agents: ["codex", "cursor", "opencode", "hermes", "open-claw"],
          diagnostics,
        },
      ]);
      const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
      for (const agent of ["Codex", "Cursor", "OpenCode"])
        expect(within(visible).getByText(agent)).toBeVisible();
      for (const agent of ["Hermes", "OpenClaw"])
        expect(within(visible).queryByText(agent)).toBeNull();
      for (const [agent, kind, reason] of [
        ["Hermes", "blocked", "noGitRoot"],
        ["OpenClaw", "unknown", "configUnavailable"],
      ]) {
        const translatedReason = tr(`skills.manager.load.reason.${reason}`);
        expect(translatedReason).not.toContain("skills.manager.load.");
        const message = tr(`skills.manager.load.${kind}`, { agent, reason: translatedReason });
        expect(message).not.toContain("skills.manager.load.");
        const line = screen.getByText(message);
        expect(line).toBeVisible();
        expect(visible).not.toContainElement(line);
      }
      for (const diagnostic of diagnostics) expect(screen.queryByText(diagnostic)).toBeNull();
    },
  );
  it.each<{
    agent: AgentKind;
    label: string;
    diagnostic: string;
    kind: string;
    reason: string;
  }>([
    {
      agent: "hermes",
      label: "Hermes",
      diagnostic:
        "Hermes: native project discovery reads the nearest Git root /fixture/root, not this nested project directory",
      kind: "blocked",
      reason: "differentGitRoot",
    },
    {
      agent: "hermes",
      label: "Hermes",
      diagnostic: "Hermes profile /fixture/profile: project discovery is disabled in config.yaml",
      kind: "blocked",
      reason: "projectDiscoveryDisabled",
    },
    {
      agent: "hermes",
      label: "Hermes",
      diagnostic:
        "Hermes profile /fixture/profile: Git root is not trusted; run hermes skills trust yourself before native loading",
      kind: "confirmation",
      reason: "projectNotTrusted",
    },
    {
      agent: "hermes",
      label: "Hermes",
      diagnostic:
        "Hermes profile /fixture/profile: project trust is unknown because config.yaml could not be read",
      kind: "unknown",
      reason: "trustUnavailable",
    },
    {
      agent: "open-claw",
      label: "OpenClaw",
      diagnostic:
        "OpenClaw: this Skill name is disabled by skills.entries in openclaw.json; metadata skillKey aliases may differ",
      kind: "blocked",
      reason: "nativeConfigDisabled",
    },
    {
      agent: "open-claw",
      label: "OpenClaw",
      diagnostic:
        "OpenClaw: this project has no configured native Agent workspace, so its Skill files are not discoverable",
      kind: "blocked",
      reason: "nativeWorkspaceMissing",
    },
    {
      agent: "open-claw",
      label: "OpenClaw",
      diagnostic:
        "OpenClaw Agent main: excluded by its effective skills allowlist (per-Agent settings replace defaults)",
      kind: "blocked",
      reason: "allowlistExcluded",
    },
    {
      agent: "opencode",
      label: "OpenCode",
      diagnostic: "OpenCode: permission.skill is deny for this Skill",
      kind: "blocked",
      reason: "nativeConfigDisabled",
    },
    {
      agent: "opencode",
      label: "OpenCode",
      diagnostic: "OpenCode: permission.skill is ask for this Skill",
      kind: "confirmation",
      reason: "permissionRequired",
    },
    {
      agent: "opencode",
      label: "OpenCode",
      diagnostic:
        "OpenCode: native enablement is unknown because a configuration file could not be read or parsed",
      kind: "unknown",
      reason: "configUnavailable",
    },
    {
      agent: "codex",
      label: "Codex",
      diagnostic: "Codex: this Skill is disabled by skills.config in config.toml",
      kind: "blocked",
      reason: "nativeConfigDisabled",
    },
    {
      agent: "codex",
      label: "Codex",
      diagnostic: "Codex: native enablement is unknown because config.toml could not be read",
      kind: "unknown",
      reason: "configUnavailable",
    },
    {
      agent: "grok-build",
      label: "Grok Build",
      diagnostic: "Grok: compat.claude.skills is disabled",
      kind: "blocked",
      reason: "nativeConfigDisabled",
    },
    {
      agent: "grok-build",
      label: "Grok Build",
      diagnostic:
        "Grok: native skills.disabled, skills.ignore or compatibility settings restrict this Skill",
      kind: "blocked",
      reason: "nativeConfigDisabled",
    },
    {
      agent: "grok-build",
      label: "Grok Build",
      diagnostic: "Grok: native enablement is unknown because config.toml could not be read",
      kind: "unknown",
      reason: "configUnavailable",
    },
    {
      agent: "codex",
      label: "Codex",
      diagnostic: "Codex: a future native loading condition is not understood",
      kind: "unknown",
      reason: "unverified",
    },
  ])(
    "explains $diagnostic without claiming $label is visible",
    ({ agent, label, diagnostic, kind, reason }) => {
      mount([{ ...related, agents: [agent, "cursor"], diagnostics: [diagnostic] }]);
      const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
      expect(within(visible).queryByText(label)).toBeNull();
      expect(within(visible).getByText("Cursor")).toBeVisible();
      expect(
        screen.getByText(
          tr(`skills.manager.load.${kind}`, {
            agent: label,
            reason: tr(`skills.manager.load.reason.${reason}`),
          }),
        ),
      ).toBeVisible();
      expect(screen.queryByText(diagnostic)).toBeNull();
    },
  );
  it("retains an Agent's confirmed personal alias when its project entry is restricted", () => {
    const diagnostic = "OpenCode: permission.skill is deny for this Skill";
    mount([
      { ...personal, agents: ["opencode"] },
      {
        ...related,
        path: "/fixture/northstar-api/.agents/skills/release-notes",
        kind: "symlink",
        agents: ["opencode", "hermes"],
        diagnostics: [
          diagnostic,
          "Hermes: project skills are not loaded because this project has no Git root",
        ],
      },
    ]);
    const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
    expect(within(visible).getByText("OpenCode")).toBeVisible();
    expect(within(visible).queryByText("Hermes")).toBeNull();
    const failure = screen.getByText(
      tr("skills.manager.load.blocked", {
        agent: "OpenCode",
        reason: tr("skills.manager.load.reason.nativeConfigDisabled"),
      }),
    );
    expect(failure.parentElement).toHaveTextContent(
      tr("skills.manager.projectSource", { name: workspace.name }),
    );
    expect(
      failure.parentElement?.querySelector(
        `[title="/fixture/northstar-api/.agents/skills/release-notes"]`,
      ),
    ).not.toBeNull();
    expect(screen.queryByText(diagnostic)).toBeNull();
  });
  it("keeps OpenClaw visible when another effective native Agent explicitly allows it", () => {
    mount([
      {
        ...related,
        agents: ["open-claw"],
        diagnostics: [
          "OpenClaw Agent denied: excluded by its effective skills allowlist (per-Agent settings replace defaults)",
          "OpenClaw Agent allowed: allowed by its effective skills allowlist (per-Agent settings replace defaults)",
        ],
      },
    ]);
    const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
    expect(within(visible).getByText("OpenClaw")).toBeVisible();
    const exception = screen.getByText(
      tr("skills.manager.load.blocked", {
        agent: "OpenClaw",
        reason: tr("skills.manager.load.reason.allowlistExcluded"),
      }),
    );
    expect(exception.parentElement).toHaveTextContent("denied");
    expect(screen.queryByText(/excluded by its effective skills allowlist/)).toBeNull();
    expect(screen.queryByText(/allowed by its effective skills allowlist/)).toBeNull();
  });
  it("keeps a trusted Hermes profile visible without treating session refresh advice as a failure", () => {
    const diagnostic =
      "Hermes profile /fixture/trusted-profile: Git root is trusted; native content quarantine and session refresh still apply";
    mount([{ ...related, agents: ["hermes"], diagnostics: [diagnostic] }]);
    const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
    expect(within(visible).getByText("Hermes")).toBeVisible();
    expect(screen.queryByText(diagnostic)).toBeNull();
    expect(
      screen.queryByText(/Hermes (will not load|loading is unconfirmed|needs confirmation)/),
    ).toBeNull();
  });
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps normal trusted, allowed and linked-owner information only in details in %s",
    async (locale) => {
      await initializeI18n(locale);
      const diagnostics = [
        "Hermes profile /fixture/trusted-profile: Git root is trusted; native content quarantine and session refresh still apply",
        "OpenClaw Agent main: allowed by its effective skills allowlist (per-Agent settings replace defaults)",
        "Linked Skill is read-only until copied to the library",
        "Shared package managed outside AgentKib",
      ];
      const { container } = mount([{ ...related, agents: ["hermes", "open-claw"], diagnostics }]);
      const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
      for (const agent of ["Hermes", "OpenClaw"])
        expect(within(visible).getByText(agent)).toBeVisible();
      expect(screen.queryByText(tr("skills.manager.load.detailsNotice"))).toBeNull();
      expect(container.querySelector(".text-amber-700")).toBeNull();
      for (const diagnostic of diagnostics) expect(screen.queryByText(diagnostic)).toBeNull();
    },
  );
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "distinguishes a restricted Hermes profile from another trusted profile in %s",
    async (locale) => {
      await initializeI18n(locale);
      mount([
        {
          ...related,
          agents: ["hermes"],
          diagnostics: [
            "Hermes profile /fixture/untrusted-profile: Git root is not trusted; run hermes skills trust yourself before native loading",
            "Hermes profile /fixture/trusted-profile: Git root is trusted; native content quarantine and session refresh still apply",
          ],
        },
      ]);
      const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
      expect(within(visible).getByText("Hermes")).toBeVisible();
      const exception = screen.getByText(
        tr("skills.manager.load.confirmation", {
          agent: "Hermes",
          reason: tr("skills.manager.load.reason.projectNotTrusted"),
        }),
      );
      expect(
        exception.parentElement?.querySelector('[title="/fixture/untrusted-profile"]'),
      ).not.toBeNull();
      expect(screen.queryByText(/run hermes skills trust/)).toBeNull();
      expect(screen.queryByText(/native content quarantine/)).toBeNull();
    },
  );
  it("does not present an unrecognized native diagnostic as positive loading evidence", () => {
    const diagnostic = "A future native skill loading rule could not be evaluated";
    mount([{ ...related, agents: ["opencode"], diagnostics: [diagnostic] }]);
    const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
    expect(within(visible).queryByText("OpenCode")).toBeNull();
    expect(
      screen.getByText(
        tr("skills.manager.load.unknown", {
          agent: "OpenCode",
          reason: tr("skills.manager.load.reason.unverified"),
        }),
      ),
    ).toBeVisible();
    expect(screen.queryByText(diagnostic)).toBeNull();
  });
  it.each([
    "Linked Skill is read-only until copied to the library",
    "Deployment ownership could not be verified",
    "Shared package managed outside AgentKib",
  ])("does not interpret %s as an Agent loading restriction", (diagnostic) => {
    mount([
      {
        ...personal,
        status: diagnostic.startsWith("Deployment") ? "unverified" : "observed",
        diagnostics: [diagnostic],
      },
    ]);
    const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
    for (const agent of ["Claude Code", "Cursor", "OpenCode", "Grok Build"])
      expect(within(visible).getByText(agent)).toBeVisible();
    expect(screen.queryByText(diagnostic)).toBeNull();
  });
  it.each(
    (["zh-CN", "zh-TW", "en-US", "ja-JP"] as const).flatMap((locale) =>
      (["unverified", "recovery-required"] as const).map((status) => ({ locale, status })),
    ),
  )(
    "keeps unresolved links out of visibility after $status replaces their status in $locale",
    async ({ locale, status }) => {
      await initializeI18n(locale);
      mount([
        {
          ...personal,
          kind: "symlink",
          resolved_path: null,
          status,
          diagnostics: [
            "Linked Skill is read-only until copied to the library",
            status === "unverified"
              ? "Deployment ownership could not be verified"
              : "Interrupted Skill synchronization requires recovery",
          ],
        },
      ]);
      const visible = screen.getByText(tr("skills.manager.visibleTo")).parentElement!;
      for (const agent of ["Claude Code", "Cursor", "OpenCode", "Grok Build"]) {
        expect(within(visible).queryByText(agent)).toBeNull();
        expect(
          screen.getByText(
            tr("skills.manager.load.unknown", {
              agent,
              reason: tr("skills.manager.load.reason.unverified"),
            }),
          ),
        ).toBeVisible();
      }
      expect(screen.getByText(tr("skills.manager.load.detailsNotice"))).toBeVisible();
    },
  );
  it.each([
    "Deployment ownership could not be verified",
    "Interrupted Skill synchronization requires recovery",
  ])("retains a localized notice for the non-loading anomaly %s", (diagnostic) => {
    mount([
      {
        ...personal,
        status: diagnostic.startsWith("Deployment") ? "unverified" : "recovery-required",
        diagnostics: [diagnostic],
      },
    ]);
    expect(screen.getByText(tr("skills.manager.load.detailsNotice"))).toBeVisible();
    expect(screen.queryByText(diagnostic)).toBeNull();
  });
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "bounds a long project source while retaining its full name and original path in %s",
    async (locale) => {
      await initializeI18n(locale);
      const longWorkspace = {
        ...workspace,
        name: `${workspace.name}-${"long-project-name-".repeat(8)}`,
      };
      const { onDetail, onImport } = mount([related], [], [longWorkspace]);
      const source = tr("skills.manager.projectSource", { name: longWorkspace.name });
      const label = screen.getByText(source);
      expect(label.closest('[data-slot="badge"]')).toHaveClass("max-w-[240px]");
      expect(label).toHaveClass("truncate");
      expect(label).toHaveAttribute("title", source);
      const path = screen.getByTitle(related.path);
      expect(path.parentElement).toBe(label.closest('[data-slot="badge"]')?.parentElement);
      expect(path).toHaveClass("flex-1", "truncate");
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: tr("skills.manager.viewNative") }));
      await user.click(screen.getByRole("button", { name: tr("skills.manager.addNative") }));
      expect(onDetail).toHaveBeenCalledExactlyOnceWith({ observation_id: related.id });
      expect(onImport).toHaveBeenCalledExactlyOnceWith(related.id);
    },
  );
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps long workspace actions on one bounded line with their full accessible name in %s",
    async (locale) => {
      await initializeI18n(locale);
      const longWorkspace = {
        ...workspace,
        name: `${workspace.name}-${"long-project-name-".repeat(12)}`,
      };
      const { onOpen } = mount([related], [], [longWorkspace]);
      const user = userEvent.setup();
      const more = screen.getByRole("button", {
        name: new RegExp(`^${tr("common.moreActions")}`),
      });
      await user.click(more);
      const menu = await screen.findByRole("menu");
      expect(menu).toHaveClass("w-max", "max-w-[min(360px,calc(100vw-2rem))]");
      await user.keyboard("{Escape}");
      expect(more).toHaveFocus();
      await user.click(more);
      const label = `${tr("skills.manager.openWorkspace")} · ${longWorkspace.name}`;
      const action = await screen.findByRole("menuitem", { name: label });
      expect(within(action).getByText(label)).toHaveClass("truncate");
      expect(action).toHaveAttribute("title", label);
      await user.click(action);
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(workspace.id);
    },
  );
});
