import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { canonicalize } from "../../paths";
import { SESSION_LOG_BLOCK_BYTES } from "../../session-log-reader";

const CONTROL_TRANSCRIPT_LIMIT = 128n * 1024n * 1024n;
type ClaudeTranscriptProof = {
  key: string;
  transcript: string;
  metadata: BigIntStats;
  hash: Hash;
  fingerprint: string;
};

export function sameClaudeTranscript(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Only for mutation admission. History and live display do not need a full-content proof. */
export class ClaudeTranscriptProofs {
  #proofs = new Map<string, ClaudeTranscriptProof>();

  constructor(readonly verifiedTarget: (nativeId: string, workspace: string) => string) {}

  remember(proof: ClaudeTranscriptProof): void {
    this.#proofs.delete(proof.key);
    this.#proofs.set(proof.key, proof);
    if (this.#proofs.size > 32) this.#proofs.delete(this.#proofs.keys().next().value!);
  }

  /** Resuming needs a verified native identity. A large log's content is not a rename proof. */
  resume(nativeId: string, workspace: string): { version: string; fingerprint: string | null } {
    const transcript = this.verifiedTarget(nativeId, workspace);
    const metadata = lstatSync(transcript, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("invalid-Claude-transcript");
    const fingerprint =
      metadata.size <= CONTROL_TRANSCRIPT_LIMIT
        ? this.#read(nativeId, workspace, transcript, metadata).fingerprint
        : null;
    if (!sameClaudeTranscript(metadata, lstatSync(transcript, { bigint: true })))
      throw new Error("Claude history changed during verification");
    const version = [
      transcript,
      metadata.dev,
      metadata.ino,
      metadata.birthtimeNs,
      metadata.size,
      metadata.mtimeNs,
      metadata.ctimeNs,
    ].join("\0");
    return { version, fingerprint };
  }

  read(nativeId: string, workspace: string): ClaudeTranscriptProof {
    const transcript = this.verifiedTarget(nativeId, workspace);
    const expected = lstatSync(transcript, { bigint: true });
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size > CONTROL_TRANSCRIPT_LIMIT)
      throw new Error("invalid-Claude-transcript");
    return this.#read(nativeId, workspace, transcript, expected);
  }

  /** A large transcript can have a local title without a proof for a native write. */
  readForRename(nativeId: string, workspace: string): ClaudeTranscriptProof | null {
    const transcript = this.verifiedTarget(nativeId, workspace);
    const expected = lstatSync(transcript, { bigint: true });
    if (!expected.isFile() || expected.nlink !== 1n) throw new Error("invalid-Claude-transcript");
    return expected.size > CONTROL_TRANSCRIPT_LIMIT
      ? null
      : this.#read(nativeId, workspace, transcript, expected);
  }

  #read(nativeId: string, workspace: string, transcript: string, expected: BigIntStats) {
    const source = JSON.stringify([nativeId.toLowerCase(), canonicalize(workspace)]);
    const key = `${transcript}\0${source}`;
    const cached = this.#proofs.get(key);
    if (cached && sameClaudeTranscript(cached.metadata, expected)) return cached;
    const fd = openSync(transcript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!sameClaudeTranscript(expected, before)) throw new Error("invalid-Claude-transcript");
      // The persisted content digest is a mutation identity proof. Hash in place
      // and retain only the digest state, never the full verified source.
      const hash = createHash("sha256").update(source);
      const buffer = Buffer.allocUnsafe(SESSION_LOG_BLOCK_BYTES);
      for (let remaining = Number(before.size); remaining > 0;) {
        const count = readSync(fd, buffer, 0, Math.min(remaining, buffer.length), null);
        if (!count) throw new Error("Claude history changed during verification");
        hash.update(buffer.subarray(0, count));
        remaining -= count;
      }
      const current = lstatSync(transcript, { bigint: true });
      if (!sameClaudeTranscript(before, current))
        throw new Error("Claude history changed during verification");
      if (this.verifiedTarget(nativeId, workspace) !== transcript)
        throw new Error("Claude transcript target changed during verification");
      const proof = {
        key,
        transcript,
        metadata: before,
        hash,
        fingerprint: hash.copy().digest("hex"),
      };
      this.remember(proof);
      return proof;
    } finally {
      closeSync(fd);
    }
  }
}
