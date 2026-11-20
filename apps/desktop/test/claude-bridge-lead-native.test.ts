// @vitest-environment node
// Opt in on macOS with AGENTKIB_CLAUDE_BRIDGE_NATIVE=1 (AGENTKIB_CLAUDE_EXECUTABLE for a CLI other
// than ~/.local/bin/claude). The installed TUI, with this repository's connection plugin, runs a
// terminal Project Agent against a synthetic localhost provider and an in-process AgentKib: the
// real broker and orchestration, workers stood in for. No model account is used.
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ClaudeBridge, type ClaudeBridgeTarget } from "../../../packages/backend/src/claude-bridge";
import { OrchestrationService } from "../../../packages/backend/src/orchestration-service";

type Json = Record<string, any>;

const PYTHON_PTY = String.raw`
import os, sys, pty, select, json, signal, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
pending = b''
try:
    while True:
        ready, _, _ = select.select([fd, 0], [], [], 1)
        if fd in ready:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            print(json.dumps({'data': data.decode('utf-8', 'replace')}), flush=True)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data: break
            pending += data
            while b'\n' in pending:
                row, pending = pending.split(b'\n', 1)
                message = json.loads(row)
                if message.get('stop'):
                    os.kill(pid, signal.SIGTERM)
                else:
                    os.write(fd, message['text'].encode())
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            print(json.dumps({'exit': status}), flush=True)
            break
finally:
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    os.close(fd)
`;

function terminal(executable: string, args: string[], workspace: string, env: NodeJS.ProcessEnv) {
  const child: ChildProcessWithoutNullStreams = spawn(
    "python3",
    ["-u", "-c", PYTHON_PTY, workspace, executable, ...args],
    { env, stdio: "pipe" },
  );
  let transcript = "",
    pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const value = JSON.parse(line);
      if (typeof value.data === "string") transcript += value.data;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    transcript += chunk.toString();
  });
  return {
    child,
    write(text: string) {
      child.stdin.write(JSON.stringify({ text }) + "\n");
    },
    get text() {
      // oxlint-disable-next-line no-control-regex -- Native PTY output contains ANSI control sequences.
      return transcript.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.write(JSON.stringify({ stop: true }) + "\n");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function event(response: ServerResponse, type: string, value: object) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
}

const blocks = (message: Json | undefined): Json[] =>
  !message
    ? []
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content ?? []);

