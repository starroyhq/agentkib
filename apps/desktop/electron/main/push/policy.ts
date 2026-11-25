import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { NotificationPolicy } from "@agentkib/runtime-protocol";
import type { PushAlertKind } from "./notifier";

export type { NotificationPolicy, NotificationPolicyPatch } from "@agentkib/runtime-protocol";

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
const policySchema = z.strictObject({
  enabled: z.boolean(),
  categories,
  onlyAway: z.boolean(),
  quietHours: quietHours.nullable(),
});
const patchSchema = policySchema.partial().extend({ categories: categories.partial().optional() });
const storedSchema = z.strictObject({ version: z.literal(1), policy: policySchema });

export type NotificationDelivery = "send" | "hold" | "drop";

const defaults: NotificationPolicy = {
  enabled: true,
  categories: { approval: true, question: true, completed: true, failed: true },
  onlyAway: true,
  quietHours: null,
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

  read(): NotificationPolicy {
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

  update(input: unknown, authorize: () => void | Promise<void>): Promise<NotificationPolicy> {
    const patch = patchSchema.safeParse(input);
    if (!patch.success) return Promise.reject(new Error("invalid_notification_policy"));
    const write = this.#writeQueue.then(async () => {
      await this.initialize();
      const current = this.#policy;
      const next: NotificationPolicy = {
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
      };
      await this.#save(next, authorize);
      this.#policy = next;
      return this.read();
    });
    this.#writeQueue = write.catch(() => undefined);
    return write;
  }

  get #file(): string {
    return join(this.directory, "notification-policy.json");
  }

  async #load(): Promise<void> {
    try {
      const text = await readFile(this.#file, "utf8");
      this.#policy = storedSchema.parse(JSON.parse(text)).policy;
    } catch (error) {
      // A damaged policy must not silently resume notifications that the owner disabled.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#policy.enabled = false;
    }
  }

  async #save(policy: NotificationPolicy, authorize: () => void | Promise<void>): Promise<void> {
    const temporary = join(this.directory, `.notification-policy-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { mode: 0o700, recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, policy }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("notification_policy_unavailable");
    }
    try {
      await authorize();
      await rename(temporary, this.#file).catch(() => {
        throw new Error("notification_policy_unavailable");
      });
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
