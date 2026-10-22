// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Skills } from "../../../../../packages/backend/src/skills";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  InstalledSkill,
  PrepareSkillSyncRequest,
  SkillDeployment,
  SkillInventory,
  SkillSyncPreview,
  SkillSyncReport,
  SkillSyncState,
  SkillSyncPolicy,
} from "@/core/types";
import { SkillUsageList } from "./SkillManagerPanels";
import { SkillSyncDialog, SkillSyncPolicyDialog } from "./SkillSyncPanels";

const homes: string[] = [];
const clients: QueryClient[] = [];
beforeAll(() => initializeI18n("en-US"));
afterEach(async () => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(personal = false) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentkib-sync-ui-flow-"));
  homes.push(home);
  const project = path.join(home, "project");
  const root = path.join(home, "library");
  const target = path.join(personal ? home : project, ".claude", "skills", "reviewer");
  await mkdir(target, { recursive: true });
  await mkdir(path.join(project, ".git"), { recursive: true });
  const text = (body: string) => `---\nname: reviewer\ndescription: Review changes\n---\n${body}\n`;
  await writeFile(path.join(target, "SKILL.md"), text("accepted original"));
  const workspaces = [{ id: "project", path: project }];
  const skills = new Skills(
    { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
    path.join(home, "data"),
    () => workspaces,
  );
  const state = () => skills.request("skills.syncState", {}) as Promise<SkillSyncState>;
  const observation = (await state()).observations.find((item) => item.path === target)!;
  const initial = (await skills.request("skills.prepareSync", {
    operation: "adopt",
    observation_id: observation.id,
  })) as SkillSyncPreview;
  const adopted = (await skills.request("skills.applySync", {
    token: initial.token,
    confirmed: true,
    approve_home: personal,
  })) as SkillSyncReport;
  expect(adopted.results[0]).toMatchObject({ success: true });
  const libraryId = adopted.results[0].library_id!;
  const libraryFile = path.join(root, "skills", libraryId, "SKILL.md");
  return { skills, home, project, root, target, text, state, libraryId, libraryFile, workspaces };
}

async function snapshot(skills: Skills) {
  const [inventory, deployments, installed, syncState] = await Promise.all([
    skills.request("skills.inventory", {}) as Promise<SkillInventory>,
    skills.request("skills.listDeployments", {}) as Promise<SkillDeployment[]>,
    skills.request("skills.listInstalled", {}) as Promise<InstalledSkill[]>,
    skills.request("skills.syncState", {}) as Promise<SkillSyncState>,
  ]);
  return { inventory, deployments, installed, syncState };
}

async function mount(skills: Skills) {
  // Only the desktop IPC boundary is substituted; previews, tokens, receipts and writes are real.
  const prepare = vi
    .spyOn(api, "prepareSkillSync")
    .mockImplementation(
      (request) =>
        skills.request("skills.prepareSync", { ...request }) as Promise<SkillSyncPreview>,
    );
  const apply = vi.spyOn(api, "applySkillSync").mockImplementation(
    (token, approveHome) =>
      skills.request("skills.applySync", {
        token,
        confirmed: true,
        approve_home: approveHome,
      }) as Promise<SkillSyncReport>,
  );
  vi.spyOn(api, "discardSkillPreview").mockImplementation(
    (token) =>
      skills.request("skills.discardPreview", { token }) as ReturnType<
        typeof api.discardSkillPreview
      >,
  );
  vi.spyOn(api, "readSkillPreviewFile").mockImplementation(
    (token, file, targetId, itemId, comparison) =>
      skills.request("skills.readPreviewFile", {
        token,
        path: file,
        target_id: targetId,
        item_id: itemId,
        comparison,
      }) as ReturnType<typeof api.readSkillPreviewFile>,
  );
  const initial = await snapshot(skills);
  const changed = vi.fn(async (publish: (value: typeof initial) => void) => {
    publish(await snapshot(skills));
    return [];
  });
  function Flow() {
    const [data, setData] = useState(initial);
    const [request, setRequest] = useState<PrepareSkillSyncRequest>();
    return (
      <>
        <SkillUsageList
          {...data}
          workspaces={[]}
          loading={false}
          busy={false}
          onDetail={vi.fn()}
          onImport={vi.fn()}
          onAction={vi.fn()}
          onOpen={vi.fn()}
          onSync={setRequest}
        />
        {request && (
          <SkillSyncDialog
            request={request}
            state={data.syncState}
            onClose={() => setRequest(undefined)}
            onChanged={() => changed(setData)}
          />
        )}
      </>
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <Flow />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), prepare, apply, changed };
}

async function chooseUsageMenuAction(
  flow: Awaited<ReturnType<typeof mount>>,
  target: string,
  name: string,
) {
  const card = screen.getAllByTitle(target)[0].closest<HTMLDivElement>("div.rounded-xl");
  if (!card) throw new Error("Usage card missing");
  await flow.user.click(within(card).getByRole("button", { name: /^More actions/ }));
  await flow.user.click(await screen.findByRole("menuitem", { name }));
}

async function confirmOnce(flow: Awaited<ReturnType<typeof mount>>) {
  const confirm = await screen.findByRole("button", { name: tr("skills.sync.confirm") });
  await waitFor(() => expect(confirm).toBeEnabled());
  await flow.user.dblClick(confirm);
  await waitFor(() => expect(flow.apply).toHaveBeenCalledTimes(1));
  const report = (await flow.apply.mock.results[0].value) as SkillSyncReport;
  // Application admission is earlier than the UI's real post-apply reads.
  // Settle those reads before disk assertions or teardown remove the fixture.
  await waitFor(() => expect(flow.changed).toHaveBeenCalledOnce());
  await act(async () => {
    await flow.changed.mock.results[0].value;
  });
  return report;
}

describe("Skill synchronization through native usage controls", () => {
  it.each(["owner_key", "target_key"] as const)(
    "reconfirms a stale personal follow %s and persists the current identity through the real backend",
    async (key) => {
      const f = await fixture(true);
      const state = await f.state();
      const entry = state.deployments[0];
      const policy = (await f.skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
      const grant = {
        mode: "follow",
        approve_home: true,
        owner_key: entry.owner_key,
        target_key: entry.target_key,
      } as const;
      // Disabled policies may retain an old incarnation; enabling follow must reconfirm its current identity.
      await f.skills.request("skills.saveSyncPolicy", {
        policy: {
          ...policy,
          enabled: false,
          deployments: { [entry.id]: { ...grant, [key]: "previous-incarnation" } },
        },
        revision: policy.revision,
        approve_home: false,
      });
      vi.spyOn(api, "skillSyncPolicy").mockImplementation(
        () => f.skills.request("skills.syncPolicy", {}) as Promise<SkillSyncPolicy>,
      );
      const save = vi
        .spyOn(api, "saveSkillSyncPolicy")
        .mockImplementation(
          (request) =>
            f.skills.request("skills.saveSyncPolicy", { ...request }) as Promise<SkillSyncPolicy>,
        );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const onClose = vi.fn();
      render(
        <QueryClientProvider client={client}>
          <SkillSyncPolicyDialog state={state} onClose={onClose} onChanged={async () => []} />
        </QueryClientProvider>,
      );
      const user = userEvent.setup();
      await user.click(await screen.findByRole("checkbox", { name: tr("skills.sync.enabled") }));
      const approval = screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") });
      expect(approval).not.toBeChecked();
      expect(screen.getByRole("button", { name: tr("common.save") })).toBeDisabled();
      expect(save).not.toHaveBeenCalled();
      await user.click(approval);
      await user.click(screen.getByRole("button", { name: tr("common.save") }));
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          approve_home: true,
          policy: expect.objectContaining({ enabled: true, deployments: { [entry.id]: grant } }),
        }),
      );
      const saved = (await f.skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
      expect(saved.deployments[entry.id]).toEqual(grant);
      expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(
        f.text("accepted original"),
      );
    },
  );
  it.each(["manual", "pinned"] as const)(
    "saves a persistent personal follow policy after a %s round trip through the real backend",
    async (mode) => {
      const f = await fixture(true);
      const state = await f.state();
      const entry = state.deployments[0];
      expect(entry.scope).toBe("personal");
      const policy = (await f.skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
      const grant = {
        mode: "follow",
        approve_home: true,
        owner_key: entry.owner_key,
        target_key: entry.target_key,
      } as const;
      await f.skills.request("skills.saveSyncPolicy", {
        policy: { ...policy, deployments: { [entry.id]: grant } },
        revision: policy.revision,
        approve_home: true,
      });
      vi.spyOn(api, "skillSyncPolicy").mockImplementation(
        () => f.skills.request("skills.syncPolicy", {}) as Promise<SkillSyncPolicy>,
      );
      const save = vi
        .spyOn(api, "saveSkillSyncPolicy")
        .mockImplementation(
          (request) =>
            f.skills.request("skills.saveSyncPolicy", { ...request }) as Promise<SkillSyncPolicy>,
        );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const onClose = vi.fn();
      render(
        <QueryClientProvider client={client}>
          <SkillSyncPolicyDialog state={state} onClose={onClose} onChanged={async () => []} />
        </QueryClientProvider>,
      );
      const user = userEvent.setup();
      const chooser = await screen.findByRole("combobox", {
        name: `${tr("skills.sync.deploymentMode")} · ${entry.target}`,
      });
      for (const next of [mode, "follow"] as const) {
        await user.click(chooser);
        await user.click(
          await screen.findByRole("option", { name: tr(`skills.sync.mode.${next}`) }),
        );
      }
      expect(
        screen.queryByRole("checkbox", { name: tr("skills.sync.homeGrant") }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: tr("common.save") }));
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          approve_home: false,
          policy: expect.objectContaining({ deployments: { [entry.id]: grant } }),
        }),
      );
      const saved = (await f.skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
      expect(saved.deployments[entry.id]).toEqual(grant);
      expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(
        f.text("accepted original"),
      );
    },
  );
  it("adopts another installed location into the selected existing library without forking", async () => {
    const f = await fixture();
    const second = path.join(f.project, ".cursor", "skills", "reviewer");
    await mkdir(second, { recursive: true });
    await writeFile(path.join(second, "SKILL.md"), f.text("accepted original"));
    const flow = await mount(f.skills);
    await chooseUsageMenuAction(flow, second, tr("skills.sync.operation.adopt"));
    const chooser = await screen.findByRole("combobox", { name: tr("skills.sync.adoptLibrary") });
    await flow.user.click(chooser);
    await flow.user.click(await screen.findByRole("option", { name: `reviewer · ${f.libraryId}` }));
    await waitFor(() =>
      expect(flow.prepare).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: "adopt", library_id: f.libraryId }),
      ),
    );
    const report = await confirmOnce(flow);
    expect(report.results[0]).toMatchObject({ success: true, library_id: f.libraryId });
    const state = await f.state();
    expect(state.library).toHaveLength(1);
    expect(state.deployments).toHaveLength(2);
    expect(state.deployments.every((item) => item.library_id === f.libraryId)).toBe(true);
    expect(state.deployments.every((item) => item.sync_state === "current")).toBe(true);
    expect(await readFile(path.join(second, "SKILL.md"), "utf8")).toBe(f.text("accepted original"));
    expect(await readFile(f.libraryFile, "utf8")).toBe(f.text("accepted original"));
  });

  it.each(["library", "deployment"] as const)(
    "requires an explicit %s winner when adopting into a library with different contents",
    async (resolution) => {
      const f = await fixture();
      const second = path.join(f.project, ".cursor", "skills", "reviewer");
      await mkdir(second, { recursive: true });
      await writeFile(path.join(second, "SKILL.md"), f.text("second native version"));
      const flow = await mount(f.skills);
      await chooseUsageMenuAction(flow, second, tr("skills.sync.operation.adopt"));
      await flow.user.click(
        await screen.findByRole("combobox", { name: tr("skills.sync.adoptLibrary") }),
      );
      await flow.user.click(
        await screen.findByRole("option", { name: `reviewer · ${f.libraryId}` }),
      );
      const winner = await screen.findByRole("button", {
        name: tr(resolution === "library" ? "skills.sync.useLibrary" : "skills.sync.useDeployment"),
      });
      expect(screen.getByRole("button", { name: tr("skills.sync.confirm") })).toBeDisabled();
      expect(flow.apply).not.toHaveBeenCalled();
      await flow.user.click(winner);
      await waitFor(() =>
        expect(flow.prepare).toHaveBeenLastCalledWith(
          expect.objectContaining({ library_id: f.libraryId, resolution }),
        ),
      );
      const reviewed = (await flow.prepare.mock.results.at(-1)!.value) as SkillSyncPreview;
      expect(reviewed.targets[0].modified).toContain("SKILL.md");
      expect(
        await screen.findByText(
          tr(
            resolution === "deployment"
              ? "skills.sync.adoptUpdatesLibrary"
              : "skills.sync.adoptUpdatesInstallation",
            { library: f.libraryId },
          ),
        ),
      ).toBeInTheDocument();
      await flow.user.click(await screen.findByRole("button", { name: "SKILL.md" }));
      await flow.user.click(await screen.findByRole("tab", { name: tr("skills.manager.diff") }));
      const diff = await screen.findByLabelText(tr("skills.manager.diff"), { selector: "pre" });
      expect(within(diff).getByText(/accepted original/)).toBeInTheDocument();
      expect(within(diff).getByText(/second native version/)).toBeInTheDocument();
      expect(flow.apply).not.toHaveBeenCalled();
      const report = await confirmOnce(flow);
      expect(report.results[0]).toMatchObject({ success: true, library_id: f.libraryId });
      const expected = f.text(
        resolution === "library" ? "accepted original" : "second native version",
      );
      expect(await readFile(path.join(second, "SKILL.md"), "utf8")).toBe(expected);
      expect(await readFile(f.libraryFile, "utf8")).toBe(expected);
      expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(
        f.text("accepted original"),
      );
      const state = await f.state();
      expect(state.library).toHaveLength(1);
      expect(state.deployments.find((item) => item.target === second)?.sync_state).toBe("current");
    },
  );

  it("overwrites an incoming deployment with its original library after explicit review", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "SKILL.md"), f.text("unwanted native edit"));
    expect((await f.state()).deployments[0].sync_state).toBe("incoming");
    const flow = await mount(f.skills);
    await chooseUsageMenuAction(flow, f.target, tr("skills.sync.useLibrary"));
    const report = await confirmOnce(flow);
    expect(flow.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "push", resolution: "library" }),
    );
    expect(report.results[0]).toMatchObject({ success: true, library_id: f.libraryId });
    expect(await readFile(f.libraryFile, "utf8")).toBe(f.text("accepted original"));
    expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(
      f.text("accepted original"),
    );
    expect((await f.state()).deployments[0].sync_state).toBe("current");
  });

  it("accepts a valid local library edit and synchronizes the existing deployment", async () => {
    const f = await fixture();
    await writeFile(f.libraryFile, f.text("intentionally edited library"));
    expect((await f.state()).deployments[0].sync_state).toBe("blocked");
    const flow = await mount(f.skills);
    await flow.user.click(screen.getByRole("button", { name: tr("skills.sync.acceptLibrary") }));
    const report = await confirmOnce(flow);
    expect(report.results[0]).toMatchObject({ success: true, library_id: f.libraryId });
    expect(await readFile(f.libraryFile, "utf8")).toBe(f.text("intentionally edited library"));
    expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(
      f.text("intentionally edited library"),
    );
    const state = await f.state();
    expect(state.library).toHaveLength(1);
    expect(state.library[0].observed_hash).toBe(state.library[0].hash);
    expect(state.deployments[0].sync_state).toBe("current");
  });

  it.each(["library", "deployment", "workspace"] as const)(
    "rejects a reviewed synchronization after %s changes without overwriting either copy",
    async (changed) => {
      const f = await fixture();
      await writeFile(path.join(f.target, "SKILL.md"), f.text("unwanted native edit"));
      const flow = await mount(f.skills);
      await chooseUsageMenuAction(flow, f.target, tr("skills.sync.useLibrary"));
      const confirm = await screen.findByRole("button", { name: tr("skills.sync.confirm") });
      await waitFor(() => expect(confirm).toBeEnabled());
      if (changed === "library") await writeFile(f.libraryFile, f.text("external library change"));
      if (changed === "deployment")
        await writeFile(path.join(f.target, "SKILL.md"), f.text("external native change"));
      if (changed === "workspace") {
        const other = path.join(f.home, "other-project");
        await mkdir(other);
        await mkdir(path.join(other, ".git"));
        f.workspaces[0] = { id: "project", path: other };
      }
      const libraryBefore = await readFile(f.libraryFile, "utf8");
      const nativeBefore = await readFile(path.join(f.target, "SKILL.md"), "utf8");
      const report = await confirmOnce(flow);
      expect(report.results[0]).toMatchObject({ success: false });
      expect(report.results[0].error).toBeTruthy();
      expect(await readFile(f.libraryFile, "utf8")).toBe(libraryBefore);
      expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(nativeBefore);
      expect(flow.prepare).toHaveBeenCalledTimes(1);
    },
  );
});
