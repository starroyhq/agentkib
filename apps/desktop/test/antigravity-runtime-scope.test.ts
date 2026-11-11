// @vitest-environment node
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityLocalRuntime } from "../../../packages/backend/src/antigravity-local-runtime";
import type { AntigravityLocalRecord } from "../../../packages/backend/src/antigravity-local-store";

const id = "11111111-2222-3333-4444-555555555555";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "antigravity-runtime-scope-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const workspace = path.join(home, "workspace"),
    other = path.join(home, "other");
  mkdirSync(workspace);
  mkdirSync(other);
  const state = {
    workspaces: [workspace],
    afterSteps: null as string[] | null,
    omitCatalog: false,
  };
  const methods: string[] = [];
  const server = createServer((req, res) => {
    const method = req.url?.split("/").at(-1) ?? "";
    methods.push(method);
    res.setHeader("content-type", "application/json");
    if (method === "GetAllCascadeTrajectories") {
      res.end(
        JSON.stringify(
          state.omitCatalog
            ? {}
            : {
                trajectorySummaries: {
                  [id]: {
                    workspaces: state.workspaces.map((p) => ({
                      workspaceFolderAbsoluteUri: pathToFileURL(p).href,
                    })),
                  },
                },
              },
        ),
      );
    } else if (method === "GetCascadeTrajectorySteps") {
      if (state.afterSteps) state.workspaces = state.afterSteps;
      res.end(
        JSON.stringify({
          steps: [
            {
              type: "CORTEX_STEP_TYPE_USER_INPUT",
              userInput: { userResponse: "Synthetic scoped history" },
            },
          ],
        }),
      );
    } else {
      res.statusCode = 400;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic server port");
  const daemon = path.join(home, ".gemini/antigravity/daemon");
  mkdirSync(daemon, { recursive: true });
  writeFileSync(
    path.join(daemon, "ls_fixture.json"),
    JSON.stringify({
      pid: process.pid,
      httpPort: address.port,
      csrfToken: "synthetic-scope-token",
    }),
  );
  const record: AntigravityLocalRecord = {
    surface: "app",
    id,
    workspace,
    title: null,
    created_at: null,
    updated_at: null,
    message_count: 1,
    availability: "readable",
  };
  return {
    runtime: new AntigravityLocalRuntime({ HOME: home }),
    record,
    workspace,
    other,
    state,
    methods,
  };
}

describe("Antigravity runtime workspace counterexamples", () => {
  it("rejects a stale offline workspace when the native directory proves a different workspace", async () => {
    const f = await fixture();
    f.state.workspaces = [f.other];
    await expect(f.runtime.events(f.record, null, 10)).rejects.toThrow();
    expect(f.methods).not.toContain("GetCascadeTrajectorySteps");
  });
  it("rechecks workspace ownership after the history request instead of accepting the one-second cached proof", async () => {
    const f = await fixture();
    f.state.afterSteps = [f.other];
    await expect(f.runtime.events(f.record, null, 10)).rejects.toThrow();
    expect(
      f.methods.filter((method) => method === "GetAllCascadeTrajectories").length,
    ).toBeGreaterThanOrEqual(2);
  });
  it("accepts an explicitly listed multi-root workspace", async () => {
    const f = await fixture();
    f.state.workspaces = [f.other, f.workspace];
    await expect(f.runtime.events(f.record, null, 10)).resolves.toMatchObject({
      events: [{ content: "Synthetic scoped history" }],
    });
  });
  it("does not treat an empty deprecated native directory as a conflict with the separately verified local proof", async () => {
    const f = await fixture();
    f.state.omitCatalog = true;
    await expect(f.runtime.events(f.record, null, 10)).resolves.toMatchObject({
      events: [{ content: "Synthetic scoped history" }],
    });
  });
});
