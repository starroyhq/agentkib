import type { ChildProcess } from "node:child_process";
import { nativeBindings } from "./native-files";

type Identity = { pid: number; seconds: bigint; micros: bigint };
type ProcessInfo = { identity: Identity; parent: number; status: number };
const BSD_INFO_SIZE = 136;
const MAX_PROCESSES = 4096;
const SZOMB = 5;
const SSTOP = 4;

let api:
  | {
      info: (pid: number, flavor: number, arg: bigint, buffer: Buffer, size: number) => number;
      children: (pid: number, buffer: Buffer, size: number) => number;
      errno: () => number;
      clearErrno: () => void;
    }
  | undefined;

function procApi() {
  if (api) return api;
  const ffi = nativeBindings();
  const proc = ffi.load("/usr/lib/libproc.dylib");
  const system = ffi.load("/usr/lib/libSystem.B.dylib");
  const errnoPointer = system.func("int *__error()");
  const errnoAddress = errnoPointer();
  api = {
    info: proc.func(
      "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
    ),
    children: proc.func("int proc_listchildpids(int ppid, void *buffer, int buffersize)"),
    errno: () => ffi.decode(errnoAddress, "int"),
    clearErrno: () => ffi.encode(errnoAddress, "int", 0),
  };
  return api;
}

function info(pid: number): ProcessInfo | null {
  const native = procApi();
  const bytes = Buffer.alloc(BSD_INFO_SIZE);
  native.clearErrno();
  const count = native.info(pid, 3, 0n, bytes, bytes.length);
  if (count === 0 && native.errno() === 3) return null; // ESRCH
  if (count !== BSD_INFO_SIZE) throw new Error("incomplete process identity");
  const foundPid = bytes.readUInt32LE(12);
  const parent = bytes.readUInt32LE(16);
  const status = bytes.readUInt32LE(4);
  const seconds = bytes.readBigUInt64LE(120);
  const micros = bytes.readBigUInt64LE(128);
  if (foundPid !== pid || seconds === 0n || micros >= 1_000_000n)
    throw new Error("invalid process identity");
  return {
    identity: { pid: foundPid, seconds, micros },
    parent,
    status,
  };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.pid === right.pid && left.seconds === right.seconds && left.micros === right.micros;
}

function alive(identity: Identity): boolean {
  const current = info(identity.pid);
  return current !== null && sameIdentity(current.identity, identity) && current.status !== SZOMB;
}

function children(pid: number): number[] {
  const native = procApi();
  let capacity = 32;
  for (;;) {
    const buffer = Buffer.alloc(capacity * 4);
    native.clearErrno();
    const count = native.children(pid, buffer, buffer.length);
    const error = native.errno();
    if (count < 0 || (count === 0 && error !== 0))
      throw new Error(`process child enumeration failed (${error || "unknown"})`);
    if (count < capacity) {
      const result = Array.from({ length: count }, (_, index) => buffer.readInt32LE(index * 4));
      if (result.some((child) => child <= 1)) throw new Error("invalid child PID");
      return result;
    }
    if (capacity >= MAX_PROCESSES) throw new Error("process tree exceeds cleanup capacity");
    capacity *= 2;
  }
}

function signal(identity: Identity, name: NodeJS.Signals): void {
  if (!alive(identity)) return;
  try {
    process.kill(identity.pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Captures descendants by kernel birth identity and confirms termination, including detached children. */
export class MacOwnedProcessTree {
  readonly #root: Identity;
  readonly #known = new Map<number, Identity>();

  private constructor(root: Identity) {
    this.#root = root;
    this.#known.set(root.pid, root);
  }

  static attach(child: ChildProcess): MacOwnedProcessTree {
    if (!child.pid) throw new Error("owned process has no PID");
    const root = info(child.pid);
    if (!root) throw new Error("owned root disappeared");
    return new MacOwnedProcessTree(root.identity);
  }

  rootRunning(): boolean {
    return alive(this.#root);
  }

  refresh(): void {
    if (!alive(this.#root)) throw new Error("owned root exited before complete capture");
    const queue = [this.#root];
    const visited = new Set<number>();
    for (let offset = 0; offset < queue.length; offset++) {
      const parent = queue[offset]!;
      if (!alive(parent)) throw new Error("owned parent exited during capture");
      for (const pid of children(parent.pid)) {
        const child = info(pid);
        if (!child) throw new Error("child vanished during ownership capture");
        if (child.parent !== parent.pid || !alive(parent))
          throw new Error("process parent changed during capture");
        const old = this.#known.get(pid);
        if (old && !sameIdentity(old, child.identity)) throw new Error("child PID reused");
        this.#known.set(pid, child.identity);
        if (!visited.has(pid)) {
          visited.add(pid);
          queue.push(child.identity);
        }
        if (queue.length > MAX_PROCESSES) throw new Error("process tree exceeds cleanup capacity");
      }
    }
  }

  async terminate(child: ChildProcess): Promise<void> {
    let failure: unknown;
    try {
      this.#freeze();
    } catch (error) {
      failure = error;
    }
    for (const identity of this.#known.values()) {
      if (identity.pid === this.#root.pid) continue;
      try {
        signal(identity, "SIGKILL");
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      signal(this.#root, "SIGKILL");
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.#confirmExit(child, Date.now() + 2000);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  #freeze(): void {
    if (!alive(this.#root)) throw new Error("owned root exited before frozen capture");
    const queue = [
      this.#root,
      ...[...this.#known.values()].filter((item) => item.pid !== this.#root.pid),
    ];
    const deadline = Date.now() + 2000;
    const frozen = new Set<number>();
    for (let offset = 0; offset < queue.length; offset++) {
      if (Date.now() >= deadline) throw new Error("process tree freeze deadline exceeded");
      const parent = queue[offset]!;
      if (frozen.has(parent.pid)) continue;
      if (!alive(parent)) throw new Error("owned parent exited before frozen capture");
      signal(parent, "SIGSTOP");
      const localDeadline = Math.min(deadline, Date.now() + 300);
      for (;;) {
        const current = info(parent.pid);
        if (!current) throw new Error("process disappeared before freeze");
        if (!sameIdentity(current.identity, parent))
          throw new Error("process identity changed before freeze");
        if (current.status === SSTOP) break;
        if (current.status === SZOMB || Date.now() >= localDeadline)
          throw new Error("process freeze unconfirmed");
        sleepSync(5);
      }
      frozen.add(parent.pid);
      for (const pid of children(parent.pid)) {
        const child = info(pid);
        if (!child) throw new Error("child vanished during frozen capture");
        if (child.parent !== parent.pid) throw new Error("child ownership changed");
        const previous = this.#known.get(pid);
        if (previous && !sameIdentity(previous, child.identity))
          throw new Error("child PID reused");
        this.#known.set(pid, child.identity);
        if (!frozen.has(pid)) queue.push(child.identity);
        if (this.#known.size > MAX_PROCESSES || queue.length > MAX_PROCESSES * 2)
          throw new Error("process tree exceeds cleanup capacity");
      }
    }
  }

  async #confirmExit(child: ChildProcess, deadline: number): Promise<void> {
    let failure: unknown;
    for (;;) {
      let any = false;
      for (const identity of this.#known.values()) {
        try {
          if (alive(identity)) any = true;
        } catch (error) {
          failure ??= error;
          any = true;
        }
      }
      const reaped = child.exitCode !== null || child.signalCode !== null;
      if (!any && reaped) break;
      if (Date.now() >= deadline) {
        failure ??= new Error(
          reaped ? "owned process exit unconfirmed" : "owned root exit unconfirmed",
        );
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (failure) throw failure;
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
