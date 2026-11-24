import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyInteractionRisk } from "./interaction-risk";

describe("host interaction risk", () => {
  let directory: string;
  let workspace: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "agentkib-interaction-risk-")));
    workspace = path.join(directory, "workspace");
    await mkdir(path.join(workspace, "test"), { recursive: true });
    await writeFile(path.join(workspace, "test", "session_list_test.dart"), "");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const classifyCommand = (command: string | string[]) =>
    classifyInteractionRisk({ kind: "command", command, cwd: workspace }, workspace);

  it.each([
    ["rm -rf build && flutter build ios --release", "deletion"],
    ["git push origin main", "git-push"],
    ["pnpm install --frozen-lockfile", "dependency-install"],
    ["cat README.md && curl https://example.invalid/", "network"],
  ])("identifies a high-risk action in %s", async (command, reason) => {
    expect(await classifyCommand(command)).toEqual({ level: "high", reason });
  });

  it.each([
    ["git status", "read-only"],
    ["flutter test test/session_list_test.dart", "test"],
    ["pnpm test", "test"],
    ["pnpm run typecheck", "static-check"],
    ["tsc --noEmit", "static-check"],
  ])("recognizes the bounded low-risk form %s", async (command, reason) => {
    expect(await classifyCommand(command)).toEqual({ level: "low", reason });
  });

  it.each([
    "cat test/session_list_test.dart > out",
    "cat `echo /etc/passwd`",
    "cat ${HOME}/README.md",
    "cat test/*.dart",
    "cat test/session_list_test.dart && pwd",
    "cat test/session_list_test.dart | head",
    "git -c diff.external=other diff",
    "rg --pre=whatever token",
    "find . -exec echo {} ;",
    "sh -c 'pnpm test'",
    "pnpm test -- --config arbitrary",
  ])("keeps an unrecognized or compound shell command high: %s", async (command) => {
    expect((await classifyCommand(command)).level).toBe("high");
  });

  it("uses actual structured paths, executable arguments, and trusted workspace boundaries", async () => {
    const target = path.join(workspace, "test", "session_list_test.dart");
    expect(await classifyInteractionRisk({ kind: "read", paths: [target] }, workspace)).toEqual({
      level: "low",
      reason: "read-only",
    });
    expect(await classifyCommand(["cat", "--", target])).toEqual({
      level: "low",
      reason: "read-only",
    });
    expect(
      await classifyInteractionRisk(
        { kind: "write", cwd: workspace, paths: ["artifacts/new.txt"] },
        workspace,
      ),
    ).toEqual({ level: "file-modification", reason: "workspace-write" });
    expect(await classifyCommand("touch artifacts/new.txt")).toEqual({
      level: "file-modification",
      reason: "workspace-write",
    });
    expect(await classifyInteractionRisk({ kind: "delete", paths: [target] }, workspace)).toEqual({
      level: "high",
      reason: "deletion",
    });
    expect(
      await classifyInteractionRisk(
        {
          kind: "command",
          command: "pwd",
          cwd: workspace,
          network: true,
        },
        workspace,
      ),
    ).toEqual({ level: "high", reason: "network" });
    expect(await classifyInteractionRisk({ kind: "question" }, undefined)).toEqual({
      level: "low",
      reason: "question",
    });
  });

  it("fails closed for missing workspace or execution directory", async () => {
    expect(await classifyInteractionRisk({ kind: "read", paths: ["test"] }, undefined)).toEqual({
      level: "high",
      reason: "unknown-workspace",
    });
    expect(
      await classifyInteractionRisk(
        { kind: "read", paths: ["test/session_list_test.dart"] },
        workspace,
      ),
    ).toEqual({ level: "high", reason: "unknown-workspace" });
    expect(await classifyInteractionRisk({ kind: "command", command: "pwd" }, workspace)).toEqual({
      level: "high",
      reason: "unknown-workspace",
    });
    expect(await classifyInteractionRisk({ kind: "read" }, workspace)).toEqual({
      level: "high",
      reason: "unknown-operation",
    });
  });

  it("rejects outside paths, neighboring directories, and unknown drive syntax", async () => {
    const sibling = path.join(directory, "workspace-other");
    await mkdir(sibling);
    expect(await classifyCommand(["cat", path.join(sibling, "file")])).toEqual({
      level: "high",
      reason: "outside-workspace",
    });
    expect(
      await classifyInteractionRisk(
        { kind: "read", paths: ["../other"], cwd: workspace },
        workspace,
      ),
    ).toEqual({ level: "high", reason: "outside-workspace" });
    expect(
      await classifyInteractionRisk({ kind: "command", command: "pwd", cwd: sibling }, workspace),
    ).toEqual({ level: "high", reason: "outside-workspace" });
    expect(
      await classifyInteractionRisk(
        { kind: "write", paths: ["C:other"], cwd: workspace },
        workspace,
      ),
    ).toEqual({ level: "high", reason: "outside-workspace" });
  });

  it("rejects symlink ancestors of missing targets and hard-linked files", async () => {
    const outside = path.join(directory, "outside");
    const outsideFile = path.join(outside, "sensitive");
    await mkdir(outside);
    await writeFile(outsideFile, "");
    await symlink(outside, path.join(workspace, "link"), "junction");
    await link(outsideFile, path.join(workspace, "hardlink"));
    expect(
      await classifyInteractionRisk(
        { kind: "write", paths: ["link/new.txt"], cwd: workspace },
        workspace,
      ),
    ).toEqual({ level: "high", reason: "outside-workspace" });
    expect(
      await classifyInteractionRisk(
        {
          kind: "read",
          paths: [path.join(workspace, "hardlink")],
        },
        workspace,
      ),
    ).toEqual({ level: "high", reason: "outside-workspace" });
    expect(await classifyCommand(["cat", "link/sensitive"])).toEqual({
      level: "high",
      reason: "outside-workspace",
    });
  });
});
