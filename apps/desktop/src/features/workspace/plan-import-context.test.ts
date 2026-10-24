import { describe, expect, it, vi } from "vitest";
import type { ChangeSet, ContextPreview, FileChange } from "@/core/types";
import { planLiteralImportWarning } from "./plan-import-context";

const root = "/sandbox/project";
const literal =
  "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import";
const file = (name: string, before: string, after: string): FileChange => ({
  target: `${root}/${name}`,
  scope: "project",
  before,
  after,
  risk: "medium",
  validator: "markdown",
});
const plan = (...changes: FileChange[]): ChangeSet => ({
  id: "plan",
  project_root: root,
  created_at: "",
  changes,
  requires_home_approval: false,
});
const imported = file("CLAUDE.md", "old", "@AGENTS.md\n");
const section = (source: string, content: string, precedence = 0, scope = "") => ({
  source,
  content,
  precedence,
  scope,
});
const preview = (changes: Partial<ContextPreview> = {}): ContextPreview => ({
  agent: "deepseek-harness",
  project: root,
  cwd: root,
  sections: [
    section(`${root}/AGENTS.md`, "Shared rules\n"),
    section(`${root}/CLAUDE.md`, "old", 1),
  ],
  warnings: [],
  visible_skills: [],
  visible_connections: [],
  approved_memories: [],
  ...changes,
});

