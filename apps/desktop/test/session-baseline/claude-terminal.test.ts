// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readControlReceipt } from "../../../../packages/backend/src/control-receipt";
import {
  claimManagedCommand,
  finishManagedCommand,
} from "../../../../packages/backend/src/managed-ledger";
import { createClaudeBridgeFixture } from "../fixtures/claude-bridge";

const cleanups: Array<() => Promise<void>> = [];
const fixture = createClaudeBridgeFixture(cleanups);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(process.platform === "win32")(
  "Claude terminal receipt baseline through the plugin socket",
  () => {
    it.each(["0.4.0", "0.5.4"])(
      "retains delivery and device semantics with plugin %s",
      async (pluginVersion) => {
        const f = await fixture(5_000, undefined, undefined, undefined, pluginVersion);
        const input = f.control("send", { publicInputHash: "a".repeat(64) });
        const receipt = (deviceId = input.deviceId) =>
          f.bridge.receipt(
            readControlReceipt(f.options.dataDir, { requestId: input.requestId, deviceId }),
          );
        const first = f.bridge.request(input);
        // The result is awaited after the plugin responds. Register the handler while it is pending.
        void first.catch(() => undefined);
        const row = {
          found: true,
          requestId: input.requestId,
          sessionId: input.sessionId,
          workspaceId: f.target.workspaceId,
          operation: "send",
          executionMode: "claude-follower",
          runtimeBootId: input.runtimeBootId,
          expectedRevision: input.expectedRevision,
          turnId: null,
          publicInputHash: "a".repeat(64),
          completionObserved: false,
        };
        const unknown = {
          accepted: false,
          completed: false,
          requestId: input.requestId,
          controlOutcome: "unknown",
        };

        // A claimed command can still be delivered by the plugin poll below.
        expect(receipt()).toEqual({ ...row, status: "unknown", ack: null });
        await expect(f.bridge.request(input)).resolves.toEqual({
          ...unknown,
          reason: "request-interrupted",
        });

        const delivered = await f.poll();
        expect(delivered).toMatchObject({
          status: 200,
          body: {
            commands: [
              {
                commandId: expect.any(String),
                kind: "send",
                requestId: input.requestId,
                text: input.text,
                expectedRevision: f.snapshot.revision,
              },
            ],
          },
        });
        const [{ commandId }] = delivered.body.commands;
        expect(receipt()).toEqual({ ...row, status: "unknown", ack: null });
        await expect(f.bridge.request(input)).resolves.toEqual({
          ...unknown,
          reason: "control-outcome-unconfirmed",
        });
        const other = "browser-b";
        expect(receipt(other)).toEqual({ found: false, requestId: input.requestId });
        for (const altered of [{ text: "other input" }, { deviceId: other }]) {
          await expect(f.bridge.request({ ...input, ...altered })).rejects.toThrow(
            "request-id-reused-with-different-input",
          );
        }
        expect((await f.poll()).body.commands).toEqual([]);

        const turnId = randomUUID();
        expect((await f.events({ type: "turn-start", turnId, revision: 1 })).status).toBe(200);
        const answer = { commandId, status: "accepted", revision: 1, turnId };
        expect(await f.post("/v1/results", answer)).toEqual({ status: 200, body: { ok: true } });
        const ack = (await first) as Record<string, unknown>;
        expect(ack).toMatchObject({
          accepted: true,
          completed: false,
          requestId: input.requestId,
          sessionId: input.sessionId,
          runtimeBootId: input.runtimeBootId,
          controlOutcome: "accepted",
        });
        await expect(f.bridge.request(input)).resolves.toEqual(ack);
        expect(receipt()).toEqual({ ...row, status: "accepted", ack });

        // A repeated plugin ACK refreshes the live projection after the pending slot is cleared.
        const recovered = { ...ack, live: f.live() };
        expect(await f.post("/v1/results", answer)).toEqual({ status: 200, body: { ok: true } });
        expect(receipt()).toEqual({ ...row, status: "accepted", ack: recovered });
        await expect(f.bridge.request(input)).resolves.toEqual(recovered);
        expect((await f.poll()).body.commands).toEqual([]);
      },
    );

    it("replays a completed acknowledgment across restart with either boot ID", async () => {
      const f = await fixture(5_000, undefined, undefined, undefined, "0.5.4");
      const input = f.control();
      const first = f.bridge.request(input);
      void first.catch(() => undefined);
      const [{ commandId }] = (await f.poll()).body.commands;
      const turnId = randomUUID();
      expect((await f.events({ type: "turn-start", turnId, revision: 1 })).status).toBe(200);
      expect(
        await f.post("/v1/results", { commandId, status: "accepted", revision: 1, turnId }),
      ).toEqual({ status: 200, body: { ok: true } });
      await first;
      expect(
        (
          await f.events({
            type: "turn-complete",
            turnId,
            revision: 2,
            text: "terminal reply",
            aborted: false,
          })
        ).status,
      ).toBe(200);

      const receipt = () =>
        f.bridge.receipt(
          readControlReceipt(f.options.dataDir, {
            requestId: input.requestId,
            deviceId: input.deviceId,
          }),
        );
      const original = receipt();
      const settled = await f.bridge.request(input);
      expect(original).toMatchObject({
        found: true,
        status: "accepted",
        completionObserved: true,
        ack: settled,
      });
      expect(settled).toMatchObject({
        accepted: true,
        completed: true,
        runtimeBootId: input.runtimeBootId,
      });

      const newBootId = randomUUID();
      await f.restart(true, newBootId);
      expect(
        (await f.events({ type: "snapshot", snapshot: { ...f.snapshot, revision: 2 } })).status,
      ).toBe(200);
      expect(f.live().runtimeBootId).toBe(newBootId);
      expect(receipt()).toEqual(original);
      await expect(f.bridge.request(input)).resolves.toEqual(settled);
      await expect(f.bridge.request({ ...input, runtimeBootId: newBootId })).resolves.toEqual(
        settled,
      );
      await expect(f.bridge.request({ ...input, requestId: randomUUID() })).rejects.toThrow(
        "control-unavailable",
      );
      expect((await f.poll()).body.commands).toEqual([]);
    });

    it("replays a receipt written with the old locale-ordered fingerprint", async () => {
      const f = await fixture(5_000, undefined, undefined, undefined, "0.5.4");
      const input = { ...f.control(), input: { B: "B", a: "A" } };
      // The old terminal input ignores undefined fields and the boot ID, placing a before B.
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            deviceId: input.deviceId,
            expectedRevision: input.expectedRevision,
            experimentalEnabled: input.experimentalEnabled,
            input: { a: "A", B: "B" },
            operation: input.operation,
            requestId: input.requestId,
            sessionId: input.sessionId,
            text: input.text,
          }),
        )
        .digest("hex");
      const ack = {
        accepted: true,
        completed: false,
        requestId: input.requestId,
        sessionId: input.sessionId,
        runtimeBootId: "previous-backend",
        controlOutcome: "accepted",
      };
      expect(
        claimManagedCommand(
          f.options.dataDir,
          input.requestId,
          input.sessionId,
          fingerprint,
          input.deviceId,
          {
            operation: "send",
            workspaceId: f.target.workspaceId,
            executionMode: "claude-follower",
            runtimeBootId: ack.runtimeBootId,
          },
        ),
      ).toBeNull();
      finishManagedCommand(f.options.dataDir, input.requestId, ack);

      await expect(f.bridge.request({ ...input, turnId: undefined })).resolves.toEqual(ack);
      expect(
        f.bridge.receipt(
          readControlReceipt(f.options.dataDir, {
            requestId: input.requestId,
            deviceId: input.deviceId,
          }),
        ),
      ).toMatchObject({ status: "accepted", completionObserved: false, ack });
      expect((await f.poll()).body.commands).toEqual([]);
    });
  },
);
