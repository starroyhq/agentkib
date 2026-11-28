import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  REMOTE_FEATURE_VERSIONS,
  REMOTE_NOTIFICATION_POLICY_CONTRACT,
  type NotificationPolicy,
} from "@agentkib/runtime-protocol";
import type { PushAlertKind } from "./notifier";

export type { NotificationPolicy, NotificationPolicyPatch } from "@agentkib/runtime-protocol";

export function notificationPolicyVersion(url: URL) {
  const { legacyVersion, requestVersionQuery } = REMOTE_NOTIFICATION_POLICY_CONTRACT;
  const current = REMOTE_FEATURE_VERSIONS.pushPolicyVersion;
  // Existing clients enable the policy settings only when the host advertises version 1.
  return url.searchParams.get(requestVersionQuery) === String(current) ? current : legacyVersion;
}

const localTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const quietHours = z
  .strictObject({ start: localTime, end: localTime })
  .refine(({ start, end }) => start !== end);
const categories = z.strictObject({
  approval: z.boolean(),
  question: z.boolean(),
  completed: z.boolean(),
  failed: z.boolean(),
});
const basePolicySchema = z.strictObject({
  enabled: z.boolean(),
  categories,
  onlyAway: z.boolean(),
  quietHours: quietHours.nullable(),
});
const policySchema = basePolicySchema.extend({ workerResults: z.boolean() });
const patchSchema = policySchema.partial().extend({ categories: categories.partial().optional() });
// Preserve the legacy disk shape for desktop versions that strictly validate the original policy.
const storedSchema = z.strictObject({ version: z.literal(1), policy: basePolicySchema });
const workerResultsSchema = z.strictObject({
  version: z.literal(1),
  workerResults: z.boolean(),
});

export type NotificationDelivery = "send" | "hold" | "drop";

type LocalNotificationPolicy = Required<NotificationPolicy>;

const defaults: LocalNotificationPolicy = {
  enabled: true,
  categories: { approval: true, question: true, completed: true, failed: true },
  onlyAway: true,
  quietHours: null,
  workerResults: REMOTE_NOTIFICATION_POLICY_CONTRACT.workerResults.default,
};