describe("planned literal-import context", () => {
  it.each([
    { changes: [] },
    { changes: [file("CLAUDE.md", "", "An example of @AGENTS.md within prose")] },
    { changes: [{ ...imported, scope: "agent-home" as const }] },
  ])(
    "does not query context for a plan without a project standalone import (%s)",
    async ({ changes }) => {
      const read = vi.fn().mockRejectedValue(new Error("not needed"));
      expect(await planLiteralImportWarning(plan(...changes), read)).toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("checks actual references when only AGENTS changes, and skips warnings when none exist", async () => {
    const read = vi.fn().mockResolvedValue(preview());
    expect(
      await planLiteralImportWarning(
        plan(file("AGENTS.md", "Shared rules\n", "New rules\n")),
        read,
      ),
    ).toBe(false);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["s".repeat(70000), ""])(
    "checks an unchanged native CLAUDE import when shared instructions alone change",
    async (after) => {
      expect(
        await planLiteralImportWarning(plan(file("AGENTS.md", "Shared rules\n", after)), async () =>
          preview({
            sections: [
              section(`${root}/AGENTS.md`, "Shared rules\n"),
              section(`${root}/CLAUDE.md`, "@AGENTS.md\n", 1),
            ],
          }),
        ),
      ).toBe(true);
    },
  );

  it("keeps an unchanged native import neutral when the planned shared body remains fully readable", async () => {
    const read = vi.fn().mockResolvedValue(
      preview({
        sections: [
          section(`${root}/AGENTS.md`, "Shared rules\n"),
          section(`${root}/CLAUDE.md`, "@AGENTS.md\n", 1),
        ],
      }),
    );
    expect(
      await planLiteralImportWarning(
        plan(file("AGENTS.md", "Shared rules\n", "New rules\n")),
        read,
      ),
    ).toBe(false);
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not keep a current import warning when the reviewed CLAUDE replacement removes the reference", async () => {
    expect(
      await planLiteralImportWarning(
        plan(
          file("CLAUDE.md", "@AGENTS.md\n", "Independent instructions\n"),
          file("AGENTS.md", "Shared rules\n", ""),
        ),
        async () =>
          preview({
            sections: [
              section(`${root}/AGENTS.md`, "Shared rules\n"),
              section(`${root}/CLAUDE.md`, "@AGENTS.md\n", 1),
            ],
          }),
      ),
    ).toBe(false);
  });

  it("uses a complete unchanged AGENTS section rather than requiring it to appear in the write list", async () => {
    const read = vi.fn().mockResolvedValue(preview({ warnings: [`Note: ${literal}`] }));
    expect(await planLiteralImportWarning(plan(imported), read)).toBe(false);
    expect(read).toHaveBeenCalledOnce();
  });

  it("checks the planned replacement body against the actual earlier global byte budget", async () => {
    const read = vi.fn().mockResolvedValue(
      preview({
        sections: [
          section("/sandbox/home/.dsh/AGENTS.md", "g".repeat(65520), 0, "agent-home"),
          section(`${root}/AGENTS.md`, "old", 1),
        ],
      }),
    );
    expect(
      await planLiteralImportWarning(
        plan(imported, file("AGENTS.md", "old", "文".repeat(5))),
        read,
      ),
    ).toBe(false);
    expect(
      await planLiteralImportWarning(
        plan(imported, file("AGENTS.md", "old", "文".repeat(6))),
        read,
      ),
    ).toBe(true);
  });

  it.each([`${root}/AGENTS.md`, "/sandbox/custom-dsh/AGENTS.md"])(
    "accounts conservatively for a preceding global source that can change with project AGENTS: %s",
    async (globalSource) => {
      const actual = preview({
        sections: [
          section(globalSource, "old", 0, "agent-home"),
          section(`${root}/AGENTS.md`, "old", 1),
        ],
      });
      expect(
        await planLiteralImportWarning(
          plan(imported, file("AGENTS.md", "old", "s".repeat(40000))),
          async () => actual,
        ),
      ).toBe(true);
    },
  );

  it("does not assume a global alias to another rewritten source keeps consuming its old bytes", async () => {
    const actual = preview({
      sections: [
        section("/sandbox/custom-dsh/AGENTS.md", "old", 0, "agent-home"),
        section(`${root}/AGENTS.md`, "Shared rules\n", 1),
        section(`${root}/CLAUDE.md`, "old", 2),
      ],
    });
    const changedImport = { ...imported, after: `@AGENTS.md\n${"c".repeat(40000)}` };
    expect(
      await planLiteralImportWarning(
        plan(changedImport, file("AGENTS.md", "Shared rules\n", "s".repeat(40000))),
        async () => actual,
      ),
    ).toBe(true);
  });

  it("keeps the known global bytes when different complete contents rule out a current source alias", async () => {
    const actual = preview({
      sections: [
        section("/sandbox/custom-dsh/AGENTS.md", "g".repeat(20000), 0, "agent-home"),
        section(`${root}/AGENTS.md`, "old", 1),
      ],
    });
    expect(
      await planLiteralImportWarning(
        plan(imported, file("AGENTS.md", "old", "s".repeat(40000))),
        async () => actual,
      ),
    ).toBe(false);
  });

  it("does not prove a new AGENTS source safe when the preview cannot rule out a dangling global alias", async () => {
    expect(
      await planLiteralImportWarning(
        plan(imported, file("AGENTS.md", "", "s".repeat(40000))),
        async () => preview({ sections: [section(`${root}/CLAUDE.md`, "old")] }),
      ),
    ).toBe(true);
  });

  it("does not manufacture proof of independent reading for a new AGENTS file from a write plan", async () => {
    const read = vi.fn().mockResolvedValue(
      preview({
        sections: [
          section("/sandbox/home/.dsh/AGENTS.md", "g".repeat(65530), 0, "agent-home"),
          section(`${root}/CLAUDE.md`, "@AGENTS.md", 1),
        ],
        warnings: [literal],
      }),
    );
    expect(
      await planLiteralImportWarning(plan(imported, file("AGENTS.md", "", "123456")), read),
    ).toBe(true);
    expect(
      await planLiteralImportWarning(plan(imported, file("AGENTS.md", "", "1234567")), read),
    ).toBe(true);
  });

  it.each([
    [
      "CLAUDE-only",
      undefined,
      preview({ sections: [section(`${root}/CLAUDE.md`, "@AGENTS.md")], warnings: [literal] }),
    ],
    [
      "silently skipped existing AGENTS",
      file("AGENTS.md", "Shared rules", "Shared rules\nNew rule"),
      preview({ sections: [section(`${root}/CLAUDE.md`, "@AGENTS.md")] }),
    ],
    [
      "empty AGENTS",
      undefined,
      preview({
        sections: [section(`${root}/AGENTS.md`, ""), section(`${root}/CLAUDE.md`, "@AGENTS.md", 1)],
      }),
    ],
    ["planned empty AGENTS", file("AGENTS.md", "Shared rules\n", ""), preview()],
    [
      "AGENTS from a different directory",
      undefined,
      preview({ sections: [section(`${root}/nested/AGENTS.md`, "Shared rules")] }),
    ],
    [
      "read failure",
      file("AGENTS.md", "", "Shared rules"),
      preview({ sections: [], warnings: [`Could not read ${root}/AGENTS.md`] }),
    ],
    ["changed disk content", file("AGENTS.md", "Different disk snapshot", "New rules"), preview()],
    ["wrong Agent", undefined, preview({ agent: "codex" })],
    ["wrong workspace", undefined, preview({ project: "/sandbox/other" })],
    ["wrong working directory", undefined, preview({ cwd: `${root}/nested` })],
    [
      "custom loading rules",
      file("AGENTS.md", "", "Shared rules"),
      preview({
        sections: [],
        warnings: [
          "DeepSeek Harness custom instruction or Skill loading rules were detected; this preview uses the public default rules",
        ],
      }),
    ],
    [
      "truncated AGENTS",
      file("AGENTS.md", "Shared rules\n", "New rule"),
      preview({
        warnings: [`DeepSeek Harness instruction budget of 64 KiB truncated ${root}/AGENTS.md`],
      }),
    ],
    [
      "prior budget exhaustion",
      file("AGENTS.md", "", "New rule"),
      preview({
        sections: [],
        warnings: ["DeepSeek Harness instruction budget of 64 KiB was exhausted"],
      }),
    ],
    [
      "unrecognized instruction warning",
      file("AGENTS.md", "", "Shared rules"),
      preview({
        sections: [],
        warnings: ["A future instruction-loading rule could not be checked"],
      }),
    ],
  ] as const)("retains a conservative warning for %s", async (_label, shared, actual) => {
    expect(
      await planLiteralImportWarning(
        plan(imported, ...(shared ? [shared] : [])),
        async () => actual,
      ),
    ).toBe(true);
  });

  it("does not treat platform overrides as native AGENTS sources", async () => {
    expect(
      await planLiteralImportWarning(plan(imported), async () =>
        preview({
          sections: [section(`${root}/AGENTS.md`, "Shared rules", 0, "platform-override")],
        }),
      ),
    ).toBe(true);
  });

  it("does not use a different project's planned AGENTS file to satisfy the import", async () => {
    const unrelated = {
      ...file("AGENTS.md", "", "Shared rules"),
      target: "/sandbox/other/AGENTS.md",
    };
    expect(
      await planLiteralImportWarning(plan(imported, unrelated), async () =>
        preview({ sections: [] }),
      ),
    ).toBe(true);
  });

  it("does not assert that a nested import is safe from a root-only preview", async () => {
    const nested = { ...imported, target: `${root}/nested/CLAUDE.md` };
    expect(await planLiteralImportWarning(plan(nested), async () => preview())).toBe(true);
  });

  it("ignores harmless context notes and non-native platform override bytes", async () => {
    const read = async () =>
      preview({
        sections: [
          section(`${root}/AGENTS.md`, "Shared rules\n", 0),
          section(`${root}/.agentkib/manifest.yaml`, "x".repeat(70000), 1, "platform-override"),
        ],
        warnings: [
          "Note: Native Skill visibility could not be verified; legacy declarations are listed separately.",
        ],
      });
    expect(await planLiteralImportWarning(plan(imported), read)).toBe(false);
  });

  it("treats unavailable preview results as unknown and retains the warning", async () => {
    expect(
      await planLiteralImportWarning(plan(imported), async () => {
        throw new Error("unavailable");
      }),
    ).toBe(true);
  });

  it("matches Windows source identity without confusing sibling project paths", async () => {
    const project = "C:\\Projects\\Demo";
    const importedWindows = { ...imported, target: `${project}\\CLAUDE.md` };
    const actual = preview({
      project,
      cwd: project,
      sections: [section("c:/projects/demo/AGENTS.md", "Shared rules")],
    });
    expect(
      await planLiteralImportWarning(
        { ...plan(importedWindows), project_root: project },
        async () => actual,
      ),
    ).toBe(false);
    expect(
      await planLiteralImportWarning(
        { ...plan(importedWindows), project_root: project },
        async () => ({
          ...actual,
          sections: [section("c:/projects/demo-other/AGENTS.md", "Shared rules")],
        }),
      ),
    ).toBe(true);
  });
});
