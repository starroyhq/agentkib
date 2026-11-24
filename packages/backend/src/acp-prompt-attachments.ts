import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SESSION_ATTACHMENT_LIMITS,
  SESSION_ATTACHMENT_RASTER_TYPES,
  sessionAttachmentMarkdown,
} from "@agentkib/runtime-protocol";
import { z } from "zod";
import { readBytes } from "./files";
import { canonicalize } from "./paths";

export type AcpPromptAttachmentSupport = {
  image: boolean;
  embeddedContext: boolean;
  resourceLink: boolean;
};

export type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } }
  | { type: "resource_link"; uri: string; name: string; mimeType: string };

// The transport permits a 1 MiB JSON line. Keep room for base64 expansion, text and metadata.
export const ACP_INLINE_ATTACHMENT_LIMIT = 600 * 1024;

const initialization = z.object({
  agentCapabilities: z.object({
    promptCapabilities: z.record(z.string(), z.unknown()),
  }),
});
const attachmentInput = z.object({
  type: z.literal("acpAttachment"),
  id: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\x00-\x1f\\/]+$/),
  mime: z
    .string()
    .max(128)
    .regex(/^[\w.+-]+\/[\w.+-]+$/),
  size: z.number().int().positive().max(SESSION_ATTACHMENT_LIMITS.fileBytes),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
const promptInput = z
  .array(z.union([z.object({ type: z.literal("text"), text: z.string() }), attachmentInput]))
  .max(SESSION_ATTACHMENT_LIMITS.count + 1);

export function acpPromptAttachmentSupport(
  initialized: unknown,
): AcpPromptAttachmentSupport | undefined {
  const checked = initialization.safeParse(initialized);
  if (!checked.success) return undefined;
  const { promptCapabilities: prompt } = checked.data.agentCapabilities;
  return {
    image: prompt.image === true,
    embeddedContext: prompt.embeddedContext === true,
    // Resource links are part of ACP v1 baseline. A legacy runtime without prompt
    // capability evidence is excluded above, and an explicit refusal takes precedence.
    resourceLink: prompt.resourceLink !== false,
  };
}

export function acpAttachmentFeature(support?: AcpPromptAttachmentSupport) {
  const image = support?.image === true;
  const files = support?.embeddedContext === true || support?.resourceLink === true;
  return {
    available: image || files,
    ...(!(image || files) && { reason: "attachments-unsupported" }),
    attachmentKinds: { image, files },
  };
}

function hostAttachmentRoots(dataDir: string, environment: NodeJS.ProcessEnv): string[] {
  const roots = new Set([path.join(dataDir, "attachments")]);
  try {
    const configured: unknown = JSON.parse(environment.AGENTKIB_HOST_ATTACHMENTS_DIRS ?? "[]");
    if (Array.isArray(configured) && configured.length <= 4)
      for (const directory of configured)
        if (typeof directory === "string" && path.isAbsolute(directory)) roots.add(directory);
  } catch {
    // Runtime callers without a desktop host use their application data directory.
  }
  return [...roots].flatMap((directory) => {
    try {
      return [canonicalize(directory)];
    } catch {
      return [];
    }
  });
}

function readHostAttachment(
  roots: readonly string[],
  entry: z.infer<typeof attachmentInput>,
): { file: string; bytes: Buffer } {
  for (const root of roots) {
    const file = path.join(root, entry.id);
    try {
      const bytes = readBytes(file, entry.size);
      if (
        bytes.length === entry.size &&
        createHash("sha256").update(bytes).digest("hex") === entry.version
      )
        return { file, bytes };
    } catch {
      // An ID belongs to one of the trusted host stores, or has already been removed.
    }
  }
  throw new Error("attachment_changed");
}

/** Only a host-projected upload ID can open a file. The host has already checked the owner. */
export async function acpPromptInput(
  dataDir: string,
  text: string | undefined,
  input: unknown[] | undefined,
  support: AcpPromptAttachmentSupport | undefined,
  environment: NodeJS.ProcessEnv = {},
): Promise<AcpPromptBlock[]> {
  if (!input?.length) return text?.trim() ? [{ type: "text", text }] : [];
  if (!support) throw new Error("attachments-unsupported");
  const checked = promptInput.safeParse(input);
  if (!checked.success) throw new Error("invalid_attachments");
  const files = checked.data.filter((entry) => entry.type === "acpAttachment");
  if (
    !files.length ||
    files.length > SESSION_ATTACHMENT_LIMITS.count ||
    new Set(files.map(({ id }) => id)).size !== files.length
  )
    throw new Error("invalid_attachments");
  if (files.reduce((total, { size }) => total + size, 0) > SESSION_ATTACHMENT_LIMITS.messageBytes)
    throw new Error("attachments_too_large");

  const roots = hostAttachmentRoots(dataDir, environment);
  const blocks: AcpPromptBlock[] = [];
  let inlineBytes = 0;
  for (const entry of checked.data) {
    if (entry.type === "text") {
      if (entry.text.trim()) blocks.push(entry);
      continue;
    }
    const { file, bytes } = readHostAttachment(roots, entry);

    const inline = inlineBytes + bytes.length <= ACP_INLINE_ATTACHMENT_LIMIT;
    const nativeImage = support.image && SESSION_ATTACHMENT_RASTER_TYPES.includes(entry.mime);
    if (nativeImage && inline) {
      inlineBytes += bytes.length;
      blocks.push({ type: "image", mimeType: entry.mime, data: bytes.toString("base64") });
      continue;
    }

    const uri = pathToFileURL(file).href;
    if (support.embeddedContext && inline) {
      inlineBytes += bytes.length;
      blocks.push({
        type: "resource",
        resource: { uri, mimeType: entry.mime, blob: bytes.toString("base64") },
      });
    } else if (support.resourceLink) {
      blocks.push({ type: "resource_link", uri, mimeType: entry.mime, name: entry.name });
    } else {
      throw new Error(
        nativeImage || support.embeddedContext
          ? "attachments_too_large"
          : "attachments-unsupported",
      );
    }
    blocks.push({ type: "text", text: sessionAttachmentMarkdown(entry.name, uri) });
  }
  return blocks;
}
