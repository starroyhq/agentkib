// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type {
  PrepareSkillSyncRequest,
  SkillSyncPolicy,
  SkillSyncPreview,
  SkillSyncState,
} from "@/core/types";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { SkillSyncDialog, SkillSyncPolicyDialog, SkillSyncRunsDialog } from "./SkillSyncPanels";
import { skillKeys } from "./skills-query";

const mocks = vi.hoisted(() => ({
  prepareSkillSync: vi.fn(),
  applySkillSync: vi.fn(),
  discardSkillPreview: vi.fn(),
  readSkillPreviewFile: vi.fn(),
  skillSyncPolicy: vi.fn(),
  saveSkillSyncPolicy: vi.fn(),
  skillSyncRuns: vi.fn(),
  recoverSkillSync: vi.fn(),
}));
vi.mock("@/core/api", () => ({ api: mocks }));
const preview: SkillSyncPreview = {
  token: "reviewed",
  operation: "pull",
  library_id: "reviewer",
  requires_home_approval: true,
  targets: [
    {
      target_id: "target",
      deployment_id: "deployment",
      path: "/fixture/skills/reviewer",
      base_hash: "base",
      library_hash: "base",
      target_hash: "edited",
      state: "incoming",
      added: ["SKILL.md"],
      modified: [],
      removed: [],
      conflicts: [],
    },
  ],
  expires_at: "2030-01-01T00:00:00Z",
};
const policy: SkillSyncPolicy = {
  schema_version: 1,
  revision: 2,
  enabled: true,
  interval_hours: 24,
  default_mode: "check",
  libraries: {},
  deployments: {},
  updated_at: null,
};
const state: SkillSyncState = {
  library: [],
  observations: [],
  warnings: [],
  deployments: [
    {
      id: "deployment",
      library_id: "reviewer",
      package_name: "reviewer",
      target: "/fixture/personal/skills/reviewer",
      scope: "personal",
      status: "active",
      base_hash: "base",
      library_hash: "base",
      target_hash: "base",
      sync_state: "current",
      owner_key: "owner",
      target_key: "target",
      baseline_available: true,
      diagnostics: [],
      policy: null,
    },
  ],
};
const libraryState: SkillSyncState = {
  ...state,
  library: ["stable-a", "stable-b"].map((library_id) => ({
    library_id,
    display_name: "Same display name",
    hash: "library",
    observed_hash: "library",
    upstream_base_hash: null,
    locally_customized: false,
    owner_key: `owner-${library_id}`,
    source_key: "source",
    valid: true,
    can_auto_update: false,
    diagnostics: [],
    policy: null,
  })),
};
function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>), client };
}
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  mocks.prepareSkillSync.mockResolvedValue(preview);
  mocks.discardSkillPreview.mockResolvedValue(undefined);
  mocks.readSkillPreviewFile.mockResolvedValue({
    path: "SKILL.md",
    before: "before",
    after: "after",
    binary: false,
    truncated: false,
  });
  mocks.applySkillSync.mockResolvedValue({
    operation_id: "run",
    results: [{ success: true, status: "applied", library_id: "reviewer" }],
    warnings: [],
  });
  mocks.skillSyncPolicy.mockResolvedValue(policy);
  mocks.saveSkillSyncPolicy.mockImplementation(async ({ policy }) => ({ ...policy, revision: 3 }));
});
afterEach(async () => {
  cleanup();
  vi.resetAllMocks();
  await changeLocale("en-US");
});

