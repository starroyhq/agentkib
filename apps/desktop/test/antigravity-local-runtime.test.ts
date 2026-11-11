import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as http from "node:http";
import {
  AntigravityLocalRuntime,
  antigravityNativePage,
} from "../../../packages/backend/src/antigravity-local-runtime";
import type { AntigravityLocalRecord } from "../../../packages/backend/src/antigravity-local-store";

const id = "11111111-2222-3333-4444-555555555555";
const dispose: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});
const record: AntigravityLocalRecord = {
  surface: "app",
  id,
  workspace: "/fixture",
  title: "History",
  created_at: null,
  updated_at: null,
  message_count: 2,
  availability: "readable",
};
const steps = [
  {
    type: "CORTEX_STEP_TYPE_USER_INPUT",
    userInput: { userResponse: "hello 🌍" },
    metadata: { createdAt: "2026-11-10T00:00:00Z" },
  },
  {
    type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
    plannerResponse: {
      response: "draft",
      modifiedResponse: "visible answer",
      thinking: "PRIVATE THINKING",
    },
  },
  { type: "CORTEX_STEP_TYPE_RUN_COMMAND", runCommand: { commandLine: "DO NOT EXECUTE" } },
];
async function fixture(handler: http.RequestListener) {
  const home = mkdtempSync(path.join(os.tmpdir(), "antigravity-readonly-"));
  dispose.push(() => rmSync(home, { recursive: true, force: true }));
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  dispose.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const daemon = path.join(home, ".gemini/antigravity/daemon");
  mkdirSync(daemon, { recursive: true });
  const file = path.join(daemon, "ls_fixture.json");
  writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, httpPort: address.port, csrfToken: "synthetic-test-token" }),
  );
  return { home, file, port: address.port, runtime: new AntigravityLocalRuntime({ HOME: home }) };
}
const setGlobalProxyFromEnv = (
  http as typeof http & {
    setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => () => void;
  }
).setGlobalProxyFromEnv;
describe("Antigravity native read-only history", () => {
  it("reads the verified visible fields and excludes reasoning and commands", () => {
    const result = antigravityNativePage({ steps }, id, null, 10);
    expect(result.events.map((x) => [x.kind, x.content])).toEqual([
      ["user-message", "hello 🌍"],
      ["agent-message", "visible answer"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE THINKING|DO NOT EXECUTE/);
    expect(result.warnings).toContain("history.warning.partial");
  });
  it("pages in order and rejects cursors from a changed history", () => {
    const latest = antigravityNativePage({ steps }, id, null, 1);
    expect(latest.events[0]?.content).toBe("visible answer");
    expect(antigravityNativePage({ steps }, id, latest.next_cursor, 1).events[0]?.content).toBe(
      "hello 🌍",
    );
    expect(() =>
      antigravityNativePage({ steps: steps.slice(0, 1) }, id, latest.next_cursor, 1),
    ).toThrow(/cursor/);
    expect(() => antigravityNativePage({ steps }, "another-id", latest.next_cursor, 1)).toThrow(
      /cursor/,
    );
  });
  it("binds native cursors to the source and workspace even for migration copies", () => {
    const page = antigravityNativePage({ steps }, id, null, 1, "app:/workspace-a");
    for (const scope of ["ide:/workspace-a", "app:/workspace-b"])
      expect(() => antigravityNativePage({ steps }, id, page.next_cursor, 1, scope)).toThrow(
        /cursor/,
      );
  });
  it("uses only the authenticated loopback read route with PROD_UI verbosity", async () => {
    const requests: unknown[] = [];
    const f = await fixture((req, res) => {
      let body = "";
      req.on("data", (x) => (body += x));
      req.on("end", () => {
        requests.push({
          url: req.url,
          method: req.method,
          token: req.headers["x-codeium-csrf-token"],
          body: JSON.parse(body),
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url?.endsWith("GetAllCascadeTrajectories") ? {} : { steps }));
      });
    });
    expect(f.runtime.available("app")).toBe(true);
    expect((await f.runtime.events(record, null, 5))?.events).toHaveLength(2);
    expect(requests).toEqual([
      {
        url: "/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories",
        method: "POST",
        token: "synthetic-test-token",
        body: {},
      },
      {
        url: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps",
        method: "POST",
        token: "synthetic-test-token",
        body: { cascadeId: id, stepOffset: 0, trajectoryVerbosity: 2 },
      },
      {
        url: "/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories",
        method: "POST",
        token: "synthetic-test-token",
        body: {},
      },
    ]);
  });
  it("does not start a daemon when the application is closed", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "antigravity-offline-"));
    dispose.push(() => rmSync(home, { recursive: true, force: true }));
    expect(new AntigravityLocalRuntime({ HOME: home }).available("app")).toBe(false);
  });
  it.skipIf(!setGlobalProxyFromEnv)(
    "connects directly to the native daemon even when Node has an HTTP proxy",
    async () => {
      const origin = await fixture((req, res) => {
        res.end(JSON.stringify(req.url?.endsWith("GetAllCascadeTrajectories") ? {} : { steps }));
      });
      const proxiedHeaders: unknown[] = [];
      const proxy = await fixture((req, res) => {
        proxiedHeaders.push(req.headers["x-codeium-csrf-token"]);
        res.end("{}");
      });
      const restoreProxy = setGlobalProxyFromEnv!({
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: "",
      });
      try {
        // Verify this Node process actually routes ordinary fetch calls through the proxy.
        const probe = await fetch(`http://127.0.0.1:${origin.port}/probe`);
        await probe.text();
        expect(proxiedHeaders).toEqual([undefined]);
        const page = await origin.runtime.events(record, null, 5);
        expect(proxiedHeaders).toEqual([undefined]);
        expect(page?.events).toHaveLength(2);
      } finally {
        restoreProxy();
      }
    },
  );
  it("never follows redirects or leaks native errors/credentials", async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(302, { location: "http://example.invalid/" });
      res.end();
    });
    await expect(f.runtime.events(record, null, 5)).rejects.toThrow(
      "Antigravity native history could not be read",
    );
  });
  it("refuses invalid ports and malformed daemon metadata", async () => {
    const f = await fixture((_req, res) => res.end('{"steps":[] }'));
    writeFileSync(
      f.file,
      JSON.stringify({ pid: process.pid, httpPort: 70000, csrfToken: "token" }),
    );
    expect(f.runtime.available("app")).toBe(false);
    writeFileSync(f.file, "malformed private native metadata");
    expect(() => f.runtime.available("app")).toThrow("Antigravity runtime metadata is invalid");
  });
  it.skipIf(process.platform === "win32")(
    "rejects symlinked native metadata directories",
    async () => {
      const f = await fixture((_req, res) => res.end("{}"));
      const daemon = path.dirname(f.file),
        elsewhere = path.join(f.home, "elsewhere");
      mkdirSync(elsewhere);
      rmSync(daemon, { recursive: true });
      symlinkSync(elsewhere, daemon);
      expect(f.runtime.available("app")).toBe(false);
    },
  );
});
