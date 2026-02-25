const CONTROL_CHAR_REGEX = /[\r\n\t]/;
const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

export function sanitizeNextPath(next: string | null | undefined, fallback = "/"): string {
  const value = (next ?? "").trim();
  if (!value) {
    return fallback;
  }

  // Only allow in-app absolute paths like "/datasets" and reject protocol-relative/absolute URLs.
  if (!value.startsWith("/") || value.startsWith("//") || SCHEME_REGEX.test(value) || CONTROL_CHAR_REGEX.test(value)) {
    return fallback;
  }

  return value;
}
