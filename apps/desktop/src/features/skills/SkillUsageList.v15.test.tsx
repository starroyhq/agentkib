// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { SkillDeployment, SkillObservation, WorkspaceSummary } from "@/core/types";
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
function mount(observations = [related, personal], deployments: SkillDeployment[] = []) {
  const onOpen = vi.fn();
  const onImport = vi.fn();
  const onDetail = vi.fn();
  const view = render(
    <SkillUsageList
      inventory={{ observations, warnings: [] }}
      deployments={deployments}
      installed={[]}
      workspaces={[workspace]}
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
      expect(source.parentElement).toBe(within(card).getByTitle(personal.path).parentElement);
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
      expect(screen.getByText("Disabled by native configuration")).toBeVisible();
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
});