describe("Skill synchronization controls", () => {
  it("adopts independently by default and selects existing packages by stable identity", async () => {
    const user = userEvent.setup();
    mount(
      <SkillSyncDialog
        request={{ operation: "adopt", observation_id: "native-copy" }}
        state={libraryState}
        onClose={vi.fn()}
        onChanged={async () => []}
      />,
    );
    await screen.findByText("/fixture/skills/reviewer");
    expect(mocks.prepareSkillSync).toHaveBeenLastCalledWith({
      operation: "adopt",
      observation_id: "native-copy",
    });
    await user.click(screen.getByRole("checkbox", { name: tr("skills.manager.approveHome") }));
    await user.click(screen.getByRole("combobox", { name: tr("skills.sync.adoptLibrary") }));
    await user.click(await screen.findByRole("option", { name: "Same display name · stable-b" }));
    await waitFor(() =>
      expect(mocks.prepareSkillSync).toHaveBeenLastCalledWith({
        operation: "adopt",
        observation_id: "native-copy",
        library_id: "stable-b",
      }),
    );
    expect(
      screen.getByRole("checkbox", { name: tr("skills.manager.approveHome") }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: tr("skills.sync.confirm") })).toBeDisabled();
    expect(mocks.discardSkillPreview).toHaveBeenCalledWith("reviewed");
    expect(mocks.applySkillSync).not.toHaveBeenCalled();
  });
  it.each(["library", "deployment"] as const)(
    "requires a new reviewed token for adopt using the %s version",
    async (resolution) => {
      const user = userEvent.setup();
      mocks.prepareSkillSync.mockImplementation(async (input: PrepareSkillSyncRequest) => ({
        ...preview,
        operation: "adopt",
        token: input.resolution ? `resolved-${input.resolution}` : "unresolved",
        targets: [
          {
            ...preview.targets[0],
            conflicts: input.library_id && !input.resolution ? ["Choose the initial version"] : [],
          },
        ],
      }));
      mount(
        <SkillSyncDialog
          request={{ operation: "adopt", observation_id: "native-copy" }}
          state={libraryState}
          onClose={vi.fn()}
          onChanged={async () => []}
        />,
      );
      await user.click(
        await screen.findByRole("combobox", { name: tr("skills.sync.adoptLibrary") }),
      );
      await user.click(await screen.findByRole("option", { name: "Same display name · stable-a" }));
      await screen.findByText("Choose the initial version");
      expect(screen.getByRole("button", { name: tr("skills.sync.confirm") })).toBeDisabled();
      await user.click(screen.getByRole("checkbox", { name: tr("skills.manager.approveHome") }));
      await user.click(
        screen.getByRole("button", {
          name: tr(
            resolution === "library" ? "skills.sync.useLibrary" : "skills.sync.useDeployment",
          ),
        }),
      );
      await waitFor(() =>
        expect(mocks.prepareSkillSync).toHaveBeenLastCalledWith({
          operation: "adopt",
          observation_id: "native-copy",
          library_id: "stable-a",
          resolution,
        }),
      );
      expect(
        screen.getByRole("checkbox", { name: tr("skills.manager.approveHome") }),
      ).not.toBeChecked();
      expect(screen.getByRole("button", { name: tr("skills.sync.confirm") })).toBeDisabled();
      await user.click(screen.getByRole("checkbox", { name: tr("skills.manager.approveHome") }));
      await user.click(screen.getByRole("button", { name: tr("skills.sync.confirm") }));
      expect(mocks.applySkillSync).toHaveBeenCalledExactlyOnceWith(`resolved-${resolution}`, true);
    },
  );
  it("clears a previous version choice when switching libraries or returning to an independent Skill", async () => {
    const user = userEvent.setup();
    mount(
      <SkillSyncDialog
        request={{
          operation: "adopt",
          observation_id: "native-copy",
          library_id: "stable-a",
          resolution: "library",
        }}
        state={libraryState}
        onClose={vi.fn()}
        onChanged={async () => []}
      />,
    );
    await screen.findByText("/fixture/skills/reviewer");
    await user.click(screen.getByRole("combobox", { name: tr("skills.sync.adoptLibrary") }));
    await user.click(await screen.findByRole("option", { name: "Same display name · stable-b" }));
    await waitFor(() =>
      expect(mocks.prepareSkillSync).toHaveBeenLastCalledWith({
        operation: "adopt",
        observation_id: "native-copy",
        library_id: "stable-b",
      }),
    );
    await user.click(screen.getByRole("combobox", { name: tr("skills.sync.adoptLibrary") }));
    await user.click(await screen.findByRole("option", { name: tr("skills.sync.newLibrary") }));
    await waitFor(() =>
      expect(mocks.prepareSkillSync).toHaveBeenLastCalledWith({
        operation: "adopt",
        observation_id: "native-copy",
      }),
    );
  });
  it("discards a previous library preview that resolves after choosing another library", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: SkillSyncPreview) => void;
    mocks.prepareSkillSync.mockImplementation((input: PrepareSkillSyncRequest) =>
      input.library_id === "stable-a"
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve({
            ...preview,
            token: input.library_id === "stable-b" ? "current-b" : "independent",
          }),
    );
    mount(
      <SkillSyncDialog
        request={{ operation: "adopt", observation_id: "native-copy" }}
        state={libraryState}
        onClose={vi.fn()}
        onChanged={async () => []}
      />,
    );
    await screen.findByText("/fixture/skills/reviewer");
    await user.click(screen.getByRole("combobox", { name: tr("skills.sync.adoptLibrary") }));
    await user.click(await screen.findByRole("option", { name: "Same display name · stable-a" }));
    await waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
    await user.click(screen.getByRole("combobox", { name: tr("skills.sync.adoptLibrary") }));
    await user.click(await screen.findByRole("option", { name: "Same display name · stable-b" }));
    await screen.findByText("/fixture/skills/reviewer");
    await act(async () => resolveFirst({ ...preview, token: "late-a" }));
    expect(mocks.discardSkillPreview).toHaveBeenCalledWith("late-a");
    await user.click(screen.getByRole("checkbox", { name: tr("skills.manager.approveHome") }));
    await user.click(screen.getByRole("button", { name: tr("skills.sync.confirm") }));
    expect(mocks.applySkillSync).toHaveBeenCalledExactlyOnceWith("current-b", true);
  });
  it("reads each accepted-baseline comparison through the frozen synchronization token", async () => {
    const user = userEvent.setup();
    mocks.prepareSkillSync.mockResolvedValue({
      ...preview,
      targets: [
        {
          ...preview.targets[0],
          base_library: { added: ["library.md"], modified: [], removed: [] },
          base_target: { added: ["target.md"], modified: [], removed: [] },
        },
      ],
    });
    mount(
      <SkillSyncDialog
        request={{ operation: "pull", deployment_id: "deployment" }}
        onClose={vi.fn()}
        onChanged={async () => []}
      />,
    );
    await user.click(
      await screen.findByRole("tab", { name: tr("skills.sync.comparison.base-library") }),
    );
    await waitFor(() =>
      expect(mocks.readSkillPreviewFile).toHaveBeenCalledWith(
        "reviewed",
        "library.md",
        "target",
        undefined,
        "base-library",
      ),
    );
    await user.click(screen.getByRole("tab", { name: tr("skills.sync.comparison.base-target") }));
    await waitFor(() =>
      expect(mocks.readSkillPreviewFile).toHaveBeenCalledWith(
        "reviewed",
        "target.md",
        "target",
        undefined,
        "base-target",
      ),
    );
  });
  it("keeps the revision of an edited policy when a background refresh replaces cached data", async () => {
    const user = userEvent.setup();
    const { client } = mount(
      <SkillSyncPolicyDialog state={state} onClose={vi.fn()} onChanged={async () => []} />,
    );
    await user.click(await screen.findByRole("combobox", { name: tr("skills.sync.interval") }));
    await user.click(await screen.findByRole("option", { name: "6 h" }));
    act(() => client.setQueryData(skillKeys.policy(), { ...policy, revision: 3 }));
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    await waitFor(() =>
      expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          revision: 2,
          policy: expect.objectContaining({ revision: 2, interval_hours: 6 }),
        }),
      ),
    );
  });
  it("discards a prepared snapshot that arrives after closing the dialog", async () => {
    let complete!: (value: SkillSyncPreview) => void;
    mocks.prepareSkillSync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { unmount } = mount(
      <SkillSyncDialog
        request={{ operation: "pull", deployment_id: "deployment" }}
        onClose={vi.fn()}
        onChanged={async () => []}
      />,
    );
    await waitFor(() => expect(mocks.prepareSkillSync).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      complete(preview);
    });
    expect(mocks.discardSkillPreview).toHaveBeenCalledWith("reviewed");
  });
  it("requires scoped personal approval and preserves successful results when refresh fails", async () => {
    const user = userEvent.setup();
    mount(
      <SkillSyncDialog
        request={{ operation: "pull", deployment_id: "deployment" }}
        onClose={vi.fn()}
        onChanged={async () => [new Error("refresh failed")]}
      />,
    );
    await screen.findByText("/fixture/skills/reviewer");
    expect(screen.getByRole("button", { name: tr("skills.sync.confirm") })).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: tr("skills.sync.confirm") }));
    await waitFor(() => expect(mocks.applySkillSync).toHaveBeenCalledWith("reviewed", true));
    expect(await screen.findByText(tr("skills.sync.result.applied"))).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("refresh failed");
    expect(mocks.readSkillPreviewFile).toHaveBeenCalledWith("reviewed", "SKILL.md", "target");
  });
  it("re-prepares explicit whole-package conflict resolution and applies only its new token", async () => {
    const user = userEvent.setup();
    mocks.prepareSkillSync.mockResolvedValueOnce({
      ...preview,
      requires_home_approval: false,
      targets: [{ ...preview.targets[0], state: "conflict", conflicts: ["Both copies changed"] }],
    });
    mocks.prepareSkillSync.mockResolvedValue({
      ...preview,
      token: "resolved",
      requires_home_approval: false,
    });
    mount(
      <SkillSyncDialog
        request={{ operation: "push", deployment_id: "deployment" }}
        onClose={vi.fn()}
        onChanged={async () => []}
      />,
    );
    await screen.findByText("Both copies changed");
    expect(screen.getByRole("button", { name: tr("skills.sync.confirm") })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: tr("skills.sync.useLibrary") }));
    await waitFor(() =>
      expect(mocks.prepareSkillSync).toHaveBeenLastCalledWith({
        operation: "push",
        deployment_id: "deployment",
        resolution: "library",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: tr("skills.sync.confirm") })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: tr("skills.sync.confirm") }));
    expect(mocks.applySkillSync).toHaveBeenCalledWith("resolved", false);
    expect(mocks.discardSkillPreview).toHaveBeenCalledWith("reviewed");
  });
  it("binds a new personal follow grant to backend identities and explicit approval", async () => {
    const user = userEvent.setup();
    mount(<SkillSyncPolicyDialog state={state} onClose={vi.fn()} onChanged={async () => []} />);
    const mode = await screen.findByRole("combobox", {
      name: `${tr("skills.sync.deploymentMode")} · ${state.deployments[0].target}`,
    });
    await user.click(mode);
    await user.click(await screen.findByRole("option", { name: tr("skills.sync.mode.follow") }));
    expect(screen.getByRole("button", { name: tr("common.save") })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    await waitFor(() =>
      expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          revision: 2,
          approve_home: true,
          policy: expect.objectContaining({
            deployments: {
              deployment: {
                mode: "follow",
                approve_home: true,
                owner_key: "owner",
                target_key: "target",
              },
            },
          }),
        }),
      ),
    );
  });
  it("reuses an existing scoped personal grant without asking for approval again", async () => {
    mocks.skillSyncPolicy.mockResolvedValue({
      ...policy,
      deployments: {
        deployment: {
          mode: "follow",
          approve_home: true,
          owner_key: "owner",
          target_key: "target",
        },
      },
    });
    const user = userEvent.setup();
    mount(<SkillSyncPolicyDialog state={state} onClose={vi.fn()} onChanged={async () => []} />);
    await screen.findByRole("combobox", { name: tr("skills.sync.interval") });
    expect(
      screen.queryByRole("checkbox", { name: tr("skills.sync.homeGrant") }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    await waitFor(() =>
      expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ approve_home: false }),
      ),
    );
  });
  it.each(["manual", "pinned"] as const)(
    "preserves a persistent personal follow grant after choosing %s and returning to follow",
    async (mode) => {
      const grant = {
        mode: "follow",
        approve_home: true,
        owner_key: "owner",
        target_key: "target",
      } as const;
      mocks.skillSyncPolicy.mockResolvedValue({ ...policy, deployments: { deployment: grant } });
      const user = userEvent.setup();
      mount(<SkillSyncPolicyDialog state={state} onClose={vi.fn()} onChanged={async () => []} />);
      const chooser = await screen.findByRole("combobox", {
        name: `${tr("skills.sync.deploymentMode")} · ${state.deployments[0].target}`,
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
      expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          approve_home: false,
          policy: expect.objectContaining({ deployments: { deployment: grant } }),
        }),
      );
    },
  );
  it("keeps persistent grants while renewing approval for a changed set of personal targets", async () => {
    const grant = {
      mode: "follow",
      approve_home: true,
      owner_key: "owner",
      target_key: "target",
    } as const;
    mocks.skillSyncPolicy.mockResolvedValue({ ...policy, deployments: { deployment: grant } });
    const extra = ["second", "third"].map((id) => ({
      ...state.deployments[0],
      id,
      target: `/fixture/personal/${id}`,
      owner_key: `owner-${id}`,
      target_key: `target-${id}`,
    }));
    const user = userEvent.setup();
    mount(
      <SkillSyncPolicyDialog
        state={{ ...state, deployments: [...state.deployments, ...extra] }}
        onClose={vi.fn()}
        onChanged={async () => []}
      />,
    );
    const choose = async (target: string) => {
      await user.click(
        await screen.findByRole("combobox", {
          name: `${tr("skills.sync.deploymentMode")} · ${target}`,
        }),
      );
      await user.click(await screen.findByRole("option", { name: tr("skills.sync.mode.follow") }));
    };
    await choose(extra[0].target);
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    await choose(extra[1].target);
    expect(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") })).not.toBeChecked();
    expect(screen.getByRole("button", { name: tr("common.save") })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    expect(screen.getByRole("button", { name: tr("common.save") })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        approve_home: true,
        policy: expect.objectContaining({
          deployments: {
            deployment: grant,
            ...Object.fromEntries(
              extra.map((entry) => [
                entry.id,
                {
                  mode: "follow",
                  approve_home: true,
                  owner_key: entry.owner_key,
                  target_key: entry.target_key,
                },
              ]),
            ),
          },
        }),
      }),
    );
  });
  it("keeps a persistent grant when another personal follow choice is abandoned", async () => {
    const grant = {
      mode: "follow",
      approve_home: true,
      owner_key: "owner",
      target_key: "target",
    } as const;
    mocks.skillSyncPolicy.mockResolvedValue({ ...policy, deployments: { deployment: grant } });
    const entry = {
      ...state.deployments[0],
      id: "second",
      target: "/fixture/personal/second",
      owner_key: "owner-second",
      target_key: "target-second",
    };
    const user = userEvent.setup();
    mount(
      <SkillSyncPolicyDialog
        state={{ ...state, deployments: [...state.deployments, entry] }}
        onClose={vi.fn()}
        onChanged={async () => []}
      />,
    );
    const chooser = await screen.findByRole("combobox", {
      name: `${tr("skills.sync.deploymentMode")} · ${entry.target}`,
    });
    await user.click(chooser);
    await user.click(await screen.findByRole("option", { name: tr("skills.sync.mode.follow") }));
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    await user.click(chooser);
    await user.click(await screen.findByRole("option", { name: tr("skills.sync.mode.manual") }));
    expect(
      screen.queryByRole("checkbox", { name: tr("skills.sync.homeGrant") }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        approve_home: false,
        policy: expect.objectContaining({
          deployments: {
            deployment: grant,
            second: {
              mode: "manual",
              approve_home: false,
              owner_key: entry.owner_key,
              target_key: entry.target_key,
            },
          },
        }),
      }),
    );
  });
  it.each(["owner_key", "target_key"] as const)(
    "does not reuse a persistent personal grant after %s changes",
    async (key) => {
      mocks.skillSyncPolicy.mockResolvedValue({
        ...policy,
        deployments: {
          deployment: {
            mode: "follow",
            approve_home: true,
            owner_key: "owner",
            target_key: "target",
          },
        },
      });
      const entry = { ...state.deployments[0], [key]: "changed-identity" };
      const user = userEvent.setup();
      mount(
        <SkillSyncPolicyDialog
          state={{ ...state, deployments: [entry] }}
          onClose={vi.fn()}
          onChanged={async () => []}
        />,
      );
      const chooser = await screen.findByRole("combobox", {
        name: `${tr("skills.sync.deploymentMode")} · ${entry.target}`,
      });
      for (const mode of ["manual", "follow"] as const) {
        await user.click(chooser);
        await user.click(
          await screen.findByRole("option", { name: tr(`skills.sync.mode.${mode}`) }),
        );
      }
      expect(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") })).not.toBeChecked();
      expect(screen.getByRole("button", { name: tr("common.save") })).toBeDisabled();
      await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
      await user.click(screen.getByRole("button", { name: tr("common.save") }));
      expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          approve_home: true,
          policy: expect.objectContaining({
            deployments: {
              deployment: {
                mode: "follow",
                approve_home: true,
                owner_key: entry.owner_key,
                target_key: entry.target_key,
              },
            },
          }),
        }),
      );
    },
  );
  it("invalidates temporary personal approval when a refreshed target identity changes", async () => {
    const user = userEvent.setup();
    const mounted = mount(
      <SkillSyncPolicyDialog state={state} onClose={vi.fn()} onChanged={async () => []} />,
    );
    const label = `${tr("skills.sync.deploymentMode")} · ${state.deployments[0].target}`;
    await user.click(await screen.findByRole("combobox", { name: label }));
    await user.click(await screen.findByRole("option", { name: tr("skills.sync.mode.follow") }));
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    mounted.rerender(
      <QueryClientProvider client={mounted.client}>
        <SkillSyncPolicyDialog
          state={{
            ...state,
            deployments: [{ ...state.deployments[0], target_key: "replaced-target" }],
          }}
          onClose={vi.fn()}
          onChanged={async () => []}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") })).not.toBeChecked();
    expect(screen.getByRole("button", { name: tr("common.save") })).toBeDisabled();
    expect(mocks.saveSkillSyncPolicy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    mounted.rerender(
      <QueryClientProvider client={mounted.client}>
        <SkillSyncPolicyDialog
          state={{
            ...state,
            deployments: [{ ...state.deployments[0], target_key: "latest-target" }],
          }}
          onClose={vi.fn()}
          onChanged={async () => []}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") })).not.toBeChecked();
    expect(screen.getByRole("button", { name: tr("common.save") })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: tr("skills.sync.homeGrant") }));
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        approve_home: true,
        policy: expect.objectContaining({
          deployments: {
            deployment: {
              mode: "follow",
              approve_home: true,
              owner_key: "owner",
              target_key: "latest-target",
            },
          },
        }),
      }),
    );
  });
  it.each(["owner_key", "target_key"] as const)(
    "binds a renewed personal approval to the latest %s without changing the selected mode",
    async (key) => {
      mocks.skillSyncPolicy.mockResolvedValue({
        ...policy,
        deployments: {
          deployment: {
            mode: "follow",
            approve_home: true,
            owner_key: "owner",
            target_key: "target",
          },
          manual: {
            mode: "manual",
            approve_home: false,
            owner_key: "old-manual-owner",
            target_key: "old-manual-target",
          },
        },
      });
      const entry = { ...state.deployments[0], [key]: "current-identity" };
      const manual = {
        ...state.deployments[0],
        id: "manual",
        target: "/fixture/personal/manual",
        owner_key: "new-manual-owner",
        target_key: "new-manual-target",
      };
      const user = userEvent.setup();
      mount(
        <SkillSyncPolicyDialog
          state={{ ...state, deployments: [entry, manual] }}
          onClose={vi.fn()}
          onChanged={async () => []}
        />,
      );
      const approval = await screen.findByRole("checkbox", { name: tr("skills.sync.homeGrant") });
      expect(approval).not.toBeChecked();
      expect(screen.getByRole("button", { name: tr("common.save") })).toBeDisabled();
      await user.click(approval);
      await user.click(screen.getByRole("button", { name: tr("common.save") }));
      expect(mocks.saveSkillSyncPolicy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          approve_home: true,
          policy: expect.objectContaining({
            deployments: {
              deployment: {
                mode: "follow",
                approve_home: true,
                owner_key: entry.owner_key,
                target_key: entry.target_key,
              },
              manual: {
                mode: "manual",
                approve_home: false,
                owner_key: "old-manual-owner",
                target_key: "old-manual-target",
              },
            },
          }),
        }),
      );
    },
  );
  it("recovers only saved interrupted operations and reports per-item errors", async () => {
    mocks.skillSyncRuns.mockResolvedValue({
      runs: [
        {
          operation_id: "saved",
          started_at: "2026-10-15T00:00:00Z",
          finished_at: null,
          trigger: "manual",
          results: [{ success: false, status: "recovery-required", path: "/fixture/reviewer" }],
          warnings: [],
        },
      ],
    });
    mocks.recoverSkillSync.mockResolvedValue({
      operation_id: "saved",
      results: [{ success: false, status: "blocked", error: "location changed" }],
      warnings: [],
    });
    const user = userEvent.setup();
    mount(<SkillSyncRunsDialog onClose={vi.fn()} onChanged={async () => []} />);
    await user.click(
      await screen.findByRole("button", { name: tr("skills.manager.operation.recover") }),
    );
    await waitFor(() => expect(mocks.recoverSkillSync).toHaveBeenCalledWith("saved", false));
    expect(await screen.findByRole("alert")).toHaveTextContent("location changed");
  });
});