function withinQuietHours(hours: NonNullable<NotificationPolicy["quietHours"]>, at: number) {
  const date = new Date(at);
  const time = [date.getHours(), date.getMinutes()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  const { start, end } = hours;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function notificationDelivery(
  policy: NotificationPolicy,
  kind: PushAlertKind,
  present: boolean,
  at: number,
): NotificationDelivery {
  const category = kind === "verify" || kind === "delegation" ? "question" : kind;
  if (!policy.enabled || !policy.categories[category]) return "drop";
  if (
    (policy.onlyAway && present) ||
    (policy.quietHours && withinQuietHours(policy.quietHours, at))
  )
    return "hold";
  return "send";
}

/** One host's delivery settings, shared by its desktop and paired device routes. */
export class NotificationPolicyStore {
  #policy = structuredClone(defaults);
  #initialized?: Promise<void>;
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  initialize(): Promise<void> {
    return (this.#initialized ??= this.#load());
  }

  read(): LocalNotificationPolicy {
    return structuredClone(this.#policy);
  }

  delivery(kind: PushAlertKind, present: boolean, at = Date.now()): NotificationDelivery {
    return notificationDelivery(this.#policy, kind, present, at);
  }

  /** ActivityKit starts create an alert, so opening one follows the quiet schedule. */
  allowsActivityStart(at = Date.now()): boolean {
    const { enabled, quietHours } = this.#policy;
    return enabled && (!quietHours || !withinQuietHours(quietHours, at));
  }

  update(input: unknown, authorize: () => void | Promise<void>): Promise<LocalNotificationPolicy> {
    const patch = patchSchema.safeParse(input);
    if (!patch.success) return Promise.reject(new Error("invalid_notification_policy"));
    const write = this.#writeQueue.then(async () => {
      await this.initialize();
      const current = this.#policy;
      const next: LocalNotificationPolicy = {
        enabled: patch.data.enabled ?? current.enabled,
        categories: {
          approval: patch.data.categories?.approval ?? current.categories.approval,
          question: patch.data.categories?.question ?? current.categories.question,
          completed: patch.data.categories?.completed ?? current.categories.completed,
          failed: patch.data.categories?.failed ?? current.categories.failed,
        },
        onlyAway: patch.data.onlyAway ?? current.onlyAway,
        quietHours:
          patch.data.quietHours === undefined ? current.quietHours : patch.data.quietHours,
        workerResults: patch.data.workerResults ?? current.workerResults,
      };
      const { workerResults, ...basePatch } = patch.data;
      await this.#save(
        next,
        { base: workerResults === undefined || Object.keys(basePatch).length > 0, workerResults },
        authorize,
      );
      this.#policy = next;
      return this.read();
    });
    this.#writeQueue = write.catch(() => undefined);
    return write;
  }

  get #file(): string {
    return join(this.directory, "notification-policy.json");
  }

  get #workerResultsFile(): string {
    return join(this.directory, "notification-worker-results.json");
  }

  async #load(): Promise<void> {
    try {
      const text = await readFile(this.#file, "utf8");
      this.#policy = { ...this.#policy, ...storedSchema.parse(JSON.parse(text)).policy };
    } catch (error) {
      // A damaged policy must not silently resume notifications that the owner disabled.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#policy.enabled = false;
    }
    try {
      const text = await readFile(this.#workerResultsFile, "utf8");
      this.#policy.workerResults = workerResultsSchema.parse(JSON.parse(text)).workerResults;
    } catch {
      // The optional Worker result setting defaults off independently of the base policy.
    }
  }

  async #save(
    policy: LocalNotificationPolicy,
    patch: { base: boolean; workerResults: boolean | undefined },
    authorize: () => void | Promise<void>,
  ): Promise<void> {
    const staged: string[] = [];
    const stage = async (data: string | Buffer) => {
      const file = join(this.directory, `.notification-policy-${randomUUID()}.tmp`);
      staged.push(file);
      await writeFile(file, data, { flag: "wx", mode: 0o600 });
      return file;
    };
    const commit = (temporary: string, file: string) =>
      rename(temporary, file).catch(() => {
        throw new Error("notification_policy_unavailable");
      });
    try {
      let workerFile: string | undefined;
      let baseFile: string | undefined;
      let previousWorkerFile: string | undefined;
      try {
        await mkdir(this.directory, { mode: 0o700, recursive: true });
        const { workerResults, ...base } = policy;
        if (patch.base) baseFile = await stage(JSON.stringify({ version: 1, policy: base }));
        if (patch.workerResults !== undefined)
          workerFile = await stage(JSON.stringify({ version: 1, workerResults }));
        if (workerFile && baseFile) {
          const previous = await readFile(this.#workerResultsFile).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return undefined;
          });
          if (previous) previousWorkerFile = await stage(previous);
        }
      } catch {
        throw new Error("notification_policy_unavailable");
      }
      await authorize();
      if (workerFile) await commit(workerFile, this.#workerResultsFile);
      if (baseFile) {
        try {
          if (workerFile) await authorize();
          await commit(baseFile, this.#file);
        } catch (error) {
          // A failed mixed update must leave the earlier Worker setting in effect.
          if (workerFile) {
            if (previousWorkerFile) await commit(previousWorkerFile, this.#workerResultsFile);
            else
              await rm(this.#workerResultsFile, { force: true }).catch(() => {
                throw new Error("notification_policy_unavailable");
              });
          }
          throw error;
        }
      }
    } finally {
      await Promise.all(staged.map((file) => rm(file, { force: true }).catch(() => undefined)));
    }
  }
}
