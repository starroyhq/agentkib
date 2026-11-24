// @vitest-environment node
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SESSION_ATTACHMENT_LIMITS } from "@agentkib/runtime-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readClipboardAttachments } from "./clipboard-attachments";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agentkib-clipboard-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function uriItem(...uris: string[]) {
  return {
    types: ["text/uri-list"],
    getType: vi.fn(async () => new Blob([uris.join("\r\n")])),
  };
}

it("reads Finder file references in order, with a detected screenshot MIME and no host paths", async () => {
  const image = path.join(root, "a screenshot.png");
  const document = path.join(root, "notes [draft].txt");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(image, png);
  await writeFile(document, "notes");
  const files = await readClipboardAttachments([
    uriItem("# clipboard", pathToFileURL(image).href, pathToFileURL(document).href),
  ]);
  expect(files).toEqual([
    { mime: "image/png", name: "a screenshot.png", bytes: png },
    { mime: "application/octet-stream", name: "notes [draft].txt", bytes: Buffer.from("notes") },
  ]);
});

it("ignores ordinary clipboard text and remote links", async () => {
  const getType = vi.fn(async () => new Blob([path.join(root, "notes.txt")]));
  expect(await readClipboardAttachments([{ types: ["text/plain"], getType }])).toBeUndefined();
  expect(getType).not.toHaveBeenCalled();
  expect(await readClipboardAttachments([uriItem("https://example.test/file")])).toBeUndefined();
});

it("rejects directories, empty files, oversized files and non-local file URLs", async () => {
  const empty = path.join(root, "empty");
  const large = path.join(root, "large");
  await writeFile(empty, "");
  await writeFile(large, "");
  await truncate(large, SESSION_ATTACHMENT_LIMITS.fileBytes + 1);
  for (const url of [
    pathToFileURL(root).href,
    pathToFileURL(empty).href,
    pathToFileURL(large).href,
    "file://example.test/untrusted",
  ]) {
    expect(await readClipboardAttachments([uriItem(url)])).toEqual([]);
  }
});

it.skipIf(process.platform === "win32")("does not dereference a copied symlink", async () => {
  const file = path.join(root, "real");
  const link = path.join(root, "link");
  await writeFile(file, "text");
  await symlink(file, link);
  expect(await readClipboardAttachments([uriItem(pathToFileURL(link).href)])).toEqual([]);
});
