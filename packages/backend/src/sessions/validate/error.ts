export class ControlValidationError extends Error {
  constructor(
    readonly status: 400 | 403 | 409,
    code: string,
  ) {
    super(code);
  }
}
