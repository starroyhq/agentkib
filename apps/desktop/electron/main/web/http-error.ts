import type { RemoteErrorCode } from "@agentkib/runtime-protocol";

export class HttpError extends Error {
  static fromContract(
    { code, http }: { code: RemoteErrorCode; http: { status: number } },
    reason?: RemoteErrorCode,
  ) {
    return new HttpError(http.status, code, undefined, reason);
  }

  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
    readonly reason?: RemoteErrorCode,
  ) {
    super(message);
  }
}
