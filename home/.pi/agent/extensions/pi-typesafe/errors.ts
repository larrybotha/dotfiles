export type IntegrationErrorCode = "configuration" | "validation" | "budget" | "aborted" | "timeout" | "connection" | "response";

/** Safe to display: never contains upstream bodies, headers, keys, or submitted state. */
export class TypeSafeIntegrationError extends Error {
  override readonly name = "TypeSafeIntegrationError";
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Normalize anything thrown or returned by a failed judgment into a display-safe error. The core classifier never
 * rejects, so this mostly passes the extension's own errors through and maps a stray abort/timeout into a code.
 */
export function safeError(error: unknown): TypeSafeIntegrationError {
  if (error instanceof TypeSafeIntegrationError) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new TypeSafeIntegrationError("aborted", "TypeSafe request cancelled before a judgment was returned.");
  }
  return new TypeSafeIntegrationError("response", "TypeSafe returned an unreadable or unexpected response.");
}
