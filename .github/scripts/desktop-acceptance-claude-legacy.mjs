import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, readFile, realpath } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptanceClaudeSocket } from "./desktop-acceptance-launch.mjs";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function childOf(directory, entry) {
  return entry.startsWith(directory + path.sep);
}

async function post(socketPath, endpoint, payload, signal, token) {
  const body = JSON.stringify(payload);
  const response = await new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        path: endpoint,
        method: "POST",
        headers: {
          Host: "localhost",
          Connection: "close",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal,
      },
      resolve,
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
  assert.equal(response.statusCode, 200, `Synthetic Claude bridge ${endpoint} was rejected`);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

/**
 * The caller primes an ordinary read cursor in the isolated app, then leaves the
 * target session. This drives its next terminal turn through the packaged host.
 */
export async function notifyLegacyClaudeTurn({
  data,
  home,
  transcriptPath,
  workspace,
  nativeId,
  startedAt,
  endedAt,
  signal,
  agentkibHome = path.join(home, "library"),
}) {
  const deadline = AbortSignal.timeout(12_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const [sandboxHome, socketTemp, systemTemp] = await Promise.all([
    realpath(home),
    realpath("/tmp"),
    realpath(tmpdir()),
  ]);
  const sandbox = path.dirname(sandboxHome);
  assert.ok(
    childOf(socketTemp, sandbox) || childOf(systemTemp, sandbox),
    "Claude bridge fixture requires a temporary sandbox",
  );
  const [dataDir, cwd, transcript, broker, discoveryFile] = await Promise.all([
    realpath(data),
    realpath(workspace),
    realpath(transcriptPath),
    realpath(path.join(data, "claude-bridge")),
    realpath(path.join(agentkibHome, "claude-bridge", "auto-v1.json")),
  ]);
  assert.ok(
    [dataDir, cwd, transcript, broker, discoveryFile].every((entry) => childOf(sandbox, entry)),
  );
  assert.ok(childOf(sandboxHome, transcript));
  assert.ok(childOf(dataDir, broker));
  assert.match(nativeId, uuid);
  assert.equal(path.basename(transcript), `${nativeId}.jsonl`);

  const info = await lstat(transcript);
  assert.ok(info.isFile() && info.nlink === 1 && info.size < 4 * 1024 * 1024);
  const rows = await readFile(transcript, { encoding: "utf8", signal: requestSignal });
  const last = JSON.parse(rows.trimEnd().split("\n").at(-1));
  assert.equal(last.sessionId, nativeId);
  assert.equal(last.cwd, cwd);
  assert.match(last.uuid, uuid);
  const previousEnd = Date.parse(last.timestamp);
  const turnStart = startedAt ?? Math.max(previousEnd + 1, Date.now() - 500);
  const turnEnd = endedAt ?? turnStart + 400;
  assert.ok(Number.isSafeInteger(turnStart) && Number.isSafeInteger(turnEnd));
  assert.ok(previousEnd < turnStart && turnStart + 2 < turnEnd);

  const discoveryInfo = await lstat(discoveryFile);
  assert.ok(discoveryInfo.isFile() && discoveryInfo.nlink === 1 && discoveryInfo.size <= 4096);
  assert.equal(discoveryInfo.mode & 0o777, 0o600);
  const discovery = JSON.parse(
    await readFile(discoveryFile, { encoding: "utf8", signal: requestSignal }),
  );
  const socketPath = acceptanceClaudeSocket(dataDir);
  assert.ok(
    discovery.protocol === 1 &&
      discovery.socketPath === socketPath &&
      /^[0-9a-f]{64}$/.test(discovery.autoKey),
    "Unexpected sandbox Claude bridge discovery",
  );
  const socket = await lstat(socketPath);
  assert.ok(socket.isSocket() && (socket.mode & 0o777) === 0o600);

  const hello = {
    protocol: 1,
    nativeId,
    cwd,
    cliVersion: "2.1.301",
    pluginVersion: "0.5.12",
    instanceId: randomUUID(),
    nativeCapabilities: {
      version: 1,
      available: [
        "session-identity",
        "session-messages",
        "session-usage",
        "credential-store",
        "credential-read",
      ],
    },
  };
  const connected = await post(
    socketPath,
    "/v1/auto-pair",
    { ...hello, autoKey: discovery.autoKey },
    requestSignal,
  );
  assert.match(connected.bindingId, uuid);
  assert.match(connected.leaseId, uuid);
  assert.ok(/^[0-9a-f]{64}$/.test(connected.token), "Missing synthetic lease token");
  const lease = {
    bindingId: connected.bindingId,
    leaseId: connected.leaseId,
    instanceId: hello.instanceId,
    nativeId,
    cwd,
  };
  let seq = 0;
  const send = async (event) => {
    seq++;
    const accepted = await post(
      socketPath,
      "/v1/events",
      { ...lease, events: [{ seq, event }] },
      requestSignal,
      connected.token,
    );
    assert.equal(accepted.ackSeq, seq);
  };
  await send({
    type: "snapshot",
    snapshot: {
      ...hello,
      revision: 1,
      currentTurnId: null,
      status: "idle",
      waiting: null,
      messages: [],
      toolItems: [],
      streamText: "",
      usage: null,
      outbox: [],
      capabilities: {
        read: true,
        send: true,
        steer: true,
        queue: true,
        stop: true,
        approve: false,
        answer: false,
      },
    },
  });

  const turnId = randomUUID();
  await send({ type: "turn-start", turnId, revision: 2 });
  const text = "Isolated Claude replied to the legacy Worker report.";
  const reportId = randomUUID();
  const promptId = randomUUID();
  const itemId = randomUUID();
  const terminalId = randomUUID();
  const row = (type, id, parentUuid, timestamp, body) =>
    JSON.stringify({
      type,
      uuid: id,
      parentUuid,
      sessionId: nativeId,
      cwd,
      timestamp: new Date(timestamp).toISOString(),
      isSidechain: false,
      ...body,
    });
  await appendFile(
    transcript,
    [
      row("user", promptId, last.uuid, turnStart, {
        isMeta: true,
        origin: { kind: "plugin", name: "agentkib-bridge" },
        userType: "external",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: `[AgentKib report] Worker finished the isolated check.\n\n[AgentKib report ID: ${reportId}]`,
            },
          ],
        },
      }),
      row("assistant", itemId, promptId, turnEnd - 2, {
        message: {
          role: "assistant",
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text }],
        },
      }),
      row("system", terminalId, itemId, turnEnd - 1, {
        subtype: "turn_duration",
        durationMs: turnEnd - turnStart - 1,
      }),
    ].join("\n") + "\n",
  );
  // The native transcript has a visible assistant UUID, but this old completion
  // has only the plugin's independent turn UUID. Let the host write its own result.
  await send({
    type: "turn-complete",
    turnId,
    text,
    aborted: false,
    revision: 3,
    startedAt: turnStart,
    occurredAt: turnEnd,
  });
  return { bridgeResultId: `turn:${turnId}`, turnId, itemId, text };
}
