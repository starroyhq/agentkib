import { assertPrivateRuntimePath } from "@agentkib/backend/local-runtime-ipc";
import { constants } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Write revocations to the existing snapshot when staging or replacing it fails. */
export async function writeWebAccessSnapshot(
  directory: string,
  contents: string,
  revoking: boolean,
) {
  const file = join(directory, "web-access.json");
  try {
    await writeFile(`${file}.tmp`, contents, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return;
  } catch (error) {
    if (!revoking) throw error;
  }

  const parent = assertPrivateRuntimePath(directory, "directory", false);
  const existing = assertPrivateRuntimePath(file, "file", false);
  if ((process.getuid && (parent.mode & 0o022) !== 0) || existing.nlink !== 1)
    throw new Error("Unsafe Web access snapshot");
  const handle = await open(
    file,
    constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== existing.dev ||
      opened.ino !== existing.ino ||
      opened.uid !== existing.uid
    )
      throw new Error("Unsafe Web access snapshot");

    // An interrupted rewrite must leave invalid JSON instead of reviving a saved credential.
    await handle.truncate(0);
    await handle.sync();
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
