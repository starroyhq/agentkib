import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";

export const runtimeQueueFull = {
  __agentkibRuntimeAdmission: {
    code: REMOTE_ERROR_CODES.queueFull,
    stage: "not-dispatched",
  },
} as const;

export function isRuntimeQueueFullReply(value: unknown): value is typeof runtimeQueueFull {
  if (
    typeof value !== "object" ||
    value === null ||
    !("__agentkibRuntimeAdmission" in value) ||
    Object.keys(value).length !== 1
  )
    return false;
  const admission = value.__agentkibRuntimeAdmission;
  return (
    typeof admission === "object" &&
    admission !== null &&
    "code" in admission &&
    admission.code === runtimeQueueFull.__agentkibRuntimeAdmission.code &&
    "stage" in admission &&
    admission.stage === runtimeQueueFull.__agentkibRuntimeAdmission.stage
  );
}
