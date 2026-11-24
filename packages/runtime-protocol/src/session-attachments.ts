export const SESSION_ATTACHMENT_LIMITS = {
  count: 10,
  fileBytes: 25 * 1024 * 1024,
  messageBytes: 100 * 1024 * 1024,
} as const;

export const SESSION_ATTACHMENT_RASTER_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export type SessionAttachmentKinds = { image: boolean; files: boolean };

/** Keep the historical attachment marker used by queue editing and DSH command detection. */
export function sessionAttachmentMarkdown(name: string, fileUrl: string): string {
  const label = name.replace(/[\\[\]]/g, "\\$&");
  const destination = fileUrl.replace(/[()]/g, (character) => (character === "(" ? "%28" : "%29"));
  return "User attached file [" + label + "](" + destination + ")";
}
