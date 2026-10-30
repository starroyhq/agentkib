// @vitest-environment node
import { describe, expect, it } from "vitest";
import { detectComputerName, normalizeComputerName, prettyHostname } from "./computer-name";

const fail = () => Promise.reject(new Error("unavailable"));

describe("computer name normalisation", () => {
  it("matches the broker rules: NFC, collapsed whitespace, no controls, trimmed", () => {
    expect(normalizeComputerName("  Alice’s\tMac\u0000Book\n Pro ")).toBe("Alice’s MacBook Pro");
    expect(normalizeComputerName("Cafe\u0301")).toBe("Café");
    expect(normalizeComputerName("\u202Eevil\u202C name")).toBe("evil name");
    expect(normalizeComputerName("bad\uD800half")).toBe("badhalf");
    expect(normalizeComputerName(" \u0007 ")).toBeUndefined();
    expect(normalizeComputerName(42)).toBeUndefined();
  });
  it("cuts to 64 code points without splitting a grapheme", () => {
    expect(normalizeComputerName("a".repeat(80))).toBe("a".repeat(64));
    const name = normalizeComputerName("b".repeat(63) + "👍🏽");
    expect(name).toBe("b".repeat(63));
    expect([...normalizeComputerName("x ".repeat(40))!].length).toBeLessThanOrEqual(64);
  });
});

describe("computer name detection", () => {
  it("macOS uses scutil ComputerName, then the hostname without .local", async () => {
    const calls: string[][] = [];
    expect(
      await detectComputerName({
        platform: "darwin",
        run: async (command, args) => {
          calls.push([command, ...args]);
          return "Alice’s MacBook Pro\n";
        },
        hostname: () => "ignored.local",
      }),
    ).toBe("Alice’s MacBook Pro");
    expect(calls).toEqual([["scutil", "--get", "ComputerName"]]);
    expect(
      await detectComputerName({
        platform: "darwin",
        run: fail,
        hostname: () => "alices-mbp.local",
      }),
    ).toBe("alices-mbp");
    expect(
      await detectComputerName({
        platform: "darwin",
        run: async () => "  ",
        hostname: () => "m.LOCAL",
      }),
    ).toBe("m");
  });
  it("Windows uses the hostname", async () => {
    expect(
      await detectComputerName({ platform: "win32", run: fail, hostname: () => "DESKTOP-42" }),
    ).toBe("DESKTOP-42");
  });
  it("Linux prefers PRETTY_HOSTNAME, then hostnamectl --pretty, then the hostname", async () => {
    const base = { platform: "linux" as const, hostname: () => "box" };
    expect(
      await detectComputerName({
        ...base,
        readFile: async () => 'HOSTNAME=x\nPRETTY_HOSTNAME="Bob\\"s Laptop"\n',
        run: fail,
      }),
    ).toBe('Bob"s Laptop');
    expect(
      await detectComputerName({ ...base, readFile: fail, run: async () => "Work Station\n" }),
    ).toBe("Work Station");
    expect(await detectComputerName({ ...base, readFile: fail, run: fail })).toBe("box");
  });
  it("never throws, even if the hostname fails", async () => {
    expect(
      await detectComputerName({
        platform: "freebsd",
        hostname: () => {
          throw new Error("no");
        },
      }),
    ).toBeUndefined();
  });
  it("parses machine-info quoting", () => {
    expect(prettyHostname("PRETTY_HOSTNAME='Lab PC'")).toBe("Lab PC");
    expect(prettyHostname("PRETTY_HOSTNAME=plain")).toBe("plain");
    expect(prettyHostname("ICON_NAME=computer")).toBeUndefined();
  });
});