describe("Skill conflict review hierarchy", () => {
  it.each(
    (
      [
        ["en-US", "Review conflicting versions"],
        ["zh-CN", "比较冲突版本"],
        ["zh-Hant", "比較衝突版本"],
        ["ja-JP", "競合するバージョンを比較"],
      ] as const
    ).flatMap(([locale, title]) =>
      (["library", "deployment"] as const).map((resolution) => ({ locale, title, resolution })),
    ),
  )(
    "requires an explicit $resolution choice before applying the reviewed token in $locale",
    async ({ locale, title, resolution }) => {
      await changeLocale(locale);
      mocks.prepareSkillSync.mockImplementation(async (input: PrepareSkillSyncRequest) => ({
        ...preview,
        token: input.resolution ? `chosen-${input.resolution}` : "unresolved-conflict",
        operation: input.operation,
        requires_home_approval: false,
        targets: [
          {
            ...preview.targets[0],
            state: input.resolution ? "current" : "conflict",
            conflicts: input.resolution ? [] : ["Both copies changed"],
          },
        ],
      }));
      mount(
        <SkillSyncDialog
          request={{ operation: "push", deployment_id: "deployment" }}
          state={{ ...state, deployments: [{ ...state.deployments[0], sync_state: "conflict" }] }}
          onClose={vi.fn()}
          onChanged={async () => []}
        />,
      );
      await screen.findByText("Both copies changed");
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      expect(screen.getByText(new RegExp(tr("skills.sync.conflictDescription")))).toBeVisible();
      expect(mocks.prepareSkillSync).toHaveBeenCalledExactlyOnceWith({
        operation: "push",
        deployment_id: "deployment",
      });
      const confirm = screen.getByRole("button", { name: tr("skills.sync.confirm") });
      expect(confirm).toBeDisabled();
      expect(mocks.applySkillSync).not.toHaveBeenCalled();
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", {
          name: tr(
            resolution === "library" ? "skills.sync.useLibrary" : "skills.sync.useDeployment",
          ),
        }),
      );
      await waitFor(() =>
        expect(mocks.prepareSkillSync).toHaveBeenLastCalledWith({
          operation: resolution === "library" ? "push" : "pull",
          deployment_id: "deployment",
          resolution,
        }),
      );
      await waitFor(() => expect(confirm).toBeEnabled());
      await user.click(confirm);
      await waitFor(() =>
        expect(mocks.applySkillSync).toHaveBeenCalledExactlyOnceWith(`chosen-${resolution}`, false),
      );
      expect(mocks.discardSkillPreview).toHaveBeenCalledWith("unresolved-conflict");
    },
  );
});
