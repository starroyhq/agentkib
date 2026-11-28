import {
  REMOTE_FEATURE_VERSIONS,
  REMOTE_NOTIFICATION_POLICY_CONTRACT,
  REMOTE_REQUEST_PATH,
} from "@agentkib/runtime-protocol";

export interface AccessOptions {
  pushPolicyVersion?: typeof REMOTE_FEATURE_VERSIONS.pushPolicyVersion;
}

export function accessRequestPath(options?: AccessOptions): string {
  const version = options?.pushPolicyVersion;
  if (version === undefined) return REMOTE_REQUEST_PATH.access;
  return `${REMOTE_REQUEST_PATH.access}?${REMOTE_NOTIFICATION_POLICY_CONTRACT.requestVersionQuery}=${version}`;
}
