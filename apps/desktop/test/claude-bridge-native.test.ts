// @vitest-environment node
// Opt in on macOS with AGENTKIB_CLAUDE_BRIDGE_NATIVE=1. This runs the installed
// 2.1.301 TUI against a synthetic localhost provider, never a real model account.
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ClaudeBridge, type ClaudeBridgeTarget } from "../../../packages/backend/src/claude-bridge";
import { finishClaudeBridgeNative } from "./fixtures/claude-bridge-native-cleanup";
import { createClaudeBridgeNativeEvidence } from "./fixtures/claude-bridge-native-evidence";

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

describe.skipIf(process.platform !== "darwin" || process.env.AGENTKIB_CLAUDE_BRIDGE_NATIVE !== "1")(
  "installed Claude native borrowed session",
  () => {
    it("reads, sends to and cancels the same TUI executor", async () => {
      const executable =
        process.env.AGENTKIB_CLAUDE_EXECUTABLE ?? path.join(homedir(), ".local/bin/claude");
      const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
      expect(version.stdout.trim()).toBe("2.1.301 (Claude Code)");
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-native-")));
      const workspace = path.join(root, "workspace"),
        config = path.join(root, "config"),
        plugin = path.join(root, "plugin"),
        home = path.join(root, "home");
      mkdirSync(workspace, { mode: 0o700 });
      mkdirSync(config, { mode: 0o700 });
      mkdirSync(home, { mode: 0o700 });
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
        JSON.stringify({
          permissions: { defaultMode: "manual" },
          enabledPlugins: {},
          autoUpdatesChannel: "stable",
        }),
      );
      const nativeId = randomUUID(),
        sessionId = "native-fixture-session",
        bootId = randomUUID();
      const target: ClaudeBridgeTarget = {
        sessionId,
        nativeId,
        workspaceId: "workspace",
        workspace,
        registeredWorkspace: workspace,
      };
      const requests: Array<{ text: string; model: string; purpose: string }> = [];
      const held = new Set<ServerResponse>();
      let observeRunningReload = false;
      const runningReloadStates: Array<{ type: string; live: Record<string, unknown> }> = [];
      let runningReloadEvidence: Record<string, unknown> = { status: "not-started" };
      let cancelConnectionClosed = false;
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.url?.includes("count_tokens")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end('{"input_tokens":64}');
          return;
        }
        if (!request.url?.startsWith("/v1/messages")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{}");
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const last = [...(body.messages ?? [])]
          .reverse()
          .find((message) => message.role === "user");
        const text =
          typeof last?.content === "string"
            ? last.content
            : (last?.content ?? [])
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n");
        const purpose = text.includes("Write the title in the predominant language")
          ? "native-title"
          : text.includes("bridge-cancel")
            ? "cancel"
            : text.includes("bridge-followup")
              ? "followup"
              : text.includes("terminal-seed")
                ? "seed"
                : "other";
        requests.push({ text, model: body.model, purpose });
        const answer = text.includes("bridge-followup")
          ? "fixture-bridge-reply"
          : "fixture-terminal-reply";
        const message = {
          id: `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 64, output_tokens: 0 },
        };
        if (!body.stream) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ...message,
              content: [{ type: "text", text: answer }],
              stop_reason: "end_turn",
              usage: { input_tokens: 64, output_tokens: 8 },
            }),
          );
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        event(response, "message_start", { type: "message_start", message });
        event(response, "content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        event(response, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: answer },
        });
        if (text.includes("bridge-cancel")) {
          held.add(response);
          response.once("close", () => {
            held.delete(response);
            cancelConnectionClosed = true;
          });
          return;
        }
        event(response, "content_block_stop", { type: "content_block_stop", index: 0 });
        event(response, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 8 },
        });
        event(response, "message_stop", { type: "message_stop" });
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const bridge = new ClaudeBridge({
        dataDir: path.join(root, "data"),
        bootId,
        pluginDirectory: plugin,
        target: async () => target,
        validate: () => undefined,
        publish: (_id, type, _payload, live) => {
          if (observeRunningReload) runningReloadStates.push({ type, live });
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
          "--debug-file",
          path.join(root, "cli.log"),
        ],
        workspace,
        environment,
      );
      let challenge = "";
      let runningEvidence: Record<string, unknown> | null = null;
      let nativeHistoryVerified = false;
      let failure: { error: unknown } | undefined;
      const control = (text: string) => ({
        operation: "send",
        sessionId,
        requestId: randomUUID(),
        deviceId: "agentkib-local-owner",
        runtimeBootId: bootId,
        expectedRevision: bridge.live(sessionId, true).revision,
        experimentalEnabled: true,
        text,
      });
      try {
        await expect.poll(() => tty.text.includes("v2.1.301"), { timeout: 20_000 }).toBe(true);
        tty.write("terminal-seed\r");
        await expect
          .poll(() => tty.text.includes("fixture-terminal-reply"), { timeout: 20_000 })
          .toBe(true);
        const prepared = (await bridge.management({
          operation: "bridge-challenge",
          sessionId,
          deviceId: "agentkib-local-owner",
        })) as { challenge: string };
        challenge = prepared.challenge;
        tty.write(`\x1b[200~/agentkib-connect ${challenge}\x1b[201~`);
        await expect
          .poll(() => tty.text.includes(challenge.slice(-24)), { timeout: 5000 })
          .toBe(true);
        tty.write("\r");
        await expect
          .poll(
            () =>
              bridge.handles(sessionId) &&
              bridge.live(sessionId, true).connectionGeneration !== null &&
              bridge.live(sessionId, true).sendEnabled === true,
            { timeout: 20_000 },
          )
          .toBe(true);
        expect(bridge.live(sessionId, true)).toMatchObject({
          sourceSessionId: nativeId,
          executionMode: "claude-follower",
        });
        expect(bridge.live(sessionId, true).sendEnabled).toBe(true);
        const first = control("bridge-followup");
        expect(await bridge.request(first)).toMatchObject({ accepted: true });
        await expect
          .poll(() => requests.filter((item) => item.text.includes("bridge-followup")).length, {
            timeout: 12_000,
          })
          .toBe(1);
        await expect
          .poll(() => bridge.live(sessionId, true).sendEnabled, { timeout: 12_000 })
          .toBe(true);
        // A repeated request id is answered from the receipt and starts nothing.
        expect(await bridge.request(first)).toMatchObject({ accepted: true });
        expect(requests.filter((item) => item.text.includes("bridge-followup"))).toHaveLength(1);
        expect(await bridge.request(control("bridge-cancel"))).toMatchObject({ accepted: true });
        await expect
          .poll(() => requests.some((item) => item.text.includes("bridge-cancel")), {
            timeout: 12_000,
          })
          .toBe(true);
        await expect
          .poll(() => Boolean(bridge.live(sessionId, true).turnId), { timeout: 12_000 })
          .toBe(true);
        await expect
          .poll(
            () =>
              String(bridge.live(sessionId, true).streamText).includes("fixture-terminal-reply"),
            { timeout: 12_000 },
          )
          .toBe(true);
        let running = bridge.live(sessionId, true);
        runningEvidence = {
          sourceSessionId: running.sourceSessionId,
          executionMode: running.executionMode,
          status: running.status,
          streamText: running.streamText,
          stopEnabled: running.stopEnabled,
          usage: running.usage,
        };
        const originalTurnId = running.turnId;
        const originalGeneration = running.connectionGeneration;
        const requestsBeforeReload = requests.length;
        const hooksModule = path.join(plugin, "hooks/register.js");
        observeRunningReload = true;
        runningReloadEvidence = {
          status: "waiting-for-running-reload",
          originalTurnId,
          originalGeneration,
          requestsBeforeReload,
        };
        // File watching must reload the real module while this same provider
        // response is held. A slash command could queue behind the active turn.
        writeFileSync(
          hooksModule,
          readFileSync(hooksModule, "utf8") + `\n// isolated running reload ${randomUUID()}\n`,
        );
        const watchUntil = Date.now() + 20_000;
        let reloaded: Record<string, unknown> | undefined;
        while (Date.now() < watchUntil) {
          const live = bridge.live(sessionId, true);
          if (
            live.connectionGeneration !== originalGeneration &&
            live.connectionGeneration !== bootId &&
            live.status !== "unsupported"
          ) {
            reloaded = live;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        if (reloaded) {
          runningReloadEvidence = {
            ...runningReloadEvidence,
            status: "running-without-confirmed-turn",
            reloaded,
          };
          expect(reloaded).toMatchObject({
            status: "running",
            turnId: null,
            stopEnabled: false,
            sendEnabled: false,
            reason: "claude-follower-turn-unconfirmed",
          });
          expect(requests).toHaveLength(requestsBeforeReload);
          expect(held.size).toBe(1);
          const continuation = `fixture-reload-continuation-${randomUUID()}`;
          event([...held][0]!, "content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: continuation },
          });
          runningReloadEvidence = {
            ...runningReloadEvidence,
            status: "waiting-for-native-turn-recovery",
            continuation,
          };
          await expect
            .poll(
              () => {
                const live = bridge.live(sessionId, true);
                return (
                  live.turnId === originalTurnId &&
                  live.stopEnabled === true &&
                  String(live.streamText).includes(continuation)
                );
              },
              { timeout: 12_000 },
            )
            .toBe(true);
          running = bridge.live(sessionId, true);
          runningReloadEvidence = {
            ...runningReloadEvidence,
            status: "same-turn-recovered",
            recoveryVerified: true,
            recovered: running,
          };
          expect(running.status).toBe("running");
          expect(requests).toHaveLength(requestsBeforeReload);
          for (const { live } of runningReloadStates) {
            if (
              live.connectionGeneration === originalGeneration ||
              live.connectionGeneration === bootId ||
              live.status === "unsupported"
            )
              continue;
            expect(live.status).toBe("running");
            if (!live.turnId) expect(live.stopEnabled).toBe(false);
          }
        } else {
          // The fixed CLI did not hot-reload this in-flight module during the
          // observation window. This is an unverified experiment, not proof
          // that a new module can recover a turn from the existing iterator.
          running = bridge.live(sessionId, true);
          expect(running).toMatchObject({
            connectionGeneration: originalGeneration,
            turnId: originalTurnId,
            status: "running",
            stopEnabled: true,
            sendEnabled: false,
          });
          expect(requests).toHaveLength(requestsBeforeReload);
          runningReloadEvidence = {
            ...runningReloadEvidence,
            status: "not-verified",
            observed: "watcher-deferred",
            observationMs: 20_000,
            recoveryVerified: false,
            unchanged: running,
          };
        }
        observeRunningReload = false;
        expect(
          await bridge.request({
            operation: "stop",
            sessionId,
            requestId: randomUUID(),
            deviceId: "agentkib-local-owner",
            runtimeBootId: bootId,
            expectedRevision: running.revision,
            experimentalEnabled: true,
            turnId: running.turnId,
          }),
        ).toMatchObject({ accepted: true });
        await expect.poll(() => cancelConnectionClosed, { timeout: 12_000 }).toBe(true);
        await expect
          .poll(() => bridge.live(sessionId, true).turnId, { timeout: 12_000 })
          .toBeNull();
        expect(requests).toHaveLength(requestsBeforeReload);
        runningReloadEvidence = {
          ...runningReloadEvidence,
          baseCancellation: "same-original-turn-cancelled",
          requestsAfterCancellation: requests.length,
        };
        const before = requests.length;
        const oldGeneration = bridge.live(sessionId, true).connectionGeneration;
        tty.write("/reload-plugins\r");
        // 2.1.301 keeps an unchanged hooks module alive on /reload-plugins.
        // Changing only this isolated copy exercises a real hot module reload.
        writeFileSync(
          hooksModule,
          readFileSync(hooksModule, "utf8") + `\n// isolated reload ${randomUUID()}\n`,
        );
        await expect
          .poll(
            () =>
              bridge.live(sessionId, true).connectionGeneration !== oldGeneration &&
              bridge.live(sessionId, true).sendEnabled === true,
            { timeout: 20_000 },
          )
          .toBe(true);
        expect(requests).toHaveLength(before);
        expect(tty.child.exitCode).toBeNull();
        const histories = readdirSync(config, { recursive: true }).filter(
          (entry) => typeof entry === "string" && entry.endsWith(`${nativeId}.jsonl`),
        );
        expect(histories).toHaveLength(1);
        expect(requests.filter((item) => item.purpose === "seed")).toHaveLength(1);
        expect(requests.filter((item) => item.purpose === "cancel")).toHaveLength(1);
        expect(requests.filter((item) => item.purpose === "followup")).toHaveLength(1);
        const nativeHistory = readFileSync(path.join(config, String(histories[0])), "utf8");
        expect(nativeHistory).toContain("terminal-seed");
        expect(nativeHistory).toContain("bridge-cancel");
        expect(nativeHistory).toContain("fixture-terminal-reply");
        nativeHistoryVerified = true;
        expect(existsSync(path.join(plugin, ".claude-plugin/types/claude-code/index.d.ts"))).toBe(
          true,
        );
      } catch (error) {
        failure = { error };
      } finally {
        const evidence = createClaudeBridgeNativeEvidence({
          evidenceDirectory: process.env.AGENTKIB_NATIVE_BRIDGE_EVIDENCE_DIR,
          executable,
          root,
          plugin,
          repository: path.resolve(import.meta.dirname, "../../.."),
          home: homedir(),
          challenge,
        });
        await finishClaudeBridgeNative({
          terminal: tty,
          bridge,
          provider: server,
          held,
          root,
          failure,
          saveEvidence() {
            evidence.save({
              terminalText: tty.text,
              runningReload: {
                ...runningReloadEvidence,
                latest: bridge.handles(sessionId) ? bridge.live(sessionId, true) : null,
                states: runningReloadStates,
                requestsAfterReload: requests.length,
              },
              summary: {
                version: version.stdout.trim(),
                nativeId,
                productionSend: "enabled",
                requests,
                requestCounts: Object.fromEntries(
                  ["native-title", "seed", "followup", "cancel", "other"].map((purpose) => [
                    purpose,
                    requests.filter((request) => request.purpose === purpose).length,
                  ]),
                ),
                isolatedHome: true,
                cancelConnectionClosed,
                runningEvidence,
                nativeHistoryVerified,
              },
            });
          },
        }).catch((error) => {
          throw evidence.error(error);
        });
      }
    }, 120_000);
  },
);
