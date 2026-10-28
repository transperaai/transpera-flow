/** A failure the caller can act on (bad input, nothing visible, ambiguous name, a write refused). */
export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly candidates?: unknown[],
  ) {
    super(message);
  }
}