describe.skipIf(process.platform !== "darwin" || process.env.AGENTKIB_CLAUDE_BRIDGE_NATIVE !== "1")(
  "a terminal Claude Code session as a Project Agent",
  () => {
    it("gets its worker tools, runs them through AgentKib and takes reports as turns", async () => {
      const executable = realpathSync(
        process.env.AGENTKIB_CLAUDE_EXECUTABLE ?? path.join(homedir(), ".local/bin/claude"),
      );
      const version = /^(\d+\.\d+\.\d+)/.exec(
        spawnSync(executable, ["--version"], { encoding: "utf8" }).stdout.trim(),
      )?.[1];
      expect(version).toBeTruthy();
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-lead-native-")));
      const workspace = path.join(root, "workspace"),
        config = path.join(root, "config"),
        plugin = path.join(root, "plugin"),
        home = path.join(root, "home");
      for (const directory of [workspace, config, home]) mkdirSync(directory, { mode: 0o700 });
      cpSync(path.resolve(import.meta.dirname, "../../../packages/claude-bridge-plugin"), plugin, {
        recursive: true,
      });
      writeFileSync(
        path.join(config, ".claude.json"),
        JSON.stringify({
          hasCompletedOnboarding: true,
          theme: "dark",
          projects: {
            [workspace]: { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1 },
          },
        }),
      );
      writeFileSync(
        path.join(config, "settings.json"),
        JSON.stringify({ permissions: { defaultMode: "manual" }, autoUpdatesChannel: "stable" }),
      );
      const nativeId = randomUUID(),
        sessionId = "terminal-lead",
        bootId = randomUUID();
      const target: ClaudeBridgeTarget = {
        sessionId,
        nativeId,
        workspaceId: "w1",
        workspace,
        registeredWorkspace: workspace,
      };
      // What the model was sent: the tools it was offered and the last user message.
      const requests: Array<{ tools: string[]; text: string; results: string[] }> = [];
      // LEAD-BACKGROUND starts two background commands and ends the turn; each wakes the CLI.
      let backgroundStep = 0;
      const toolUse = (name: string, input: Json) => ({
        type: "tool_use",
        id: `toolu_${randomUUID().slice(0, 8)}`,
        name,
        input,
      });
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(request.url?.includes("count_tokens") ? '{"input_tokens":64}' : "{}");
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Json;
        const messages: Json[] = body.messages ?? [];
        const last = [...messages].reverse().find((message) => message.role === "user");
        const text = blocks(last)
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const results = blocks(last)
          .filter((block) => block.type === "tool_result")
          .map((block) => JSON.stringify(block.content));
        const tools = (body.tools ?? []).map((tool: Json) => tool.name);
        requests.push({ tools, text, results });
        let content: Json;
        if (text.includes("LEAD-LIST") && tools.includes("mcp__agentkib-bridge__worker_list"))
          content = toolUse("mcp__agentkib-bridge__worker_list", {});
        else if (text.includes("LEAD-BACKGROUND") && !results.length) {
          backgroundStep = 1;
          content = toolUse("Bash", {
            command: "sleep 3 && echo BG-ONE",
            description: "First background step",
            run_in_background: true,
          });
        } else if (backgroundStep === 1 && results.length) {
          backgroundStep = 2;
          content = toolUse("Bash", {
            command: "sleep 12 && echo BG-TWO",
            description: "Second background step",
            run_in_background: true,
          });
        } else if (backgroundStep === 2 && results.length) {
          backgroundStep = 3;
          content = { type: "text", text: "fixture-bg-started" };
        } else
          content = { type: "text", text: results.length ? "fixture-after-tool" : "fixture-reply" };
        const callWorkers = content.type === "tool_use";
        const message = {
          id: `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [content],
          stop_reason: callWorkers ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 64, output_tokens: 8 },
        };
        if (!body.stream) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(message));
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        event(response, "message_start", {
          type: "message_start",
          message: { ...message, content: [], stop_reason: null },
        });
        event(response, "content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: callWorkers ? { ...content, input: {} } : { type: "text", text: "" },
        });
        event(response, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: callWorkers
            ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) }
            : { type: "text_delta", text: (content as Json).text },
        });
        event(response, "content_block_stop", { type: "content_block_stop", index: 0 });
        event(response, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 8 },
        });
        event(response, "message_stop", { type: "message_stop" });
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      let bridge: ClaudeBridge;
      // Turns the person typed, as AgentKib heard them (events flush every 250 ms).
      let spoken = 0;
      // Workers stood in for: AgentKib's Codex side is not part of this run.
      const lanes = {
        control: async () => ({ accepted: true }),
        live: async (id: string) => ({
          sessionId: id,
          status: "idle",
          revision: 1,
          approvals: [],
          questions: [],
        }),
        events: async () => [
          { kind: "agent-message", content: "Worker done.", turn_id: "lane-turn" },
        ],
        session: (id: string) =>
          id === "worker-session" ? { agent: "codex", workspaceId: "w1", title: null } : null,
        managed: async () => false,
        workspaces: () => [{ id: "w1", name: "workspace" }],
      };
      const orchestration = new OrchestrationService(
        path.join(root, "data"),
        bootId,
        lanes,
        (id) => bridge.leadCapable(id),
        (id, _device, text) => bridge.queueReport(id, text),
        (id) => bridge.queuedReports(id),
      );
      bridge = new ClaudeBridge({
        dataDir: path.join(root, "data"),
        bootId,
        pluginDirectory: plugin,
        target: async () => target,
        validate: () => undefined,
        publish: () => undefined,
        lead: {
          tools: (id) => orchestration.leadToolSpecs(id),
          call: (id, name, input) => orchestration.call(id, name, input),
          userSpoke: (id) => {
            spoken++;
            if (orchestration.status(id)) orchestration.userSpoke(id);
          },
          // As the backend wires it (`index.ts`).
          selfTurn: (id) => {
            const lead = orchestration.status(id);
            if (!lead) return null;
            return orchestration.leadSelfTurn(id) ? null : { stopAs: lead.deviceId };
          },
          paused: (id) => {
            const lead = orchestration.status(id);
            return lead?.paused ? (lead.reason ?? "paused") : null;
          },
        },
      });
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(ANTHROPIC_|CLAUDE_|OPENAI_|AWS_|GOOGLE_|AZURE_)/.test(key),
        ),
      );
      Object.assign(environment, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_AUTH_TOKEN: "synthetic-offline-fixture",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        ENABLE_TOOL_SEARCH: "false",
        TERM: "xterm-256color",
      });
      const tty = terminal(
        executable,
        [
          "--session-id",
          nativeId,
          "--plugin-dir",
          plugin,
          "--model",
          "claude-sonnet-4-5-20250929",
          "--permission-mode",
          "manual",
          "--setting-sources",
          "user",
          // The worker tools are not allowed here: the plugin lets them run while the session
          // leads. Bash is, for the background steps.
          "--allowedTools",
          "Bash",
        ],
        workspace,
        environment,
      );
      const wait = { timeout: 30_000, interval: 200 };
      try {
        await expect.poll(() => tty.text.includes(`v${version}`), wait).toBe(true);
        tty.write("terminal-seed\r");
        await expect.poll(() => tty.text.includes("fixture-reply"), wait).toBe(true);
        const { challenge } = (await bridge.management({
          operation: "bridge-challenge",
          sessionId,
          deviceId: "agentkib-local-owner",
        })) as { challenge: string };
        tty.write(`\x1b[200~/agentkib-connect ${challenge}\x1b[201~`);
        await expect.poll(() => tty.text.includes(challenge.slice(-24)), wait).toBe(true);
        tty.write("\r");
        // The plugin asks for the feature on its polls once the broker named it.
        await expect.poll(() => bridge.leadCapable(sessionId), wait).toBe(true);
        orchestration.designate({
          sessionId,
          deviceId: "agentkib-local-owner",
          workspaceId: "w1",
          scope: { maxAutoTurns: 1 },
        });
        await orchestration.assignWorkers({
          sessionId,
          deviceId: "agentkib-local-owner",
          workspaceId: "w1",
          workers: ["worker-session"],
        });
        bridge.leadChanged(sessionId);

        // The poll it wakes registers the tools; a turn typed in the terminal uses one.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        tty.write("LEAD-LIST\r");
        await expect
          .poll(
            () => requests.some((request) => request.results.some((r) => r.includes("workers"))),
            wait,
          )
          .toBe(true);
        const tools = requests.find((request) => request.text.includes("LEAD-LIST"))?.tools;
        expect(tools).toContain("mcp__agentkib-bridge__worker_list");
        expect(tools).not.toContain("mcp__agentkib-bridge__worker_open");
        expect(tools).not.toContain("mcp__agentkib-bridge__worker_close");
        await expect.poll(() => tty.text.includes("fixture-after-tool"), wait).toBe(true);
        // That typed turn is heard before a report arrives, as it came first.
        await expect.poll(() => spoken, wait).toBeGreaterThanOrEqual(1);

        // A worker's turn ends: the report reaches the terminal as a turn of its own.
        await orchestration.laneTurnEnded("worker-session", "lane-turn", "completed", 12_000);
        await expect
          .poll(
            () => requests.some((request) => request.text.includes("[AgentKib report] Worker")),
            wait,
          )
          .toBe(true);
        await expect.poll(() => orchestration.status(sessionId)?.autoTurns, wait).toBe(1);
        // Typed in the terminal again: the count of turns without the person restarts.
        tty.write("terminal-again\r");
        await expect.poll(() => orchestration.status(sessionId)?.autoTurns, wait).toBe(0);

        // Background work wakes the CLI by itself. One such turn counts; the next is past the
        // limit of one: it stops, delegation pauses and the terminal says why.
        tty.write("LEAD-BACKGROUND\r");
        await expect.poll(() => tty.text.includes("fixture-bg-started"), wait).toBe(true);
        const slow = { timeout: 60_000, interval: 200 };
        await expect
          .poll(() => orchestration.status(sessionId)?.reason, slow)
          .toBe("auto-turn-limit");
        expect(orchestration.status(sessionId)).toMatchObject({ paused: true, autoTurns: 1 });
        const flat = () => tty.text.replace(/\s+/g, "");
        await expect.poll(() => flat().includes("automaticturnsreachedthelimit"), wait).toBe(true);
        await expect.poll(() => bridge.live(sessionId, true).status, wait).toBe("idle");
        // Typed in the terminal: delegation goes on, and the terminal hears it.
        tty.write("terminal-resume\r");
        await expect.poll(() => orchestration.status(sessionId)?.paused, wait).toBe(false);
        await expect
          .poll(() => flat().includes("resumedthisProjectAgent'sdelegation"), slow)
          .toBe(true);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n--- terminal ---\n${tty.text.slice(-4000)}`);
      } finally {
        await tty.close();
        await bridge.close();
        await orchestration.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
