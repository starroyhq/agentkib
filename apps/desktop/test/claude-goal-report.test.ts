import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClaudeGoalReportEndpoint,
  type ClaudeGoalReport,
  type ClaudeGoalReportBinding,
} from "../../../packages/backend/src/agents/claude/claude-goal-report";

const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { Client } = requireBackend("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireBackend(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const binding = (): ClaudeGoalReportBinding => ({
  goalId: randomUUID(),
  goalGeneration: randomUUID(),
  stepId: randomUUID(),
  bootId: randomUUID(),
});
const report = () => ({
  reportId: randomUUID(),
  outcome: "complete",
  summary: "The synthetic verification passed.",
  evidence: ["A specific fixture check passed."],
  remainingWork: [],
});

async function fixture(onReport?: (value: ClaudeGoalReport) => void | Promise<void>) {
  const expected = binding();
  const reports: ClaudeGoalReport[] = [];
  const endpoint = await createClaudeGoalReportEndpoint(
    expected,
    onReport ??
      ((value) => {
        reports.push(value);
      }),
  );
  cleanups.push(() => endpoint.close());
  const servers = endpoint.mcpConfig.mcpServers as Record<string, { url: string }>;
  const url = servers.agentkib_goal_report!.url;
  const client = new Client({ name: "synthetic-goal-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  cleanups.push(() => client.close());
  return { expected, reports, endpoint, url, client };
}

describe("private Claude goal report MCP", () => {
  it("reports pending against the host's exact boot/goal/step and deduplicates identical retries", async () => {
    const f = await fixture();
    const catalog = await f.client.listTools();
    expect(catalog.tools.map((tool: { name: string }) => tool.name)).toEqual(["report_goal_step"]);
    const input = report();
    const first = await f.client.callTool({ name: "report_goal_step", arguments: input });
    expect(first.isError).not.toBe(true);
    expect(first.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          accepted: true,
          status: "pending",
          reportId: input.reportId,
          stepId: f.expected.stepId,
          duplicate: false,
        }),
      },
    ]);
    const duplicate = await f.client.callTool({ name: "report_goal_step", arguments: input });
    expect(duplicate.isError).not.toBe(true);
    expect(f.reports).toEqual([{ ...f.expected, ...input }]);
    const conflict = await f.client.callTool({
      name: "report_goal_step",
      arguments: { ...input, summary: "different" },
    });
    expect(conflict.isError).toBe(true);
    expect(f.reports).toHaveLength(1);
  });

  it("rejects unsupported fields, empty evidence and unfinished completion without recording", async () => {
    const f = await fixture();
    const input = report();
    for (const invalid of [
      { ...input, bootId: randomUUID() },
      { ...input, evidence: [] },
      { ...input, remainingWork: ["not done"] },
      { ...input, outcome: "continue", remainingWork: [] },
      { ...input, summary: "x".repeat(5000) },
    ]) {
      const result = await f.client.callTool({ name: "report_goal_step", arguments: invalid });
      expect(result.isError).toBe(true);
    }
    expect(f.reports).toHaveLength(0);
    const valid = await f.client.callTool({
      name: "report_goal_step",
      arguments: { ...input, outcome: "blocked", remainingWork: ["Missing explicit input"] },
    });
    expect(valid.isError).not.toBe(true);
    expect(f.reports[0]?.outcome).toBe("blocked");
  });

  it("does not accept forged paths, browser origins or mismatched Host headers", async () => {
    const f = await fixture();
    for (const [url, headers] of [
      [new URL("/goal/wrong", f.url).href, {}],
      [f.url, { Origin: "https://untrusted.example" }],
      [f.url, { Host: "untrusted.example" }],
    ] as Array<[string, Record<string, string>]>) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request(
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        outgoing.once("error", reject);
        outgoing.end("{}");
      });
      expect(status).toBe(404);
    }
    expect(f.reports).toHaveLength(0);
  });

  it("serializes concurrent duplicate reports and makes old endpoint credentials unusable on close", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorded: ClaudeGoalReport[] = [];
    const f = await fixture(async (value) => {
      recorded.push(value);
      await pending;
    });
    const input = report();
    const first = f.client.callTool({ name: "report_goal_step", arguments: input });
    await expect.poll(() => recorded.length).toBe(1);
    const second = f.client.callTool({ name: "report_goal_step", arguments: input });
    release();
    const results = await Promise.all([first, second]);
    expect(results.every((result: { isError?: boolean }) => result.isError !== true)).toBe(true);
    expect(recorded).toHaveLength(1);
    await f.client.close();
    await f.endpoint.close();
    await expect(fetch(f.url)).rejects.toThrow();
    await expect(f.endpoint.close()).resolves.toBeUndefined();
  });

  it("bounds simultaneous MCP connections while initialization requests race", async () => {
    const f = await fixture();
    const clients = Array.from(
      { length: 8 },
      () => new Client({ name: "racing-client", version: "1.0.0" }),
    );
    for (const client of clients) cleanups.push(() => client.close());
    const results = await Promise.allSettled(
      clients.map((client) => client.connect(new StreamableHTTPClientTransport(new URL(f.url)))),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(5);
    expect(f.reports).toHaveLength(0);
  });

  it("never claims a report accepted when owner persistence rejects a stale step", async () => {
    let calls = 0;
    const f = await fixture(() => {
      calls++;
      throw new Error("stale goal step");
    });
    const input = report();
    const result = await f.client.callTool({ name: "report_goal_step", arguments: input });
    expect(result.isError).toBe(true);
    const duplicate = await f.client.callTool({ name: "report_goal_step", arguments: input });
    expect(duplicate.isError).toBe(true);
    expect(calls).toBe(1);
    // A failed persistence callback remains an explicit cleanup failure, not a success receipt.
    await expect(f.endpoint.close()).rejects.toThrow("cleanup failed");
    cleanups.splice(0, 1);
  });
});
