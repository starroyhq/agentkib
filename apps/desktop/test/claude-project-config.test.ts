import { describe, expect, it } from "vitest";
import {
  claudeProjectKeyForm,
  hasClaudeProjects,
  readClaudeProjectEntry,
} from "../../../packages/backend/src/agents/claude/claude-project-config";

const server = (name: string) => ({
  [name]: { type: "http", url: `https://example.test/${name}` },
});

describe("readClaudeProjectEntry", () => {
  const root = {
    mcpServers: server("user-level"),
    projects: {
      "/work/current": { mcpServers: server("mine"), disabledMcpServers: ["off"], history: ["x"] },
      "/work/other-a": { mcpServers: server("other-a-server") },
      "/work/other-b": { mcpServers: server("other-b-server"), disabledMcpServers: ["b-off"] },
    },
  };

  it("returns the three fields of the matching entry and nothing of the others", () => {
    const entry = readClaudeProjectEntry(root, ["/work/current"], "linux");
    expect(entry).toEqual({
      mcpServers: server("mine"),
      disabledMcpServers: ["off"],
      trusted: false,
    });
    const text = JSON.stringify(entry);
    for (const leak of ["other-a", "other-b", "b-off", "history", "projects", "user-level"])
      expect(text).not.toContain(leak);
  });

  it("matches trailing separators on either side", () => {
    const keyed = { projects: { "/work/current//": { mcpServers: server("mine") } } };
    expect(readClaudeProjectEntry(keyed, ["/work/current"], "linux")?.mcpServers).toBeDefined();
    expect(readClaudeProjectEntry(root, ["/work/current/"], "linux")?.mcpServers).toBeDefined();
  });

  it("compares exactly on POSIX: case and backslashes matter", () => {
    expect(readClaudeProjectEntry(root, ["/work/Current"], "linux")).toBeUndefined();
    const windowsStyle = { projects: { "C:\\work\\current": { mcpServers: server("mine") } } };
    expect(readClaudeProjectEntry(windowsStyle, ["C:/work/current"], "darwin")).toBeUndefined();
  });

  it.each([
    ["C:\\Work\\Current", "c:/work/current"],
    ["c:/work/current/", "C:\\Work\\Current"],
    ["C:\\Work\\Current\\", "C:\\work\\current"],
  ])("matches Windows spellings %s and %s", (written, wanted) => {
    const keyed = { projects: { [written]: { mcpServers: server("mine") } } };
    expect(readClaudeProjectEntry(keyed, [wanted], "win32")?.mcpServers).toEqual(server("mine"));
  });

  it("takes the first key that matches, in the order given", () => {
    const both = {
      projects: {
        "/repo/app": { mcpServers: server("workspace") },
        "/repo": { mcpServers: server("repository") },
      },
    };
    expect(readClaudeProjectEntry(both, ["/repo", "/repo/app"], "linux")?.mcpServers).toEqual(
      server("repository"),
    );
    expect(readClaudeProjectEntry(both, ["/missing", "/repo/app"], "linux")?.mcpServers).toEqual(
      server("workspace"),
    );
  });

  it.each([
    ["no projects", {}],
    ["projects is a list", { projects: [] }],
    ["projects is a string", { projects: "x" }],
    ["the entry is a list", { projects: { "/work/current": [] } }],
    ["the entry is null", { projects: { "/work/current": null } }],
    ["no match", { projects: { "/elsewhere": { mcpServers: server("x") } } }],
  ])("finds nothing when %s", (_name, value) => {
    expect(readClaudeProjectEntry(value, ["/work/current"], "linux")).toBeUndefined();
  });

  it("ignores malformed servers and disabled entries without dropping valid names", () => {
    const entry = (value: unknown) =>
      readClaudeProjectEntry({ projects: { "/p": value } }, ["/p"], "linux");
    expect(entry({ mcpServers: [1], disabledMcpServers: "x" })).toEqual({
      disabledMcpServers: [],
      trusted: false,
    });
    expect(
      entry({ disabledMcpServers: ["ok", 3, "x".repeat(257), "also-ok"] })?.disabledMcpServers,
    ).toEqual(["ok", "x".repeat(257), "also-ok"]);
  });

  it.each([1023, 1024, 1025, 4097])("keeps every disabled name in a %i-item list", (count) => {
    const disabled = Array.from({ length: count }, (_, index) => `server-${index}`);
    const entry = readClaudeProjectEntry(
      { projects: { "/p": { disabledMcpServers: disabled } } },
      ["/p"],
      "linux",
    );
    expect(entry?.disabledMcpServers).toEqual(disabled);
  });

  it("keeps the current project in a bounded file with more than 10,000 projects", () => {
    const projects: Record<string, unknown> = {};
    for (let index = 0; index <= 10_000; index++) projects[`/p/${index}`] = {};
    projects["/work/current"] = {
      mcpServers: server("mine"),
      disabledMcpServers: ["off"],
      hasTrustDialogAccepted: true,
    };
    expect(Buffer.byteLength(JSON.stringify({ projects }))).toBeLessThan(1024 * 1024);
    expect(readClaudeProjectEntry({ projects }, ["/work/current"], "linux")).toEqual({
      mcpServers: server("mine"),
      disabledMcpServers: ["off"],
      trusted: true,
    });
  });

  it("is not confused by a __proto__ key", () => {
    const parsed = JSON.parse('{"projects":{"__proto__":{"mcpServers":{"x":{}}}}}');
    expect(readClaudeProjectEntry(parsed, ["/p"], "linux")).toBeUndefined();
    expect(({} as Record<string, unknown>).mcpServers).toBeUndefined();
  });
});

describe("claudeProjectKeyForm and hasClaudeProjects", () => {
  it("keeps the root separator and trims only trailing ones", () => {
    expect(claudeProjectKeyForm("/", "linux")).toBe("/");
    expect(claudeProjectKeyForm("/a/b///", "linux")).toBe("/a/b");
    expect(claudeProjectKeyForm("D:\\A\\B\\", "win32")).toBe("d:/a/b");
  });
  it("tells whether there is a projects table", () => {
    expect(hasClaudeProjects({ projects: {} })).toBe(true);
    expect(hasClaudeProjects({ projects: [] })).toBe(false);
    expect(hasClaudeProjects(null)).toBe(false);
  });
});
