/** Redacts authorization values from URLs, headers, and diagnostic response text. */
export function redactAuthorization(text: string): string {
  return text
    .replace(/\b(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/([?&]Authentication=)[^&\s]*/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*[:=]\s*)\S+(?:\s+\S+)?/gi, "$1[REDACTED]");
}
