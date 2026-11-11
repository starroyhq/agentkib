// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactService, parseByteRange, type ArtifactScope } from "./artifacts";

describe("authorized project artifacts", () => {
  let directory: string, root: string, outside: string, origin: string;
  let server: Server, service: ArtifactService;
  let epoch: string, now: number;
  const scope: ArtifactScope = { deviceId: "phone", workspaceId: "project", sessionId: "session" };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentkib-artifacts-"));
    root = join(directory, "project");
    outside = join(directory, "outside.txt");
    await mkdir(root);
    await writeFile(outside, "outside secret");
    epoch = "first-grant";
    now = 1_000_000;
    server = createServer((req, res) => {
      void service.handle(req, res);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    service = new ArtifactService({
      previewOrigin: origin,
      appOrigin: "http://localhost:1422",
      allowHttpLoopback: true,
      now: () => now,
      authorize: async (requested) => {
        if (requested.deviceId !== "phone" || requested.workspaceId !== "project")
          throw new Error("denied");
        return { root, epoch };
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    service.clear();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  });
  async function http(url: string, headers: Record<string, string> = {}, method = "GET") {
    const path = url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url;
    return new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: Buffer;
    }>((done, fail) => {
      const req = request(
        { hostname: "127.0.0.1", port: new URL(origin).port, path, method, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", fail);
          response.on("end", () =>
            done({
              status: response.statusCode!,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", fail);
      req.end();
    });
  }
  async function entry(name: string) {
    const found = (await service.list(scope)).entries.find((item) => item.name === name);
    expect(found).toBeDefined();
    return found!;
  }
  it("limits large transfers per device and globally, with slots released on disconnect", async () => {
    service.clear();
    service = new ArtifactService({
      previewOrigin: origin,
      appOrigin: "http://localhost:1422",
      allowHttpLoopback: true,
      bytesPerSecond: 64 * 1024,
      maxTransfers: 2,
      maxDeviceTransfers: 1,
      authorize: async () => ({ root, epoch }),
    });
    await writeFile(join(root, "large.mp4"), Buffer.alloc(1024 * 1024, 1));
    const issue = async (deviceId: string) => {
      const requested = { ...scope, deviceId };
      const file = (await service.list(requested)).entries[0];
      return service.issueTicket(requested, { artifactId: file.id });
    };
    const first = await issue("phone");
    const second = await issue("phone2");
    const third = await issue("phone3");
    const controller = new AbortController();
    const active = await fetch(first.url, { signal: controller.signal });
    expect(active.status).toBe(200);
    const busy = await fetch(first.url);
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    await busy.arrayBuffer();
    const secondController = new AbortController();
    const secondRequest = fetch(second.url, { signal: secondController.signal });
    // The second request has headers but its first chunk shares the same limiter.
    await new Promise((done) => setTimeout(done, 40));
    const globallyBusy = await fetch(third.url);
    expect(globallyBusy.status).toBe(429);
    await globallyBusy.arrayBuffer();
    controller.abort();
    secondController.abort();
    await secondRequest.catch(() => undefined);
    await active.body?.cancel().catch(() => undefined);
    await new Promise((done) => setTimeout(done, 40));
    const head = await fetch(first.url, { method: "HEAD" });
    expect(head.status).toBe(200);
  });
  it("lists opaque scoped ids and hides sensitive, linked and special paths", async () => {
    await writeFile(join(root, "report.txt"), "safe");
    await writeFile(join(root, ".env"), "KEY=secret");
    await writeFile(join(root, "private-key.pem"), "secret");
    await mkdir(join(root, "images"));
    await symlink(outside, join(root, "escape.txt"));
    await link(outside, join(root, "hardlink.txt"));
    const listing = await service.list(scope);
    expect(listing.entries.map((item) => item.name)).toEqual(["images", "report.txt"]);
    expect(listing.entries[1].id).toMatch(/^[\w-]{32}$/);
    expect(JSON.stringify(listing)).not.toContain(root);
    const text = await service.readText(scope, listing.entries[1].id);
    expect(text.text).toBe("safe");
    await expect(service.readText({ ...scope, sessionId: "other" }, text.id)).rejects.toMatchObject(
      { code: "artifact_not_found" },
    );
    const child = await service.list(scope, listing.entries[0].id);
    expect(child.parentId).toBe(listing.directoryId);
  });
  it("keeps listing after handing out its limit of ids and forgets the least recently used", async () => {
    service = new ArtifactService({
      previewOrigin: origin,
      appOrigin: "http://localhost:1422",
      allowHttpLoopback: true,
      now: () => now,
      maxRecords: 6,
      authorize: async () => ({ root, epoch }),
    });
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"])
      await writeFile(join(root, name), name);
    await mkdir(join(root, "sub"));
    for (const name of ["x.txt", "y.txt"]) await writeFile(join(root, "sub", name), name);
    // Four files, the subdirectory and the directory itself fill the limit.
    const top = await service.list(scope);
    const id = (name: string) => top.entries.find((item) => item.name === name)!.id;
    expect((await service.readText(scope, id("a.txt"))).text).toBe("a.txt");
    // Two new ids make the least recently used ones go: b.txt and c.txt, not a.txt just read.
    const sub = await service.list(scope, id("sub"));
    expect(sub.parentId).toBe(top.directoryId);
    for (const name of ["b.txt", "c.txt"])
      await expect(service.readText(scope, id(name))).rejects.toMatchObject({
        code: "artifact_not_found",
      });
    expect((await service.readText(scope, id("a.txt"))).text).toBe("a.txt");
    const x = sub.entries.find((item) => item.name === "x.txt")!;
    expect((await service.readText(scope, x.id)).text).toBe("x.txt");
    // Listing again hands out a working id instead of refusing.
    const again = await service.list(scope);
    const b = again.entries.find((item) => item.name === "b.txt")!;
    expect((await service.readText(scope, b.id)).text).toBe("b.txt");
  });
  it("bounds queued small responses and releases their slots on disconnect", async () => {
    service.clear();
    service = new ArtifactService({
      previewOrigin: origin,
      appOrigin: "http://localhost:1422",
      allowHttpLoopback: true,
      bytesPerSecond: 8192,
      maxPreviewRequests: 1,
      maxDeviceRequests: 1,
      authorize: async () => ({ root, epoch }),
    });
    await writeFile(join(root, "small.txt"), Buffer.alloc(64 * 1024, 1));
    const ticket = await service.issueTicket(scope, { artifactId: (await entry("small.txt")).id });
    await (await fetch(ticket.url)).arrayBuffer();
    const controller = new AbortController();
    const waiting = fetch(ticket.url, { signal: controller.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const rejected = await fetch(ticket.url);
    expect(rejected.status).toBe(429);
    expect((await rejected.json()).code).toBe("artifact_request_limit");
    controller.abort();
    await waiting;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await fetch(ticket.url, { method: "HEAD" })).status).toBe(200);
  });
  it("interrupts a throttled HTML snapshot when its workspace authorization changes", async () => {
    service.clear();
    service = new ArtifactService({
      previewOrigin: origin,
      appOrigin: "http://localhost:1422",
      allowHttpLoopback: true,
      bytesPerSecond: 64 * 1024,
      now: () => now,
      authorize: async () => ({ root, epoch }),
    });
    await writeFile(join(root, "index.html"), "a".repeat(256 * 1024));
    const ticket = await service.issueTicket(scope, { artifactId: (await entry("index.html")).id });
    const response = await fetch(ticket.url);
    const body = response.arrayBuffer();
    epoch = "workspace-removed";
    now += 1001;
    await expect(body).rejects.toThrow();
  });
  it("resolves only existing allowed references and never expands the granted root", async () => {
    await writeFile(join(root, "plot.png"), "png");
    await writeFile(join(root, ".env"), "secret");
    const results = await service.resolveReferences(scope, [
      "plot.png",
      join(root, "plot.png"),
      outside,
      "../outside.txt",
      ".env",
      "https://example.com/plot.png",
      "missing.png",
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ mime: "image/png", previewKind: "image", size: 3 });
    expect(results[0].id).toBe(results[1].id);
  });
  it("rejects agent credentials and raw history even when their parent is explicitly authorized", async () => {
    root = join(directory, ".codex");
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "auth.json"), "private auth");
    await writeFile(join(root, "token.json"), "private token");
    await writeFile(join(root, "history.jsonl"), "private history");
    await writeFile(join(root, "sessions", "rollout-one.jsonl"), "private rollout");
    await writeFile(join(root, "report.txt"), "ordinary report");
    await writeFile(join(root, "config.toml"), '[mcp_servers.test.env]\nAPI_KEY="fixture-secret"');
    await expect(service.list(scope)).rejects.toMatchObject({ code: "artifact_sensitive_path" });
    await expect(
      service.resolveReferences(scope, ["config.toml", "auth.json", "report.txt"]),
    ).rejects.toMatchObject({ code: "artifact_sensitive_path" });
    root = join(root, "sessions");
    await expect(service.list(scope)).rejects.toMatchObject({ code: "artifact_sensitive_path" });
  });
  it("supports an explicitly registered project in .codex/worktrees without exposing credentials", async () => {
    root = join(directory, ".codex", "worktrees", "project");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "report.txt"), "worktree report");
    await writeFile(join(root, "auth.json"), "private auth");
    const found = await entry("report.txt");
    expect((await service.readText(scope, found.id)).text).toBe("worktree report");
    expect((await service.list(scope)).entries.map((item) => item.name)).toEqual(["report.txt"]);
  });
  it("rechecks grants, revision and symlink substitutions after discovery", async () => {
    await writeFile(join(root, "report.txt"), "one");
    const found = await entry("report.txt");
    await writeFile(join(root, "report.txt"), "replacement content");
    await expect(service.readText(scope, found.id, found.revision)).rejects.toMatchObject({
      code: "artifact_changed",
    });
    await rm(join(root, "report.txt"));
    await symlink(outside, join(root, "report.txt"));
    await expect(service.readText(scope, found.id)).rejects.toMatchObject({
      code: "artifact_path_denied",
    });
    epoch = "revoked-and-regranted";
    await expect(
      service.list(scope, (await service.list(scope)).directoryId),
    ).resolves.toBeDefined();
    await expect(service.readText(scope, found.id)).rejects.toMatchObject({
      code: "artifact_access_changed",
    });
  });
  it("denies renamed directory substitutions and bounds text decoding", async () => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "report.txt"), "safe");
    const references = await service.resolveReferences(scope, ["docs/report.txt"]);
    await rm(join(root, "docs"), { recursive: true });
    await symlink(directory, join(root, "docs"));
    await expect(service.readText(scope, references[0].id)).rejects.toMatchObject({
      code: "artifact_path_denied",
    });
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xff]));
    await expect(service.readText(scope, (await entry("invalid.txt")).id)).rejects.toMatchObject({
      code: "artifact_invalid_utf8",
    });
    await writeFile(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1));
    await expect(service.readText(scope, (await entry("large.txt")).id)).rejects.toMatchObject({
      code: "artifact_too_large",
    });
  });
  it("serves native single-range media without cookies or Authorization", async () => {
    await writeFile(join(root, "movie.mp4"), "0123456789");
    const ticket = await service.issueTicket(scope, { artifactId: (await entry("movie.mp4")).id });
    const result = await http(ticket.url, { Range: "bytes=0-1" });
    expect(result.status).toBe(206);
    expect(result.body.toString()).toBe("01");
    expect(result.headers["content-range"]).toBe("bytes 0-1/10");
    expect(result.headers["content-length"]).toBe("2");
    expect(result.headers["accept-ranges"]).toBe("bytes");
    expect((await http(ticket.url, { Range: "bytes=7-" })).body.toString()).toBe("789");
    expect((await http(ticket.url, { Range: "bytes=-3" })).body.toString()).toBe("789");
    const invalid = await http(ticket.url, { Range: "bytes=10-" });
    expect(invalid.status).toBe(416);
    expect(invalid.headers["content-range"]).toBe("bytes */10");
    expect((await http(ticket.url, { Range: "bytes=0-1,4-5" })).status).toBe(416);
    const head = await http(ticket.url, { Range: "bytes=0-1" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe("10");
    expect(head.body.length).toBe(0);
    const changed = await http(ticket.url, { Range: "bytes=0-1", "If-Range": '"stale"' });
    expect(changed.status).toBe(200);
    expect(changed.body.length).toBe(10);
    const matched = await http(ticket.url, {
      Range: "bytes=0-1",
      "If-Range": result.headers.etag!,
    });
    expect(matched.status).toBe(206);
  });
  it("denies expired, revoked, changed and wrong-origin tickets", async () => {
    await writeFile(join(root, "file.txt"), "original");
    const id = (await entry("file.txt")).id;
    const ticket = await service.issueTicket(scope, { artifactId: id, ttlMs: 1000 });
    expect((await http(ticket.url, { Origin: "https://attacker.example" })).status).toBe(403);
    expect((await http(ticket.url, { Host: "attacker.example" })).status).toBe(403);
    expect((await http(ticket.url, {}, "POST")).status).toBe(405);
    now += 1000;
    expect((await http(ticket.url)).status).toBe(410);
    const changed = await service.issueTicket(scope, { artifactId: id });
    await writeFile(join(root, "file.txt"), "new revision");
    expect((await http(changed.url)).status).toBe(409);
    const revoked = await service.issueTicket(scope, { artifactId: id });
    service.revokeDevice("phone");
    expect((await http(revoked.url)).status).toBe(410);
  });
  it("only identifies exact unexpired ticket URLs for their issuing device", async () => {
    await writeFile(join(root, "file.txt"), "download");
    const ticket = await service.issueTicket(scope, {
      artifactId: (await entry("file.txt")).id,
      ttlMs: 1000,
    });
    expect(service.ownsTicketUrl("phone", ticket.url)).toBe(true);
    expect(service.ownsTicketUrl("desktop-local", ticket.url)).toBe(false);
    expect(service.ownsTicketUrl("phone", ticket.url + "?redirect=other")).toBe(false);
    expect(service.ownsTicketUrl("phone", ticket.url.replace("file.txt", "other.txt"))).toBe(false);
    expect(service.ownsTicketUrl("phone", ticket.url.replace(origin, "https://example.com"))).toBe(
      false,
    );
    now += 1000;
    expect(service.ownsTicketUrl("phone", ticket.url)).toBe(false);
  });
  it("snapshots a bounded HTML bundle, keeps relative resources and isolates script execution", async () => {
    await mkdir(join(root, "site", "assets"), { recursive: true });
    await writeFile(
      join(root, "site", "index.html"),
      '<script src="assets/app.js"></script><img src="assets/plot.png">',
    );
    await writeFile(join(root, "site", "assets", "app.js"), "document.body.dataset.ready='yes'");
    await writeFile(join(root, "site", "assets", "plot.png"), "original png");
    await writeFile(join(root, "site", ".env"), "secret");
    await writeFile(join(root, "unrelated.txt"), "private outside bundle");
    const [found] = await service.resolveReferences(scope, ["site/index.html"]);
    const ticket = await service.issueTicket(scope, { artifactId: found.id });
    expect(ticket.sourceRevision).toBe(found.revision);
    expect(ticket.revision).not.toBe(ticket.sourceRevision);
    expect(ticket.manifest?.map((item) => item.path)).toEqual([
      "assets/app.js",
      "assets/plot.png",
      "index.html",
    ]);
    const html = await http(ticket.url);
    expect(html.status).toBe(200);
    expect(html.headers["content-security-policy"]).toContain("sandbox allow-scripts;");
    expect(html.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(html.headers["content-security-policy"]).toContain(
      "frame-ancestors http://localhost:1422",
    );
    const base = ticket.url.replace(/index\.html$/, "");
    const js = await http(base + "assets/app.js?v=1", { Origin: "null" });
    expect(js.status).toBe(200);
    expect(js.headers["access-control-allow-origin"]).toBe("null");
    expect(js.headers["access-control-allow-credentials"]).toBeUndefined();
    await writeFile(join(root, "site", "assets", "plot.png"), "changed png");
    expect((await http(base + "assets/plot.png")).body.toString()).toBe("original png");
    expect((await http(base + "unrelated.txt")).status).toBe(404);
    expect((await http(base + ".env")).status).toBe(403);
    const traversal = new URL(base).pathname + "%2e%2e/unrelated.txt";
    expect((await http(traversal)).status).toBe(403);
    epoch = "workspace-removed";
    expect((await http(ticket.url)).status).toBe(403);
  });
  it("returns the actual HTML entry snapshot revision when it changes during bundle preparation", async () => {
    await writeFile(join(root, "index.html"), "old entry");
    const found = await entry("index.html");
    const internal = service as unknown as {
      snapshot(...args: unknown[]): Promise<{ bytes: Buffer; revision: string }>;
    };
    const original = internal.snapshot.bind(service);
    let capturedRevision = "";
    vi.spyOn(internal, "snapshot").mockImplementationOnce(async (...args) => {
      await writeFile(join(root, "index.html"), "new entry captured in the snapshot");
      const result = await original(...args);
      capturedRevision = result.revision;
      return result;
    });
    const ticket = await service.issueTicket(scope, { artifactId: found.id });
    expect(ticket.sourceRevision).toBe(capturedRevision);
    expect(ticket.sourceRevision).not.toBe(found.revision);
    expect(ticket.revision).not.toBe(ticket.sourceRevision);
    expect((await http(ticket.url)).body.toString()).toBe("new entry captured in the snapshot");
    await expect(
      service.issueTicket(scope, {
        artifactId: found.id,
        expectedRevision: found.revision,
      }),
    ).rejects.toMatchObject({ status: 409, code: "artifact_changed" });
  });
  it("rejects a changed entry during snapshot preparation when its revision was required", async () => {
    await writeFile(join(root, "index.html"), "original");
    const found = await entry("index.html");
    const internal = service as unknown as {
      snapshot(...args: unknown[]): Promise<{ bytes: Buffer; revision: string }>;
    };
    const original = internal.snapshot.bind(service);
    vi.spyOn(internal, "snapshot").mockImplementationOnce(async (...args) => {
      await writeFile(join(root, "index.html"), "changed while walking the bundle");
      return original(...args);
    });
    await expect(
      service.issueTicket(scope, {
        artifactId: found.id,
        expectedRevision: found.revision,
      }),
    ).rejects.toMatchObject({ status: 409, code: "artifact_changed" });
  });
  it("rejects escaping symlinks and excess bundle files rather than publishing them", async () => {
    await mkdir(join(root, "site"));
    await writeFile(join(root, "site", "index.html"), "ok");
    await symlink(outside, join(root, "site", "data.txt"));
    const [found] = await service.resolveReferences(scope, ["site/index.html"]);
    await expect(service.issueTicket(scope, { artifactId: found.id })).rejects.toMatchObject({
      code: "artifact_path_denied",
    });
    await rm(join(root, "site", "data.txt"));
    await Promise.all(
      Array.from({ length: 256 }, (_, n) => writeFile(join(root, "site", `a${n}.txt`), "x")),
    );
    await expect(service.issueTicket(scope, { artifactId: found.id })).rejects.toMatchObject({
      code: "artifact_bundle_too_large",
    });
  });
  it("downloads HTML without publishing siblings and forces unknown formats to download", async () => {
    await writeFile(join(root, "index.html"), "<script>alert(1)</script>");
    await writeFile(join(root, "deck.pptx"), "office");
    const download = await service.issueTicket(scope, {
      artifactId: (await entry("index.html")).id,
      download: true,
    });
    expect(download.manifest).toBeUndefined();
    expect((await http(download.url)).headers["content-disposition"]).toMatch(/^attachment;/);
    const office = await service.issueTicket(scope, { artifactId: (await entry("deck.pptx")).id });
    expect((await http(office.url)).headers["content-disposition"]).toMatch(/^attachment;/);
    const preflight = await http(
      office.url,
      {
        Origin: "http://localhost:1422",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "range, if-range",
      },
      "OPTIONS",
    );
    expect(preflight.status).toBe(204);
    expect(
      (
        await http(
          office.url,
          { Origin: "null", "Access-Control-Request-Method": "POST" },
          "OPTIONS",
        )
      ).status,
    ).toBe(403);
    service.setOrigins("http://localhost:1423", origin);
    expect((await http(office.url)).status).toBe(410);
  });
  it("cancels an active large media stream when its device is revoked", async () => {
    await writeFile(join(root, "large.mp4"), Buffer.alloc(8 * 1024 * 1024, 7));
    const ticket = await service.issueTicket(scope, { artifactId: (await entry("large.mp4")).id });
    await new Promise<void>((done, fail) => {
      const req = request(ticket.url, (response) => {
        response.pause();
        response.on("aborted", done);
        response.on("error", () => {});
        service.revokeDevice("phone");
        response.resume();
        response.on("end", () => fail(new Error("revoked stream completed")));
      });
      req.on("error", fail);
      req.end();
    });
  });
  it("requires an isolated trustworthy preview origin", () => {
    const authorize = async () => ({ root, epoch });
    expect(
      () =>
        new ArtifactService({
          appOrigin: "https://example.com",
          previewOrigin: "https://example.com",
          authorize,
        }),
    ).toThrow("artifact_origin_must_be_isolated");
    expect(
      () =>
        new ArtifactService({
          appOrigin: "https://example.com",
          previewOrigin: "http://192.168.1.2:9999",
          allowHttpLoopback: true,
          authorize,
        }),
    ).toThrow("invalid_artifact_origin");
    expect(
      () =>
        new ArtifactService({
          appOrigin: "https://example.com",
          previewOrigin: "https://preview.example.com/path",
          authorize,
        }),
    ).toThrow("invalid_artifact_origin");
  });
  it("allows only explicitly configured additional application origins and revokes old tickets on change", async () => {
    await writeFile(join(root, "index.html"), "<button>local preview</button>");
    service.setOrigins("https://control.example", origin, ["http://127.0.0.1:1422"]);
    const ticket = await service.issueTicket(scope, { artifactId: (await entry("index.html")).id });
    const allowed = await http(ticket.url, { Origin: "http://127.0.0.1:1422" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:1422");
    expect(allowed.headers["content-security-policy"]).toContain(
      "frame-ancestors https://control.example http://127.0.0.1:1422",
    );
    expect(allowed.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect((await http(ticket.url, { Origin: "http://localhost:1422" })).status).toBe(403);
    expect((await http(ticket.url, { Origin: "https://attacker.example" })).status).toBe(403);
    expect(() => service.setOrigins("https://control.example", origin, [origin])).toThrow(
      "artifact_origin_must_be_isolated",
    );
    expect(() => service.setOrigins("https://control.example", origin, ["*"])).toThrow();
    expect(
      () =>
        new ArtifactService({
          appOrigin: "https://control.example",
          previewOrigin: "https://preview.example",
          additionalAppOrigins: ["http://127.0.0.1:1422"],
          authorize: async () => ({ root, epoch }),
        }),
    ).toThrow("invalid_artifact_origin");
    service.setOrigins("https://control.example", origin);
    expect((await http(ticket.url)).status).toBe(410);
  });
  it("honors explicit bundle roots and reports byte limits without publishing a ticket", async () => {
    await mkdir(join(root, "site", "pages"), { recursive: true });
    await mkdir(join(root, "other"));
    await writeFile(join(root, "site", "pages", "index.html"), "<h1>hello</h1>");
    await writeFile(join(root, "site", "style.css"), "h1 {color:red}");
    const [html] = await service.resolveReferences(scope, ["site/pages/index.html"]);
    await expect(
      service.issueTicket(scope, { artifactId: html.id, bundleRootId: (await entry("other")).id }),
    ).rejects.toMatchObject({ code: "artifact_bundle_denied" });
    const ticket = await service.issueTicket(scope, {
      artifactId: html.id,
      bundleRootId: (await entry("site")).id,
    });
    expect(new URL(ticket.url).pathname).toMatch(/\/pages\/index.html$/);
    expect(ticket.manifest?.map((file) => file.path)).toEqual(["pages/index.html", "style.css"]);
    const limited = new ArtifactService({
      previewOrigin: origin,
      appOrigin: "http://localhost:1422",
      allowHttpLoopback: true,
      authorize: async () => ({ root, epoch }),
      maxBundleBytes: 5,
    });
    const [small] = await limited.resolveReferences(scope, ["site/pages/index.html"]);
    await expect(limited.issueTicket(scope, { artifactId: small.id })).rejects.toMatchObject({
      code: "artifact_too_large",
    });
    limited.clear();
  });
});

describe("byte-range parsing", () => {
  it.each([
    ["bytes=0-1", 10, { start: 0, end: 1 }],
    ["bytes=8-100", 10, { start: 8, end: 9 }],
    ["bytes=-100", 10, { start: 0, end: 9 }],
    ["bytes=9-", 10, { start: 9, end: 9 }],
  ] as const)("accepts %s", (value, size, expected) => {
    expect(parseByteRange(value, size)).toEqual(expected);
  });
  it.each([
    "bytes=-0",
    "bytes=-",
    "bytes=10-",
    "bytes=3-2",
    "bytes=0-0,2-2",
    "bytes=9999999999999999999-",
    "items=0-1",
  ])("rejects %s", (value) => {
    expect(() => parseByteRange(value, 10)).toThrow("artifact_invalid_range");
  });
  it("rejects a range of an empty file", () => {
    expect(() => parseByteRange("bytes=0-", 0)).toThrow("artifact_invalid_range");
  });
});
