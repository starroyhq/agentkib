import type { RemoteErrorCode } from "@agentkib/runtime-protocol";

export class ControlValidationError extends Error {
  declare readonly message: RemoteErrorCode;

  constructor(
    readonly status: 400 | 403 | 409,
    code: RemoteErrorCode,
  ) {
    super(code);
  }
}
