export class ExternalRelayError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly retryAfterSeconds: number | null = null,
    readonly payload?: unknown,
  ) {
    super(code);
  }
}
