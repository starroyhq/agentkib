import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeFiles from "../../../packages/backend/src/native-files";
import { canonicalize } from "../../../packages/backend/src/paths";
import {
  loadRemoteTlsIdentity,
  listenRemoteAgent,
  exchangeRemotePeer,
  restrictRemotePath,
  type RemoteTlsIdentity,
} from "../../../packages/backend/src/remote-tls";
import {
  sessionHistoryError,
  transcriptOpenError,
  TranscriptPathChangedError,
} from "../../../packages/backend/src/session-history-errors";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-remote-acl-")));
  roots.push(root);
  return root;
}
function digest(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
async function readLegacyHistoryFrame(
  viewer: RemoteTlsIdentity,
  address: string,
  hostId: string,
): Promise<unknown> {
  const [host, port] = address.split(":");
  const socket = tls.connect({
    ...viewer.clientOptions,
    host,
    port: Number(port),
    servername: "agentkib.local",
  });
  socket.setTimeout(5000, () => socket.destroy(new Error("TLS history test timed out")));
  try {
    await once(socket, "secureConnect");
    expect(digest(socket.getPeerCertificate(true).raw)).toBe(hostId);
    const data = Buffer.from(
      JSON.stringify({ version: 1, request: { op: "events", session_id: "synthetic", limit: 50 } }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    socket.write(Buffer.concat([header, data]));
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(Buffer.from(chunk));
    const frame = Buffer.concat(chunks);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    return JSON.parse(frame.subarray(4).toString("utf8")) as unknown;
  } finally {
    socket.destroy();
  }
}

function windowsAcl(file: string, isDirectory: boolean) {
  // .NET independently reads the ACL; no Koffi or product serialization is reused.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = if ($env:AGENTKIB_ACL_DIRECTORY -eq 'true') {
  [System.IO.Directory]::GetAccessControl($env:AGENTKIB_ACL_TARGET)
} else {
  [System.IO.File]::GetAccessControl($env:AGENTKIB_ACL_TARGET)
}
@{
  protected = $acl.AreAccessRulesProtected
  rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{
      ownerRights = ($_.IdentityReference.Value -eq 'S-1-3-4')
      allow = ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow)
      fullControl = ($_.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
      inherited = $_.IsInherited
      inheritance = [int]$_.InheritanceFlags
      propagation = [int]$_.PropagationFlags
    }
  })
} | ConvertTo-Json -Depth 4 -Compress
`;
  const result = spawnSync(
    path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...process.env,
        AGENTKIB_ACL_TARGET: file,
        AGENTKIB_ACL_DIRECTORY: String(isDirectory),
      },
      encoding: "utf8",
      windowsHide: true,
      // Allow cold PowerShell/.NET initialization on Windows ARM64.
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) as unknown;
}

describe("native remote identity protection", () => {
  it.each(["conflict", "unavailable", "unsupported"])(
    "preserves the safe read-state %s code across real mutual TLS",
    async (reason) => {
      const host = loadRemoteTlsIdentity(directory());
      const viewer = loadRemoteTlsIdentity(directory());
      const listener = await listenRemoteAgent(
        host,
        "127.0.0.1:0",
        async () => {
          throw new Error(`read-state-${reason}`);
        },
        { allowLoopback: true },
      );
      try {
        await expect(
          exchangeRemotePeer(
            viewer,
            listener.address,
            host.id,
            {
              op: "read-state-update",
              session_id: "synthetic",
              expectedVersion: "v1",
              seenResultId: null,
            },
            { allowLoopback: true },
          ),
        ).rejects.toThrow(`REMOTE_READ_STATE_${reason.toUpperCase()}`);
      } finally {
        await listener.close();
      }
    },
  );
  it.each([
    {
      name: "compressed transcript cache limit",
      error: () =>
        sessionHistoryError(
          new Error("TRANSCRIPT_UNREADABLE: decompressed rollout exceeds the cache limit"),
        ),
      primary: "TRANSCRIPT_UNREADABLE",
      reason: "TRANSCRIPT_SCAN_STATE_LIMIT",
    },
    {
      name: "missing paged transcript",
      error: () =>
        transcriptOpenError(Object.assign(new Error("private native details"), { code: "ENOENT" })),
      primary: "TRANSCRIPT_UNREADABLE",
      reason: "history-read-missing",
    },
    {
      name: "cursor opened against a different transcript path",
      error: () => new TranscriptPathChangedError(),
      primary: "TRANSCRIPT_CURSOR_INVALID",
      reason: "TRANSCRIPT_CURSOR_STALE",
    },
    {
      name: "plain transcript scan limit",
      error: () => new Error("TRANSCRIPT_SCAN_STATE_LIMIT"),
      primary: "TRANSCRIPT_SCAN_STATE_LIMIT",
    },
    {
      name: "classified history read error",
      error: () => sessionHistoryError(new Error("private native details")),
      primary: "request-failed",
      reason: "history-read-failed",
    },
  ])("preserves the TLS v1 error and transfers the safe reason for $name", async (fixture) => {
    const host = loadRemoteTlsIdentity(directory());
    const viewer = loadRemoteTlsIdentity(directory());
    const listener = await listenRemoteAgent(
      host,
      "127.0.0.1:0",
      async () => {
        throw fixture.error();
      },
      { allowLoopback: true },
    );
    try {
      // The v1 response reader consumes the string primary error and ignores extra fields.
      const response = await readLegacyHistoryFrame(viewer, listener.address, host.id);
      expect(response).toEqual({
        version: 1,
        error: fixture.primary,
        ...(fixture.reason ? { reason: fixture.reason } : {}),
      });
      await expect(
        exchangeRemotePeer(
          viewer,
          listener.address,
          host.id,
          { op: "events", session_id: "synthetic", limit: 50 },
          { allowLoopback: true },
        ),
      ).rejects.toMatchObject({ message: fixture.reason ?? fixture.primary });
    } finally {
      await listener.close();
    }
  });

  it("creates and reloads the same private identity without widening its permissions", () => {
    const root = directory();
    const first = loadRemoteTlsIdentity(root);
    const file = path.join(root, "remote/identity.json");
    const before = digest(readFileSync(file));
    const second = loadRemoteTlsIdentity(root);
    expect(second.id).toBe(first.id);
    expect(digest(second.privateKey)).toBe(digest(first.privateKey));
    expect(digest(readFileSync(file))).toBe(before);
    expect(readdirSync(path.dirname(file))).toEqual(["identity.json"]);
    if (process.platform === "win32") {
      for (const isDirectory of [true, false]) {
        expect(windowsAcl(isDirectory ? path.dirname(file) : file, isDirectory)).toEqual({
          protected: true,
          rules: [
            {
              ownerRights: true,
              allow: true,
              fullControl: true,
              inherited: false,
              inheritance: isDirectory ? 3 : 0,
              propagation: 0,
            },
          ],
        });
      }
    } else {
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  }, 75_000);

  it("rejects a missing target with its native error", () => {
    const file = path.join(directory(), "missing.json");
    if (process.platform === "win32")
      expect(() => restrictRemotePath(file)).toThrow("Cannot protect remote identity (2)");
    else
      expect(() => restrictRemotePath(file)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it.skipIf(process.platform !== "win32")(
    "captures the failing Win32 error before freeing the descriptor",
    () => {
      let lastError = 5;
      const ffi = {
        pointer: () => "void **",
        out: (value: unknown) => value,
        load: () => ({
          func: (_callingConvention: string, name: string) => {
            if (name === "ConvertStringSecurityDescriptorToSecurityDescriptorW")
              return (_sddl: string, _revision: number, output: unknown[]) => {
                output[0] = {};
                return 1;
              };
            if (name === "SetFileSecurityW") return () => 0;
            if (name === "GetLastError") return () => lastError;
            if (name === "LocalFree")
              return () => {
                lastError = 87;
                return null;
              };
            throw new Error(`Unexpected API: ${name}`);
          },
        }),
      };
      vi.spyOn(nativeFiles, "nativeBindings").mockReturnValue(
        ffi as unknown as ReturnType<typeof nativeFiles.nativeBindings>,
      );
      expect(() => restrictRemotePath("synthetic-target")).toThrow(
        "Cannot protect remote identity (5)",
      );
      expect(lastError).toBe(87);
    },
  );
});
