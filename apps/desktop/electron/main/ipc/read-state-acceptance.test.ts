// @vitest-environment node
import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { createReadStateAcceptance, desktopReadStateAcceptance } from "./read-state-acceptance";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("packaged read-state acceptance capture", () => {
  it("requires opt-in and the launcher's isolated paths", () => {
    expect(desktopReadStateAcceptance({})).toBeUndefined();
    expect(() =>
      desktopReadStateAcceptance({ AGENTKIB_DESKTOP_ACCEPTANCE_READ_STATE: "1" }),
    ).toThrow();
  });

  it("includes a duplicate confirmation and trailing GET before their diagnostics are written", async () => {
    const sender = {} as WebContents;
    const capture = createReadStateAcceptance();
    const dispatch = async () => ({ status: 200, body: {} });
    const control = (action: string) =>
      capture(sender, "/__acceptance/read-state", { action, sessionId: "session" }, dispatch);
    const confirmation = { sessionId: "session", seenResultId: "round-result" };
    const response = await dispatch();
    const lateReply = deferred<typeof response>();
    const traceWrite = deferred<void>();
    const diagnostics = ["first-confirmation"];
    const lateRequest = (entry: string) => async () => {
      const reply = await lateReply.promise;
      void traceWrite.promise.then(() => diagnostics.push(entry));
      return reply;
    };

    await control("start");
    const confirmed = control("confirmed");
    await capture(sender, "read-state", confirmation, dispatch);
    await confirmed;
    const duplicate = capture(sender, "read-state", confirmation, lateRequest("duplicate"));
    const trailingRead = capture(
      sender,
      "/read-state?sessionId=session",
      undefined,
      lateRequest("trailing-read"),
    );
    await capture(sender, "read-state?sessionId=other", undefined, dispatch);
    const finished = control("finish");
    lateReply.resolve(response);
    await Promise.all([duplicate, trailingRead]);
    expect(await finished).toEqual({
      status: 200,
      body: { reads: 1, confirmations: 2, rateLimited: 0, confirmedResultId: "round-result" },
    });
    expect(diagnostics).toEqual(["first-confirmation"]);

    await control("start");
    traceWrite.resolve();
    expect(await control("finish")).toEqual({
      status: 200,
      body: { reads: 0, confirmations: 0, rateLimited: 0, confirmedResultId: null },
    });
    expect(diagnostics).toEqual(["first-confirmation", "duplicate", "trailing-read"]);
  });
});
