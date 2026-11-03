import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeFiles from "../../../packages/backend/src/native-files";
import { canonicalize } from "../../../packages/backend/src/paths";
import {
  loadRemoteTlsIdentity,
  listenRemoteAgent,
  exchangeRemotePeer,
  restrictRemotePath,
} from "../../../packages/backend/src/remote-tls";

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
