// @vitest-environment node
import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SESSION_IMAGE_BYTES } from "../../../packages/backend/src/session-images";
import {
  readSentAttachmentImage,
  sentAttachmentFileAvailable,
  type SentAttachmentFile,
} from "../../../packages/backend/src/session-sent-attachment-files";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
  "base64",
);

let root: string;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agentkib-sent-attachment-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(bytes = png): SentAttachmentFile {
  const directory = join(root, "attachments");
  const filename = "fixture.png";
  mkdirSync(directory);
  writeFileSync(join(directory, filename), bytes);
  const metadata = lstatSync(directory, { bigint: true });
  return {
    directory,
    filename,
    size: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
    mimeType: "image/png",
    directoryIdentity: { dev: String(metadata.dev), ino: String(metadata.ino) },
  };
}

describe("sent attachment files", () => {
  it("reads the verified raster image and stops when the file disappears", () => {
    const file = fixture();
    expect(sentAttachmentFileAvailable(file)).toBe(true);
    expect(readSentAttachmentImage(file)).toEqual({
      mimeType: "image/png",
      base64: png.toString("base64"),
    });
    rmSync(join(file.directory, file.filename));
    expect(sentAttachmentFileAvailable(file)).toBe(false);
    expect(() => readSentAttachmentImage(file)).toThrow("session-image-unavailable");
  });

  it("keeps a different directory or a non-leaf filename outside the read boundary", () => {
    const file = fixture();
    const changed = {
      ...file,
      directoryIdentity: {
        ...file.directoryIdentity!,
        ino: String(BigInt(file.directoryIdentity!.ino) + 1n),
      },
    };
    writeFileSync(join(root, file.filename), png);
    for (const candidate of [changed, { ...file, filename: `../${file.filename}` }]) {
      expect(sentAttachmentFileAvailable(candidate)).toBe(false);
      expect(() => readSentAttachmentImage(candidate)).toThrow("session-image-unavailable");
    }
  });

  it.skipIf(process.platform === "win32")("does not follow a file or directory symlink", () => {
    const file = fixture();
    const linked = join(root, "linked");
    symlinkSync(file.directory, linked, "dir");
    const linkedChild = join(file.directory, "nested");
    mkdirSync(linkedChild);
    writeFileSync(join(linkedChild, file.filename), png);
    const directoryLink = { ...file, directory: linked };
    const ancestorLink = {
      ...file,
      directory: join(linked, "nested"),
      directoryIdentity: undefined,
    };
    for (const candidate of [directoryLink, ancestorLink]) {
      expect(sentAttachmentFileAvailable(candidate)).toBe(false);
      expect(() => readSentAttachmentImage(candidate)).toThrow("session-image-unavailable");
    }

    writeFileSync(join(root, file.filename), png);
    rmSync(join(file.directory, file.filename));
    symlinkSync(join(root, file.filename), join(file.directory, file.filename));
    expect(sentAttachmentFileAvailable(file)).toBe(false);
    expect(() => readSentAttachmentImage(file)).toThrow("session-image-unavailable");
  });

  it("rejects a hard link or a non-regular file inside the attachment directory", () => {
    const file = fixture();
    const other = join(root, file.filename);
    const staged = join(file.directory, file.filename);
    linkSync(staged, other);
    expect(sentAttachmentFileAvailable(file)).toBe(false);
    expect(() => readSentAttachmentImage(file)).toThrow("session-image-unavailable");
    rmSync(staged);
    mkdirSync(staged);
    expect(sentAttachmentFileAvailable(file)).toBe(false);
    expect(() => readSentAttachmentImage(file)).toThrow("session-image-unavailable");
  });

  it("checks bytes against the digest and the declared raster MIME type", () => {
    const bytes = Buffer.alloc(24);
    const file = fixture(bytes);
    expect(sentAttachmentFileAvailable(file)).toBe(true);
    expect(() => readSentAttachmentImage(file)).toThrow("session-image-unsupported");
    expect(() => readSentAttachmentImage({ ...file, mimeType: "image/svg+xml" })).toThrow(
      "session-image-unsupported",
    );
    bytes[0] = 1;
    writeFileSync(join(file.directory, file.filename), bytes);
    expect(() => readSentAttachmentImage(file)).toThrow("session-image-changed");
  });

  it("withholds image bytes over the existing session image limit", () => {
    const file = fixture();
    const size = MAX_SESSION_IMAGE_BYTES + 1;
    truncateSync(join(file.directory, file.filename), size);
    expect(sentAttachmentFileAvailable(file)).toBe(false);
    expect(() => readSentAttachmentImage(file)).toThrow("session-image-too-large");
    expect(() => readSentAttachmentImage({ ...file, size })).toThrow("session-image-too-large");
  });
});
