export class TwoFiatError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "TwoFiatError";
    this.status = status;
  }
}

/** The token was rejected, or the exchange didn't yield a session cookie. */
export class TwoFiatAuthError extends TwoFiatError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "TwoFiatAuthError";
  }
}

/** A response didn't match the shape we rely on — 2fiat probably changed their API. */
export class TwoFiatSchemaError extends TwoFiatError {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`unexpected response shape from ${path}`, undefined, { cause });
    this.name = "TwoFiatSchemaError";
    this.path = path;
  }
}
